/**
 * @file src/chat/lane-hold.ts
 * @purpose Own one ACP lane's held connection: open/resume/replace/supersede and close. What ONE send
 *   on that connection does lives in lane-hold-send.ts — see its header for why the seam is there.
 * @size-justified: One ACP lane's connection, supersession epoch, and close lifecycle must share one state owner.
 * @exports CockpitLaneTransportInput, CockpitLaneTransport, SetLaneModeOutcome, SetLaneModelOutcome, HOLD_SUPERSEDED_REASON, CLOSE_WAIT_MS, createCockpitLaneTransport
 * @depends ../adapters/acp/acp-lane-connection, ../adapters/acp/acp-lane-session, ../adapters/acp/acp-models, ../adapters/acp/acp-permission, ../adapters/acp/acp-servers, ../adapters/agent-model-store, ./lane-carrier, ./lane-hold-mode, ./lane-hold-send, ./lane-send-outcome
 */
import {
  type OpenAcpLaneConnectionInput,
  openAcpLaneConnection,
} from "../adapters/acp/acp-lane-connection.js";
import {
  type LaneCloseResult,
  type LaneConnection,
  closeConnection,
} from "../adapters/acp/acp-lane-session.js";
import type { AcpModelList } from "../adapters/acp/acp-models.js";
import type { PermissionDecider } from "../adapters/acp/acp-permission.js";
import type { AcpAgent } from "../adapters/acp/acp-servers.js";
import { setAgentModel } from "../adapters/agent-model-store.js";
import type { CarrierTransport } from "./lane-carrier.js";
import { adoptOrApplyResumedMode, applyRestoredMode } from "./lane-hold-mode.js";
import { type Held, sendOnHold } from "./lane-hold-send.js";
import {
  type TurnTextRecorder,
  createTurnTextRecorder,
  errorMessage,
} from "./lane-send-outcome.js";

/** W4-R2c C4: the reason an older `start()` reports when the supersession guard refuses its hold. The
 *  carrier reads its OWN token rather than this string (two independent mechanisms, deliberately), so
 *  this is for humans reading a trace, not for control flow.
 *  FL-150 ROUND 2 (review P3-D): `lane-acquire.ts` compares against it too — to pick a LOG LEVEL and
 *  nothing else. A supersession is a sanctioned reconnect (lane-gate's forceFreshConnection asked for
 *  it) and is reported at info; a genuine resume failure stays at warn. Both branches run the same
 *  code and reach the same fresh create, so this is still a message for humans reading a trace, which
 *  is exactly what the sentence above reserves it for. */
export const HOLD_SUPERSEDED_REASON =
  "a newer session open superseded this one before it could be held";

export const CLOSE_WAIT_MS = 500;

export interface CockpitLaneTransportInput {
  readonly agent: AcpAgent;
  readonly cwd: string;
  /** Lifecycle owner for every bridge opened by this transport. */
  readonly signal?: AbortSignal;
  /** B1/B2 (MAX review fix round 1): the project root native-mode-store.ts persists
   *  .zer0/native-mode.json under — read at EVERY lane open/resume (not just boot) so a Shift+Tab
   *  cycle pressed before any session existed this process, or a mode restored across a
   *  kill+relaunch, is applied to the freshly opened connection before its first prompt. */
  readonly repoRoot: string;
  /** Raw session updates from the live connection (compaction detector + usage consumers). */
  readonly onSessionUpdate?: (update: unknown) => void;
  /** Decoded reply-text chunks (the cockpit accumulates per turn around its awaited send). */
  readonly onText?: (chunk: string) => void;
  /** A replaced-or-closed child that survived the full ladder (I-13: orphans are surfaced, never silent). */
  readonly onCloseOrphan?: (pid: number) => void;
  /** W4-3: this lane's operator-facing permission decider (setCarrierDecider's factory, called with
   *  `agent`). Absent -> openAcpLaneConnection's resolveDecider FAILS CLOSED (denyDecider), never
   *  auto-approve. */
  readonly decide?: PermissionDecider;
  /** Injected connection factory (tests); defaults to the real openAcpLaneConnection. Typed against the
   *  adapter's OWN input shape rather than a hand-kept copy of it — a field the real opener grows would
   *  otherwise be invisible to every fake. */
  readonly openConnection?: (
    i: OpenAcpLaneConnectionInput,
  ) => LaneConnection | Promise<LaneConnection>;
}

