/**
 * @file src/adapters/acp/acp-lane-connection.ts
 * @purpose The REAL LaneConnection factory for MT7 persistent lanes: wraps spawnServer, ndJsonStream +
 *   createAcpClient, and the shared killTree ladder. buildLaneConnection = pure fake-testable wiring;
 *   openAcpLaneConnection = live glue (native-resume e2e receipts). W4-3: resolveDecider closes the
 *   referee's named trap — FAILS CLOSED (denies) when no operator decider was wired in, never auto-approve.
 *   (invalidatePendingAsk on prompt-settle lives ONE layer up, chat/lane-transport.ts's sendHeld — this
 *   adapters/ module must never import chat/, per no-upward-deps-adapters, dep-check-verified.)
 * @exports LaneChildLike, LaneWireConnection, OpenAcpLaneConnectionInput, buildLaneConnection, openAcpLaneConnection, resolveDecider
 * @depends node:stream, @agentclientprotocol/sdk, ../../shared/kill-tree, ./acp-lane-session, ./acp-models, ./acp-permission, ./acp-servers, ./acp-turn-session
 */
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { killTree } from "../../shared/kill-tree.js";
import { createLogger } from "../../shared/logger.js";
import { redactPayload } from "../../shared/redact-payload.js";
import type { LaneConnection } from "./acp-lane-session.js";
import { type EmitSlot, deliverLaneUpdate, laneEmitSlot } from "./acp-lane-update-routing.js";
import { extractAcpModels } from "./acp-models.js";
import { type PermissionDecider, denyDecider } from "./acp-permission.js";
import type { AcpAgent } from "./acp-servers.js";
import {
  type AcpSessionUpdateTap,
  acpSessionMetadata,
  createAcpClient,
  spawnServer,
} from "./acp-turn-session.js";

const logger = createLogger();
const PHASE = "acp-lane";
const PROTOCOL_VERSION = 1;
// A real handshake is ~2-3s (acp-turn-session precedent); a wedged child must fail NAMING ITS STEP.
const HANDSHAKE_STEP_TIMEOUT_MS = 60_000;

