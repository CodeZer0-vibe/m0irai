/**
 * @file src/adapters/acp/acp-lane-session.ts
 * @purpose MT7 persistent ACP lane session wrapper: decides create vs resume from an injected lane-state
 *   store, keeps one bridge child across prompts, forwards raw session updates, and closes with a bounded ladder.
 * @exports LaneBinding, LaneCloseResult, LaneConnection, LaneSession, LaneSessionDeps, LaneSessionInput, LaneSessionOpenResult, LaneSessionRow, LaneStateStore, closeConnection, openLaneSession
 * @depends ../../shared/turn-usage, ./acp-models, ./acp-servers, ./acp-turn-session
 */
import type { TurnUsage } from "../../shared/turn-usage.js";
import type { AcpModelList } from "./acp-models.js";
import type { AcpAgent } from "./acp-servers.js";
import { usageFromUpdate } from "./acp-turn-session.js";

const DEFAULT_CLOSE_WAIT_MS = 500;

export interface LaneBinding {
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly cwd: string;
}

export interface LaneSessionRow extends LaneBinding {
  readonly agent: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface LaneStateStore<DbHandle = unknown> {
  getLaneSession(db: DbHandle, projectId: string, agent: AcpAgent): LaneSessionRow | undefined;
  laneBindingMatches(row: LaneSessionRow, binding: LaneBinding): boolean;
  touchResumed(db: DbHandle, projectId: string, agent: AcpAgent, now: string): void;
}

/** B3 (MAX review fix round 1): the bridge's own SessionModeState, reduced to the id list
 *  native-mode.ts needs to derive a live per-session cycle order — never the static MODE_CATALOG
 *  fallback once a session has actually advertised its real modes (which may include a gated entry
 *  like claude's "auto" the static catalog deliberately excludes). Absent when the bridge's
 *  newSession/resumeSession response carries no `modes` field (an older or non-advertising install).
 *  W4-R FIX-1 B3-widened: `currentModeId` is `SessionModeState`'s OTHER required sibling field (ACP
 *  schema.json's SessionModeState, required: [currentModeId, availableModes]) — the bridge's own
 *  GROUND TRUTH for which mode the session is actually in right now, distinct from availableModeIds
 *  (the catalog it could cycle through). Absent under the SAME conditions as availableModeIds. */
export interface NewSessionResult {
  readonly sessionId: string;
  readonly availableModeIds?: readonly string[];
  readonly currentModeId?: string;
  readonly models?: AcpModelList;
}

export interface LaneConnection {
  initialize(): Promise<unknown>;
  newSession(): Promise<NewSessionResult>;
  resumeSession(sessionId: string): Promise<{
    readonly availableModeIds?: readonly string[];
    readonly currentModeId?: string;
    readonly models?: AcpModelList;
  }>;
  prompt(sessionId: string, text: string, emit: (update: unknown) => void): Promise<string>;
  /** W4-1: rejects on a bridge rejection or a response-absence timeout (the FAILURE CONTRACT) — the
   *  caller (lane-transport.ts's setLaneMode) reverts the panel selection + renders the error. */
  setMode(sessionId: string, modeId: string): Promise<void>;
  /** Optional only for injected/legacy connection seams. The production ACP connection implements it. */
  setModel?(sessionId: string, modelId: string): Promise<void>;
  close(): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
  killTree(): Promise<void>;
  isAlive(): boolean;
  pid(): number | undefined;
}

export interface LaneSessionDeps {
  readonly closeWaitMs?: number;
  readonly now?: () => string;
  readonly openConnection?: (agent: AcpAgent, cwd: string) => Promise<LaneConnection>;
}

export interface LaneSessionInput<DbHandle = unknown> {
  readonly adapterPkg: string;
  readonly adapterVersion: string;
  readonly agent: AcpAgent;
  readonly cwd: string;
  readonly db: DbHandle;
  readonly onSessionUpdate?: (update: unknown) => void;
  readonly projectId: string;
  readonly store: LaneStateStore<DbHandle>;
}

export type LaneCloseResult =
  | { readonly outcome: "closed" }
  | {
      readonly outcome: "orphan";
      readonly pid: number;
      /** Every surviving descendant when one lane had concurrent opens during teardown. */
      readonly pids?: readonly number[];
    };

export interface LaneSession {
  readonly sessionId: string;
  readonly pid: number | undefined;
  prompt(text: string): Promise<{ readonly stopReason: string; readonly usage?: TurnUsage }>;
  setMode(modeId: string): Promise<void>;
  close(): Promise<LaneCloseResult>;
}

export type LaneSessionOpenResult =
  | { readonly outcome: "created"; readonly session: LaneSession; readonly sessionId: string }
  | { readonly outcome: "resumed"; readonly session: LaneSession; readonly sessionId: string }
  | { readonly outcome: "invalidBinding"; readonly stored: LaneSessionRow }
  | { readonly outcome: "resumeFailed"; readonly sessionId: string; readonly cause: unknown };

export async function openLaneSession<DbHandle>(
  input: LaneSessionInput<DbHandle>,
  deps: LaneSessionDeps = {},
): Promise<LaneSessionOpenResult> {
  const stored = input.store.getLaneSession(input.db, input.projectId, input.agent);
  if (stored !== undefined && !matchesStored(input, stored)) {
    return { outcome: "invalidBinding", stored };
  }
  return stored === undefined ? createNew(input, deps) : resumeStored(input, stored, deps);
}

function matchesStored<DbHandle>(input: LaneSessionInput<DbHandle>, row: LaneSessionRow): boolean {
  return (
    row.projectId === input.projectId &&
    row.agent === input.agent &&
    input.store.laneBindingMatches(row, bindingOf(input))
  );
}

function bindingOf<DbHandle>(input: LaneSessionInput<DbHandle>): LaneBinding {
  return { adapterPkg: input.adapterPkg, adapterVersion: input.adapterVersion, cwd: input.cwd };
}

async function createNew<DbHandle>(
  input: LaneSessionInput<DbHandle>,
  deps: LaneSessionDeps,
): Promise<LaneSessionOpenResult> {
  const conn = await openInitialized(input, deps);
  const { sessionId } = await conn.newSession();
  const session = laneSession(sessionId, conn, input.onSessionUpdate, deps.closeWaitMs);
  return { outcome: "created", session, sessionId };
}

async function resumeStored<DbHandle>(
  input: LaneSessionInput<DbHandle>,
  stored: LaneSessionRow,
  deps: LaneSessionDeps,
): Promise<LaneSessionOpenResult> {
  const conn = await openInitialized(input, deps);
  try {
    await conn.resumeSession(stored.sessionId);
    input.store.touchResumed(input.db, input.projectId, input.agent, (deps.now ?? nowIso)());
    return {
      outcome: "resumed",
      session: laneSession(stored.sessionId, conn, input.onSessionUpdate, deps.closeWaitMs),
      sessionId: stored.sessionId,
    };
  } catch (cause) {
    await closeConnection(conn, deps.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS);
    return { outcome: "resumeFailed", sessionId: stored.sessionId, cause };
  }
}

async function openInitialized<DbHandle>(
  input: LaneSessionInput<DbHandle>,
  deps: LaneSessionDeps,
): Promise<LaneConnection> {
  if (deps.openConnection === undefined) {
    throw new Error("openLaneSession requires an injected ACP connection seam");
  }
  const conn = await deps.openConnection(input.agent, input.cwd);
  await conn.initialize();
  return conn;
}

function laneSession(
  sessionId: string,
  conn: LaneConnection,
  tap: ((update: unknown) => void) | undefined,
  closeWaitMs: number | undefined,
): LaneSession {
  return {
    pid: conn.pid(),
    sessionId,
    close: () => closeConnection(conn, closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS),
    prompt: (text) => promptLane(conn, sessionId, text, tap),
    setMode: (modeId) => conn.setMode(sessionId, modeId),
  };
}

async function promptLane(
  conn: LaneConnection,
  sessionId: string,
  text: string,
  tap: ((update: unknown) => void) | undefined,
): Promise<{ readonly stopReason: string; readonly usage?: TurnUsage }> {
  let usage: TurnUsage | undefined;
  const stopReason = await conn.prompt(sessionId, text, (update) => {
    tap?.(update);
    usage = usageFromUpdate(update) ?? usage;
  });
  return usage === undefined ? { stopReason } : { stopReason, usage };
}

// EXPORTED for the cockpit transport (lane-transport.ts): the ONE close ladder — a second implementation
// would drift from the I-13 escalation shape the same way the e2e's hand-rolled spawn drifted.
export async function closeConnection(
  conn: LaneConnection,
  waitMs: number,
): Promise<LaneCloseResult> {
  conn.close();
  if (await conn.waitForExit(waitMs)) return { outcome: "closed" };
  try {
    await conn.killTree();
  } catch {
    // Survival is checked below; the caller receives the orphan pid when tree-kill failed.
  }
  if (await conn.waitForExit(waitMs)) return { outcome: "closed" };
  const pid = conn.pid();
  return pid !== undefined && conn.isAlive() ? { outcome: "orphan", pid } : { outcome: "closed" };
}

function nowIso(): string {
  return new Date().toISOString();
}