/** W4-1: the RESULT of a Shift+Tab mode cycle reaching this lane's live connection. "noSession" is a
 *  legitimate, expected outcome (the operator cycled a mode before ever sending a message on this
 *  engine this session) — NOT an error; the caller's state layer still records the choice locally and
 *  persists it, so it applies the moment a session opens. "failed" carries the FAILURE CONTRACT reason
 *  (a bridge rejection or a response-absence timeout) for the caller to revert + render. */
export type SetLaneModeOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "noSession" }
  | { readonly outcome: "failed"; readonly reason: string };

export type SetLaneModelOutcome = SetLaneModeOutcome;

export interface CockpitLaneTransport extends CarrierTransport {
  close(): Promise<LaneCloseResult>;
  setMode(modeId: string): Promise<SetLaneModeOutcome>;
  models(): AcpModelList | undefined;
  setModel(modelId: string): Promise<SetLaneModelOutcome>;
  /** BLOCK 3: release the held connection through the SAME close ladder a replace uses (orphans surfaced,
   *  never abandoned), so the next start() cannot take the already-held-and-alive fast path. The
   *  transport itself stays usable — this drops the CONNECTION, not the lane.
   *  FL-146: it also supersedes every open still IN FLIGHT, which is the case the operator's cancel used
   *  to miss entirely; see dropHoldState for the measurement. It never awaits the open it supersedes.
   *
   *  WHAT THE RETURNED BOOLEAN IS, EXACTLY (FL-150, review P1-B). It answers ONE question: did this
   *  cancel REACH a bridge connection — held, opening, or an open still in flight? A `false` proves it
   *  reached nothing, and the caller is expected to say so rather than let it pass for a cancel that
   *  worked. A `true` proves a CONNECTION was superseded and NOTHING MORE — in particular it does not
   *  prove the turn stopped. The turn's stop is its AbortSignal (aborted at room-engine.ts's
   *  `cancelTarget` before this is ever called) and it is enforced in lane-acquire.ts and
   *  lane-carrier.ts's `throwIfCancelledBeforeSend`. FL-146 shipped this value read as "stopped", and
   *  it returned true on the exact path that then went on to open a replacement and send. */
  dropHold(): Promise<boolean>;
}

interface LaneHoldState {
  held: Held | undefined;
  readonly opening: Set<LaneConnection>;
  readonly orphanPids: Set<number>;
  startSeq: number;
  closedThrough: number;
  /** FL-146: how many `start()` calls are in flight RIGHT NOW. `opening` cannot answer that question —
   *  a start that has spawned nothing yet (or whose opener has not returned its connection) is
   *  invisible to it, and that instant is inside the race window, not outside it. Read only to tell
   *  `dropHold`'s caller the truth about whether the cancel superseded anything; the actual
   *  supersession is done by the epoch, which needs no count. */
  pendingStarts: number;
  /** What the CURRENT turn has delivered. Lives on the transport rather than the send call because the
   *  connection captures its `onText` ONCE at open and holds that reference for its whole life — a
   *  per-send wrapper could never reach the callback the bridge is already using. Its sink forwards
   *  every chunk to `input.onText` unchanged, so the row and the classifier read one string. */
  readonly text: TurnTextRecorder;
}

type OpenLaneConnection = NonNullable<CockpitLaneTransportInput["openConnection"]>;
/**
 * Creates the per-lane transport the cockpit holds for the life of a chat mount. One instance per ACP
 * agent lane; the SAME instance serves every turn (lane-carrier calls start/send per turn, and only a
 * dead bridge or a cockpit shutdown ever touches the underlying process).
 */