/** The child surface the wiring needs (a real ChildProcess satisfies it; tests inject a fake). */
export interface LaneChildLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/** The SDK-connection surface the wiring needs (ClientSideConnection satisfies it). */
export interface LaneWireConnection {
  initialize(params: {
    clientCapabilities: Record<string, never>;
    protocolVersion: number;
  }): Promise<unknown>;
  newSession(params: {
    cwd: string;
    mcpServers: never[];
    _meta?: Record<string, unknown>;
  }): Promise<unknown>;
  resumeSession(params: {
    cwd: string;
    sessionId: string;
    _meta?: Record<string, unknown>;
  }): Promise<unknown>;
  prompt(params: {
    prompt: { text: string; type: "text" }[];
    sessionId: string;
  }): Promise<{ stopReason: unknown }>;
  setSessionMode(params: { sessionId: string; modeId: string }): Promise<unknown>;
  setSessionConfigOption?(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): Promise<unknown>;
  extMethod?(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface OpenAcpLaneConnectionInput {
  readonly agent: AcpAgent;
  readonly cwd: string;
  /** Decoded agent text chunks (the reply stream). Reset/accumulate per turn around the awaited prompt. */
  readonly onText?: (chunk: string) => void;
  /** W4-3: the operator-facing permission decider for THIS lane (lane-transport.ts's setCarrierDecider,
   *  ultimately createOperatorPermissionDecider). Absent -> resolveDecider's FAIL-CLOSED default. */
  readonly decide?: PermissionDecider;
  /** The lane's raw session-update consumer, installed for the life of the CONNECTION rather than the
   *  turn — see {@link EmitSlot} for the meters this exists to stop losing. */
  readonly onSessionUpdate?: AcpSessionUpdateTap;
  /** Aborting room ownership terminates the bridge even if an ACP handshake promise stays pending. */
  readonly signal?: AbortSignal;
}

/**
 * W4-3 (MAX review precedent's exact trap, closed here): the interactive lane path has exactly ONE
 * legitimate decider source — the operator, injected via `input.decide`. Absent is NOT the same as
 * "auto-approve is fine" (that reasoning is acp-turn-session.ts's headless-only default, a DIFFERENT
 * context with no live operator to ask) — it means the wiring upstream failed to supply one, and the
 * safe response is denyDecider, never autoApproveDecider. Pure + exported so this exact "which decider
 * does createAcpClient receive" decision is unit-testable WITHOUT spawning a real child process
 * (openAcpLaneConnection itself always does) — the referee's named trap was specifically that a test
 * exercising ONLY the pure wiring (buildLaneConnection) could stay green while this line silently
 * hardcoded auto-approve; extracting it here gives the trap a load-bearing test of its own.
 */
export function resolveDecider(input: OpenAcpLaneConnectionInput): PermissionDecider {
  return input.decide ?? denyDecider;
}

/**
 * Opens a LIVE persistent lane connection: production spawn + SDK stream + client handlers. The
 * end-to-end behavior (create, resume-across-process-death, mid-turn kill) is receipt-proven by
 * tests/integration/native-resume.e2e.test.ts on these exact primitives.
 */
export function openAcpLaneConnection(input: OpenAcpLaneConnectionInput): LaneConnection {
  input.signal?.throwIfAborted();
  const child = spawnServer(input.agent, undefined, input.cwd);
  if (child.stdin === null || child.stdout === null) {
    throw new Error(`ACP ${input.agent} bridge child has no stdio pipes`);
  }
  const slot = laneEmitSlot(input);
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const conn = new ClientSideConnection(
    () =>
      createAcpClient({
        decide: resolveDecider(input),
        onSessionUpdate: (update, sessionId) => deliverLaneUpdate(slot, update, sessionId),
        onUpdate: (chunk) => input.onText?.(chunk),
        onUsage: () => undefined, // usage is derived by the lane session from the raw update stream
        onExtNotification: (method, params) => logBridgeExtension(input.agent, method, params),
      }),
    stream,
  );
  return buildLaneConnection(input.agent, child, conn, input.cwd, slot);
}

/**
 * Pure wiring over injected child + SDK connection (the fake-testable core): labeled handshake
 * timeouts, per-prompt emit slot swap, and the I-13 close ladder pieces (kill probe, bounded exit
 * wait, shared tree-kill).
 */
export function buildLaneConnection(
  agent: AcpAgent,
  child: LaneChildLike,
  conn: LaneWireConnection,
  cwd: string,
  slot: EmitSlot,
): LaneConnection {
  const unbindAbort = bindAbortToChild(slot.signal, child);
  return {
    ...buildLaneWireMethods(agent, conn, cwd, slot.signal),
    ...buildLaneProcessMethods(child, conn, slot, unbindAbort),
  };
}

/** The ACP wire calls: labeled step-timeout wrapping for initialize/newSession/resumeSession, plus
 *  W4-1's setMode (step-timeout capped, unlike prompt below — session/set_mode is a near-instant
 *  in-memory mutation on both installed bridges, so a bridge that never responds is "ignoring the
 *  call", not "still thinking"; 60s bounds that honestly). */
function buildLaneWireMethods(
  agent: AcpAgent,
  conn: LaneWireConnection,
  cwd: string,
  signal?: AbortSignal,
): Pick<LaneConnection, "initialize" | "newSession" | "resumeSession" | "setMode" | "setModel"> {
  return {
    initialize: () =>
      withStepTimeout(
        conn.initialize({ clientCapabilities: {}, protocolVersion: PROTOCOL_VERSION }),
        `${agent} initialize`,
        signal,
      ),
    newSession: async () => {
      const response = await withStepTimeout(
        conn.newSession({ cwd, mcpServers: [], ...acpSessionMetadata(agent) }),
        `${agent} newSession`,
        signal,
      );
      const availableModeIds = availableModeIdsOf(response);
      const currentModeId = currentModeIdOf(response);
      return {
        sessionId: sessionIdOf(response),
        models: extractAcpModels(response),
        ...(availableModeIds !== undefined ? { availableModeIds } : {}),
        ...(currentModeId !== undefined ? { currentModeId } : {}),
      };
    },
    // B3 (MAX review fix round 1): resumeSession's response carries the SAME optional `modes` field
    // as newSession's — a resumed session's live-advertised catalog can differ from what a prior
    // process saw (e.g. an agent upgrade), so this is re-captured on every resume, never assumed
    // stable from the original create. W4-R FIX-1 B3-widened: currentModeId is ALSO re-captured on
    // every resume — the session's real current mode is exactly what a resume can legitimately
    // differ on (a HELD/persistent bridge session may carry forward a mode from BEFORE this process
    // ever existed), so it is never assumed to match whatever this process last persisted.
    resumeSession: (sessionId) => resumeLaneSession(agent, conn, cwd, sessionId, signal),
    setMode: (sessionId, modeId) =>
      withStepTimeout(conn.setSessionMode({ modeId, sessionId }), `${agent} setMode`, signal).then(
        () => undefined,
      ),
    setModel: (sessionId, modelId) => setLaneModel(agent, conn, sessionId, modelId, signal),
  };
}

async function resumeLaneSession(
  agent: AcpAgent,
  conn: LaneWireConnection,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
) {
  const response = await withStepTimeout(
    conn.resumeSession({ cwd, sessionId, ...acpSessionMetadata(agent) }),
    `${agent} resumeSession`,
    signal,
  );
  const availableModeIds = availableModeIdsOf(response);
  const currentModeId = currentModeIdOf(response);
  return {
    models: extractAcpModels(response),
    ...(availableModeIds !== undefined ? { availableModeIds } : {}),
    ...(currentModeId !== undefined ? { currentModeId } : {}),
  };
}

function setLaneModel(
  agent: AcpAgent,
  conn: LaneWireConnection,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<void> {
  const work =
    agent === "claude"
      ? conn.setSessionConfigOption?.({ sessionId, configId: "model", value: modelId })
      : conn.extMethod?.("session/set_model", { sessionId, modelId });
  if (work === undefined) {
    return Promise.reject(new Error(`ACP ${agent} bridge cannot change models in a live session`));
  }
  return withStepTimeout(work, `${agent} setModel`, signal).then(() => undefined);
}

/** The I-13 close ladder pieces (kill probe, bounded exit wait, shared tree-kill) + the prompt/emit-slot
 *  swap — the process-lifecycle half of a lane connection. */
function buildLaneProcessMethods(
  child: LaneChildLike,
  conn: LaneWireConnection,
  slot: EmitSlot,
  unbindAbort: () => void,
): Pick<LaneConnection, "prompt" | "close" | "waitForExit" | "killTree" | "isAlive" | "pid"> {
  return {
    prompt: async (sessionId, text, emit) => {
      slot.current = emit;
      // The session a late update must name to still be ours (see deliverLaneUpdate).
      slot.liveSessionId = sessionId;
      try {
        const result = await conn.prompt({ prompt: [{ text, type: "text" }], sessionId });
        return String(result.stopReason);
      } finally {
        slot.current = undefined;
      }
    },
    close: () => {
      unbindAbort();
      // Nothing may fire after close. The child dies here so in production nothing should arrive
      // anyway; dropping the listener makes that true BY CONSTRUCTION instead of by trusting the kill
      // to win a race against an answer already on the wire.
      slot.standing = undefined;
      child.kill();
    },
    waitForExit: (timeoutMs) => waitForChildExit(child, timeoutMs),
    killTree: async () => {
      if (child.pid !== undefined) {
        await killTree(child.pid);
      }
    },
    isAlive: () => child.exitCode === null && child.signalCode === null,
    pid: () => child.pid,
  };
}

/**
 * BLOCK 4 (F6): the lane's consumer for the bridge's `_claude/*` extension notifications — today the live
 * background-task set the claude adapter used to drop (PATCH(zer0 f6-tasksurface)). Recorded on the debug
 * channel the operator's own ZER0_DEBUG runs already capture, so the NEXT field run answers "were its
 * subagents still alive?" from data instead of from the model's own (live-proven wrong) narration. This is
 * the observability half that ships WITH the adapter fix; rendering a background-activity surface in the
 * cockpit is F5's scope, deliberately not built here.
 */
function logBridgeExtension(
  agent: AcpAgent,
  method: string,
  params: Record<string, unknown>,
): void {
  // FIX-3c BLOCK 4 (privacy): the WIRE may carry the operator's content — the reply stream already does —
  // but this is a debug ARTIFACT, and debug directories get shared. `_claude/backgroundTasks` params carry
  // the model's task `description`/`summary` (paraphrases of the operator's own instructions) and an
  // `outputFile` path embedding their user + project names, so the payload is projected to STRUCTURE ONLY
  // before it is ever serialized. redactPayload's rule is inverted (a string is content unless its key is
  // structurally allowlisted), so a future bridge extension cannot leak here by default.
  logger.debug({ phase: PHASE }, "bridge extension notification", {
    agent,
    method,
    params: JSON.stringify(redactPayload(params)).slice(0, 2000),
  });
}

function waitForChildExit(child: LaneChildLike, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// A wedged handshake fails fast NAMING ITS STEP (the T3 live lesson: 600 silent seconds under one
// opaque cap). Prompts are NOT capped here - model latency is unbounded; aborts are the caller's.
function withStepTimeout<T>(work: Promise<T>, step: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new Error(`ACP lane step aborted: ${step}`)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`ACP lane step timed out after 60s: ${step}`))),
      HANDSHAKE_STEP_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    work.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
  });
}

function bindAbortToChild(signal: AbortSignal | undefined, child: LaneChildLike): () => void {
  if (signal === undefined) return () => undefined;
  const abort = () => {
    child.kill();
  };
  const unbind = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  child.once("exit", unbind);
  if (signal.aborted) abort();
  return unbind;
}

function sessionIdOf(response: unknown): string {
  if (typeof response === "object" && response !== null && "sessionId" in response) {
    const id = (response as { sessionId: unknown }).sessionId;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  throw new Error("ACP newSession returned no sessionId");
}

// B3 (MAX review fix round 1): reads NewSessionResponse/ResumeSessionResponse's optional
// `modes.availableModes[].id` list — the bridge's OWN advertised cycle order (ACP schema.json's
// SessionModeState). Absent/malformed at ANY level (an older install, or a bridge that omits the
// field) degrades to undefined rather than throwing — this is optional richness, never a precondition
// for a session to open. A malformed individual entry (missing/blank id) is dropped, not fatal.
function availableModeIdsOf(response: unknown): readonly string[] | undefined {
  if (typeof response !== "object" || response === null || !("modes" in response)) {
    return undefined;
  }
  const modes = (response as { modes: unknown }).modes;
  if (typeof modes !== "object" || modes === null || !("availableModes" in modes)) {
    return undefined;
  }
  const available = (modes as { availableModes: unknown }).availableModes;
  if (!Array.isArray(available)) {
    return undefined;
  }
  const ids = available
    .map((entry: unknown) =>
      typeof entry === "object" && entry !== null && "id" in entry
        ? (entry as { id: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

// W4-R FIX-1 B3-widened: reads NewSessionResponse/ResumeSessionResponse's optional
// `modes.currentModeId` — SessionModeState's OTHER required sibling field alongside availableModes
// (ACP schema.json: SessionModeState.required = [currentModeId, availableModes]), the bridge's own
// GROUND TRUTH for which mode the session is actually in right now. Same defensive-parse shape as
// availableModeIdsOf: absent/malformed at any level degrades to undefined, never throws — a
// non-advertising bridge has nothing to adopt, not a broken one.
function currentModeIdOf(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null || !("modes" in response)) {
    return undefined;
  }
  const modes = (response as { modes: unknown }).modes;
  if (typeof modes !== "object" || modes === null || !("currentModeId" in modes)) {
    return undefined;
  }
  const id = (modes as { currentModeId: unknown }).currentModeId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