export function createCockpitLaneTransport(input: CockpitLaneTransportInput): CockpitLaneTransport {
  const open = input.openConnection ?? openAcpLaneConnection;
  const state: LaneHoldState = {
    held: undefined,
    opening: new Set<LaneConnection>(),
    orphanPids: new Set<number>(),
    startSeq: 0,
    closedThrough: 0,
    pendingStarts: 0,
    text: createTurnTextRecorder(input.onText),
  };

  return {
    start: (sessionId) => {
      const epoch = ++state.startSeq;
      state.pendingStarts += 1;
      return startOrReuseHold({
        held: state.held,
        input,
        openFresh: () => openFresh(state, input, open, epoch),
        installHold: (ticket, next) => installHold(state, input, ticket, next),
        discardOpening: (conn) => discardOpening(state, input, conn),
        sessionId,
        epoch,
      }).finally(() => {
        state.pendingStarts -= 1;
      });
    },
    // BLOCK 3: sendOnHold (not sendHeld directly) — see its header for the self-heal it adds.
    send: async (prompt, sessionId) =>
      sendOnHold({
        held: state.held,
        text: state.text,
        agent: input.agent,
        ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
        dropHold: () => replaceHold(state, input, undefined),
        prompt,
        sessionId,
      }),
    setMode: async (modeId) => setModeHeld(state.held, modeId),
    models: () => state.held?.models,
    setModel: async (modelId) => setModelHeld(state.held, input.agent, modelId),
    dropHold: async () => dropHoldState(state, input),
    close: async () => closeHoldState(state, input),
  };
}

async function openFresh(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
  open: OpenLaneConnection,
  epoch: number,
): Promise<LaneConnection> {
  const opened = open({
    agent: input.agent,
    cwd: input.cwd,
    // The recorder, not `input.onText` — see LaneHoldState.text. ITEM E: bound to THIS open's epoch,
    // so a superseded or closed connection's late chunk cannot be read as the live turn's ending.
    onText: state.text.sinkFor(epoch),
    ...(input.onSessionUpdate === undefined ? {} : { onSessionUpdate: input.onSessionUpdate }),
    ...(input.decide !== undefined ? { decide: input.decide } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  // The production ACP opener returns synchronously after spawn. Register that child in this same
  // call stack so shutdown cannot snapshot an empty opening set during an avoidable promise yield.
  const conn = isPromiseLike(opened) ? await opened : opened;
  state.opening.add(conn);
  if (epoch > state.closedThrough) return conn;
  await discardOpening(state, input, conn);
  throw new Error(HOLD_SUPERSEDED_REASON);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { readonly then?: unknown }).then === "function";
}

async function discardOpening(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
  conn: LaneConnection,
): Promise<void> {
  state.opening.delete(conn);
  if (!conn.isAlive()) return;
  const closed = await closeConnection(conn, CLOSE_WAIT_MS);
  if (closed.outcome === "orphan") recordOrphan(state, input, closed.pid);
}

async function replaceHold(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
  next: Held | undefined,
): Promise<void> {
  const prior = state.held;
  state.held = next;
  if (prior === undefined || prior.sessionId === next?.sessionId || !prior.conn.isAlive()) return;
  const closed = await closeConnection(prior.conn, CLOSE_WAIT_MS);
  if (closed.outcome === "orphan") recordOrphan(state, input, closed.pid);
}

async function installHold(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
  epoch: number,
  next: Omit<Held, "epoch">,
): Promise<boolean> {
  state.opening.delete(next.conn);
  // DELTA ITEM 4: the epoch is stamped onto the hold HERE, at the one point that already knows both the
  // connection and the generation it was opened under, so a send can name its own generation's text
  // rather than asking who owns the lane right now.
  return installOrRefuse({
    epoch,
    current: state.startSeq,
    next: { ...next, epoch },
    replaceHold: (hold) => replaceHold(state, input, hold),
    onOrphan: (pid) => recordOrphan(state, input, pid),
  });
}

/**
 * FL-146 — SUPERSEDE EVERY OPEN THAT IS STILL IN FLIGHT, AND DO NOT WAIT FOR ANY OF THEM.
 *
 * Bumping `closedThrough` past every epoch handed out so far is the ONLY move that reaches an open at
 * every point in its life, including the part of it this module cannot see: a `start()` whose opener
 * has not yet returned a connection has nothing in `opening` to close, and it is precisely that instant
 * the operator loses the race in. The bump makes `openFresh`'s own guard (`epoch > state.closedThrough`)
 * refuse it when it lands, and `installOrRefuse`'s (`epoch === current`) refuse it if it gets further —
 * two independent checks, both already shipped, neither of which anything had to await.
 *
 * A FUTURE start() IS NOT AFFECTED: it takes `++startSeq`, which is greater than the value written
 * here, so the lane stays open for business. This supersedes the connections, never the lane.
 *
 * Returns the connections that HAD registered, for the caller's own close ladder — this function only
 * decides; it never closes, because `close()` and `dropHold()` need different ladders (results
 * aggregated into a LaneCloseResult vs. orphans surfaced and forgotten).
 */
function supersedeOpens(state: LaneHoldState): readonly LaneConnection[] {
  state.closedThrough = ++state.startSeq;
  const opening = [...state.opening];
  state.opening.clear();
  return opening;
}

/**
 * FL-146 — THE OPERATOR'S CANCEL, AND WHY IT USED TO BE A NO-OP AGAINST HALF THE TURNS IT HIT.
 *
 * MEASURED, from their own evidence DB: they submit at 09:52:31.734, gemini is cancelled at
 * 09:52:32.488, and claude's prompt is SENT at 09:52:38.392 — 5.9 s AFTER the cancel, `accepted`, and
 * claude answers. A different lane escaped on every trial, and spamming the key cancelled everything,
 * because each press was another attempt at the same window.
 *
 * The window is the gap between a connection EXISTING and `installHold` moving it into `state.held`.
 * The old `dropHold` called `replaceHold` and nothing else, and `replaceHold` touches only `state.held`
 * — so a cancel landing while the connection was merely OPENING returned `false` having done nothing,
 * the open finished, the hold installed, and the carrier sent the prompt to an agent the operator had
 * already stopped.
 *
 * THIS IS NOT `close()`, DELIBERATELY. `close()` ends the lane and hands back a LaneCloseResult; a
 * cancel has to leave the lane usable for the very next turn. What the two share is the ONE mechanism
 * that can reach an in-flight open — the supersession epoch — so that is what got extracted, not the
 * whole close.
 *
 * AND IT NEVER AWAITS THE OPEN IT IS SUPERSEDING. Parking a panic button behind a bridge that is still
 * spawning is how it stops being one; the epoch does the superseding synchronously and the close ladder
 * for the connections that already exist runs alongside the hold's own, not behind it.
 */
async function dropHoldState(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
): Promise<boolean> {
  const opening = supersedeOpens(state);
  // Read BEFORE the awaits below, which clear the hold: this is what the caller is told, and FL-146's
  // second half is that nobody could tell a cancel that killed something from one that killed nothing.
  // FL-150: named `reached`, not `stopped`. It says the cancel found a connection to supersede. Whether
  // the TURN stopped is a different question with a different owner — see dropHold's own header.
  const reached = state.held !== undefined || opening.length > 0 || state.pendingStarts > 0;
  await Promise.all([
    replaceHold(state, input, undefined),
    ...opening.map((conn) => discardOpening(state, input, conn)),
  ]);
  return reached;
}

async function closeHoldState(
  state: LaneHoldState,
  input: CockpitLaneTransportInput,
): Promise<LaneCloseResult> {
  const connections = [
    ...(state.held === undefined ? [] : [state.held.conn]),
    ...supersedeOpens(state),
  ];
  state.held = undefined;
  const results = await Promise.all(
    [...new Set(connections)].map((conn) => closeConnection(conn, CLOSE_WAIT_MS)),
  );
  for (const result of results) {
    if (result.outcome === "orphan") recordOrphan(state, input, result.pid);
  }
  const pids = [...state.orphanPids];
  state.orphanPids.clear();
  if (pids.length === 0) return { outcome: "closed" };
  return pids.length === 1
    ? { outcome: "orphan", pid: pids[0] as number }
    : { outcome: "orphan", pid: pids[0] as number, pids };
}

function recordOrphan(state: LaneHoldState, input: CockpitLaneTransportInput, pid: number): void {
  state.orphanPids.add(pid);
  input.onCloseOrphan?.(pid);
}

/**
 * W4-R2c C4 — THE SUPERSESSION GUARD, and it is the reason the interactive resume budget is safe to
 * have at all.
 *
 * A boot-time eager resume that a foreground turn has stopped waiting for is still RUNNING. When the
 * wedged bridge finally answers, that abandoned attempt reaches this point and would hand the
 * transport a STALE session — closing the fresh connection the operator's turn is mid-way through
 * using, and installing a dead one over the top. `replaceHold` cannot see the problem: from its side
 * it looks like an ordinary replacement.
 *
 * So the NEWEST `start()` owns the hold. An older ticket never installs; its connection is closed
 * through the SAME ladder a replacement uses, and a child that survives that is reported as an orphan
 * exactly as it would be anywhere else. Closed, or orphan-reported — never abandoned, never installed.
 */
async function installOrRefuse(attempt: {
  readonly epoch: number;
  readonly current: number;
  readonly next: Held;
  readonly replaceHold: (next: Held) => Promise<void>;
  readonly onOrphan: (pid: number) => void;
}): Promise<boolean> {
  if (attempt.epoch === attempt.current) {
    await attempt.replaceHold(attempt.next);
    return true;
  }
  if (attempt.next.conn.isAlive()) {
    const closed = await closeConnection(attempt.next.conn, CLOSE_WAIT_MS);
    if (closed.outcome === "orphan") attempt.onOrphan(closed.pid);
  }
  return false;
}

/**
 * start()'s body, lifted out of createCockpitLaneTransport's closure so that factory stays under the
 * function-line clamp (`held` is still read through the closure at call time, so the reuse decision sees
 * the CURRENT hold — including one dropped a moment earlier by the BLOCK 3 self-heal or by dropHold).
 * B1/B2: the "already held and alive, same session" fast path does NOT re-apply — nothing changed since
 * this connection last opened/resumed, so re-running applyRestoredMode on every turn would be a wasted
 * round trip AND would spuriously flicker the panel back to pending. Only a GENUINE open (fresh create)
 * or resume (a stored id reconnected) applies + reports an outcome.
 */
interface StartAttempt {
  readonly held: Held | undefined;
  readonly input: CockpitLaneTransportInput;
  readonly openFresh: () => Promise<LaneConnection>;
  readonly discardOpening: (conn: LaneConnection) => Promise<void>;
  /** W4-R2c C4: install this attempt's connection, or refuse it because a NEWER start() owns the
   *  transport now (in which case the connection is closed through the full ladder and this returns
   *  false). Bundled with the rest because the parameter list would otherwise pass the clamp. */
  readonly installHold: (epoch: number, next: Omit<Held, "epoch">) => Promise<boolean>;
  readonly sessionId: string | undefined;
  readonly epoch: number;
}

async function startOrReuseHold(attempt: StartAttempt) {
  const { held, input, openFresh, installHold, discardOpening, sessionId, epoch } = attempt;
  if (held?.conn.isAlive() === true && sessionId === held.sessionId) {
    return { outcome: "resumed" as const, sessionId: held.sessionId };
  }
  if (sessionId !== undefined) {
    return resumeHeld({ openFresh, sessionId, installHold, discardOpening, epoch, input });
  }
  return createFreshSession({ openFresh, installHold, discardOpening, epoch, input });
}

interface OpenAttempt {
  readonly openFresh: () => Promise<LaneConnection>;
  readonly installHold: (epoch: number, next: Omit<Held, "epoch">) => Promise<boolean>;
  readonly discardOpening: (conn: LaneConnection) => Promise<void>;
  readonly epoch: number;
  readonly input: CockpitLaneTransportInput;
}

// B1/B2: the "fresh create" branch of start() — split out so createCockpitLaneTransport's own
// closure stays under the function-length clamp. Opens, initializes, marks the connection held,
// THEN applies the restored mode (held is assigned first so a same-session lookup elsewhere in the
// closure sees it immediately; the caller-visible guarantee is still "mode applied before start()
// resolves," since nothing outside this module can act on `held` before that — see
// applyRestoredMode's own comment). Reports the full StartResult, including the mode-apply outcome.
async function createFreshSession(attempt: OpenAttempt) {
  const { openFresh, installHold, epoch, input } = attempt;
  const conn = await openFresh();
  let created: Awaited<ReturnType<LaneConnection["newSession"]>>;
  try {
    await conn.initialize();
    created = await conn.newSession();
  } catch (cause) {
    await attempt.discardOpening(conn);
    throw cause;
  }
  if (
    !(await installHold(epoch, {
      conn,
      sessionId: created.sessionId,
      ...(created.models === undefined ? {} : { models: created.models }),
    }))
  ) {
    // W4-R2c C4: a newer start() owns the transport; installHold has already closed this connection.
    // Reporting SUCCESS here would hand the caller a session id nothing holds.
    return { outcome: "resumeFailed" as const, reason: HOLD_SUPERSEDED_REASON };
  }
  const modeApplied = await applyRestoredMode(conn, created.sessionId, input.agent, input.repoRoot);
  return {
    outcome: "created" as const,
    sessionId: created.sessionId,
    modeApplied,
    ...(created.availableModeIds !== undefined
      ? { availableModeIds: created.availableModeIds }
      : {}),
  };
}

// W4-1: no live/alive held connection is the ORDINARY pre-first-turn state (the operator can cycle a
// mode before ever sending a message on this engine this session) — reported distinctly from a REAL
// bridge failure so the caller never renders a spurious error for a simply-not-yet-open lane.
async function setModeHeld(held: Held | undefined, modeId: string): Promise<SetLaneModeOutcome> {
  if (held === undefined || !held.conn.isAlive()) {
    return { outcome: "noSession" };
  }
  try {
    await held.conn.setMode(held.sessionId, modeId);
    return { outcome: "applied" };
  } catch (cause) {
    return { outcome: "failed", reason: errorMessage(cause) };
  }
}

async function setModelHeld(
  held: Held | undefined,
  agent: AcpAgent,
  modelId: string,
): Promise<SetLaneModelOutcome> {
  if (held === undefined || !held.conn.isAlive()) return { outcome: "noSession" };
  if (held.conn.setModel === undefined) {
    return { outcome: "failed", reason: `ACP ${agent} bridge cannot change models` };
  }
  if (held.models === undefined || !held.models.models.some((model) => model.modelId === modelId)) {
    return { outcome: "failed", reason: `${agent} did not advertise model ${modelId}` };
  }
  try {
    await held.conn.setModel(held.sessionId, modelId);
    held.models = { ...held.models, currentModelId: modelId };
    setAgentModel(agent, modelId);
    return { outcome: "applied" };
  } catch (cause) {
    return { outcome: "failed", reason: errorMessage(cause) };
  }
}

// B1/B2: a TRUE resume (a stored session id reconnected here) always applies + reports an outcome,
// unlike start()'s "already held and alive" fast path above (which never calls this function at all).
async function resumeHeld(attempt: OpenAttempt & { readonly sessionId: string }) {
  const { openFresh, installHold, epoch, input: modeInput, sessionId } = attempt;
  const conn = await openFresh();
  let availableModeIds: readonly string[] | undefined;
  let currentModeId: string | undefined;
  let models: AcpModelList | undefined;
  try {
    await conn.initialize();
    const resumed = await conn.resumeSession(sessionId);
    availableModeIds = resumed.availableModeIds;
    currentModeId = resumed.currentModeId;
    models = resumed.models;
  } catch (cause) {
    await attempt.discardOpening(conn);
    return { outcome: "resumeFailed" as const, reason: errorMessage(cause) };
  }
  if (
    !(await installHold(epoch, { conn, sessionId, ...(models === undefined ? {} : { models }) }))
  ) {
    // W4-R2c C4: THE STALE-RESUME CASE THIS GUARD EXISTS FOR. A boot-time eager resume that a
    // foreground turn stopped waiting for finally answers here — and without this, it would close the
    // fresh connection that turn is using and install its own stale one over the top. installHold has
    // already closed ours; report the refusal honestly rather than a resume nothing holds.
    return { outcome: "resumeFailed" as const, reason: HOLD_SUPERSEDED_REASON };
  }
  // W4-R FIX-1 B3-widened: adoptOrApplyResumedMode, not applyRestoredMode — a resume needs the
  // ground-truth-wins semantics; see that function's own header for the full invariant.
  const modeApplied = await adoptOrApplyResumedMode(
    conn,
    sessionId,
    modeInput.agent,
    modeInput.repoRoot,
    currentModeId,
  );
  return {
    outcome: "resumed" as const,
    sessionId,
    modeApplied,
    ...(availableModeIds !== undefined ? { availableModeIds } : {}),
  };
}
