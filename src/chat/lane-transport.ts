/**
 * @file src/chat/lane-transport.ts
 * @purpose The cockpit's persistent carrier RUNTIME and its REGISTRY of ACP lanes: the lane-state DB
 *   handle, one held transport per agent, the compaction detectors, and the boot-time decider wiring.
 *   ONE LANE's own connection lifecycle (open/resume/replace/send + the mode application inseparable
 *   from it) lives in lane-hold.ts — split there when W4-R2c C4's supersession guard pushed this file
 *   past the 600-line hard gate. This file answers "which lanes exist and who holds their handles";
 *   that one answers "what is this lane's connection doing right now".
 * @exports CockpitLaneTransportInput, CockpitLaneTransport, CarrierRuntimeConfig, CarrierRuntime, LaneTransportHooks, SetLaneModeOutcome, SetLaneModelOutcome, createCockpitLaneTransport, initCarrierRuntime, setCarrierLaneScope, carrierRuntime, persistenceOwnerFor, resetCarrierRuntime, getOrCreateLaneTransport, getOrCreateLaneDetector, closeAllLaneTransports, dropLaneHold, laneModels, setLaneMode, setLaneModel, setCarrierDecider, resetCarrierDecider
 * @depends ../adapters/acp/acp-models, ../adapters/acp/acp-permission, ../adapters/acp/acp-servers, ../evidence/db, ../evidence/db-identity, ../memory/compaction-detect, ./lane-hold
 */
import type { AcpModelList } from "../adapters/acp/acp-models.js";
import type { PermissionDecider } from "../adapters/acp/acp-permission.js";
import type { AcpAgent } from "../adapters/acp/acp-servers.js";
import { canonicalDbIdentity } from "../evidence/db-identity.js";
import { type Db, closeDb, openLaneStateDb } from "../evidence/db.js";
import { type CompactionDetector, createCompactionDetector } from "../memory/compaction-detect.js";
import {
  type CockpitLaneTransport,
  type CockpitLaneTransportInput,
  type SetLaneModeOutcome,
  type SetLaneModelOutcome,
  createCockpitLaneTransport,
} from "./lane-hold.js";

// One lane's CONNECTION LIFECYCLE lives in lane-hold.ts (W4-R2c: this file crossed the 600-line hard
// gate). Its three public shapes are RE-EXPORTED here so every existing importer — the runtime wiring,
// the mount, the suites — keeps importing them from the same place, unchanged.
export type {
  CockpitLaneTransport,
  CockpitLaneTransportInput,
  SetLaneModeOutcome,
  SetLaneModelOutcome,
};
export { createCockpitLaneTransport };

export interface LaneTransportHooks {
  readonly onSessionUpdate?: (update: unknown) => void;
  readonly onText?: (chunk: string) => void;
}

export interface CarrierRuntimeConfig {
  readonly projectId: string;
  readonly dbPath: string;
  readonly repoRoot: string;
  readonly cwd: string;
  /** Native provider state scope; legacy cockpit callers omit it for project-global behavior. */
  readonly laneScopeId?: string;
  /** False for the WINDOWED second cockpit (I-14 lock conflict): the runtime still MINTS ledger seqs
   *  (F-16: seq allocation is open to any cockpit) but carrier turns stay off. Default true. */
  readonly lanesEnabled?: boolean;
  readonly openConnection?: NonNullable<CockpitLaneTransportInput["openConnection"]>;
  /** Cancels every bridge owned by this runtime before its DB and project lock are released. */
  readonly signal?: AbortSignal;
}

export interface CarrierRuntime {
  readonly projectId: string;
  readonly dbPath: string;
  /** W4-R3a RA-1: the canonical identity of {@link dbPath}, resolved ONCE at open (initCarrierRuntime)
   *  rather than re-derived per write. Compare through {@link persistenceOwnerFor}, never by string. */
  readonly dbIdentity: string;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly laneScopeId: string;
  readonly db: Db;
  readonly lanesEnabled: boolean;
}

interface RuntimeState extends CarrierRuntime {
  readonly openConnection?: NonNullable<CockpitLaneTransportInput["openConnection"]>;
  readonly signal?: AbortSignal;
  readonly transports: Map<AcpAgent, RuntimeTransportEntry>;
  // Detectors cover ALL carrier lanes: ACP agents get event+ctx% signals; gemini/agy runs the
  // periodic-only floor (Q-3), so its detector exists too.
  readonly detectors: Map<AcpAgent | "gemini", CompactionDetector>;
}

interface RuntimeTransportEntry {
  readonly callbacks: MutableLaneHooks;
  readonly transport: CockpitLaneTransport;
}

interface MutableLaneHooks {
  onSessionUpdate: ((update: unknown) => void) | undefined;
  onText: ((chunk: string) => void) | undefined;
}

let runtime: RuntimeState | undefined;

// W4-3: the operator-facing permission decider FACTORY, set independently of initCarrierRuntime — that
// function runs at chat-tui-boot.ts's prepareBoot, BEFORE the event bus exists (bootCarrierRuntime has
// no bus to wire a decider's callbacks through yet). Mirrors agent-mode-store.ts's own shape: boot-time
// wiring set at a LATER point than the runtime it augments, once its own dependency (the bus) exists.
// Absent -> runtimeTransportInput never sets CockpitLaneTransportInput.decide, so acp-lane-connection.ts's
// resolveDecider FAILS CLOSED. Deliberately NOT reset by resetCarrierRuntime (a process-shutdown/test
// cleanup for the LANE runtime, not the boot-time decider wiring) — resetCarrierDecider is its own,
// separate export for the rare test that needs to isolate this specifically.
let carrierDecider: ((agent: AcpAgent) => PermissionDecider) | undefined;

/** Wires the operator-facing decider factory for every future lane this runtime opens (chat-tui-
 *  mount.ts's resolveMountExtras, once the event bus is available). `factory(agent)` is called fresh
 *  per lane open — the SAME factory instance across lanes, but each lane's connection gets its OWN
 *  decider closure (createOperatorPermissionDecider's own per-agent registry keying). */
export function setCarrierDecider(factory: (agent: AcpAgent) => PermissionDecider): void {
  carrierDecider = factory;
}

/** Test-only reset (mirrors resetCarrierRuntime's shape) — clears the decider factory so a leaked
 *  wiring from one test can never silently supply asks in a later one. */
export function resetCarrierDecider(): void {
  carrierDecider = undefined;
}

export function initCarrierRuntime(config: CarrierRuntimeConfig): CarrierRuntime {
  resetCarrierRuntime();
  runtime = {
    projectId: config.projectId,
    dbPath: config.dbPath,
    // RA-1: canonicalise AT THE OPEN, not at the call sites. The runtime is booted with whatever spelling
    // loadConfig handed chat-tui.ts (cwd-relative by default, config.ts:17); resolving it once here is what
    // lets a caller holding the absolutised form of the SAME file still be recognised as this owner.
    dbIdentity: canonicalDbIdentity(config.dbPath),
    repoRoot: config.repoRoot,
    cwd: config.cwd,
    laneScopeId: config.laneScopeId ?? "",
    db: openLaneStateDb(config.dbPath),
    lanesEnabled: config.lanesEnabled ?? true,
    transports: new Map(),
    detectors: new Map(),
    ...(config.openConnection !== undefined ? { openConnection: config.openConnection } : {}),
    ...(config.signal !== undefined ? { signal: config.signal } : {}),
  };
  return runtime;
}

export function carrierRuntime(): CarrierRuntime | undefined {
  if (runtime === undefined) return undefined;
  const { projectId, dbPath, dbIdentity, repoRoot, cwd, laneScopeId, db, lanesEnabled } = runtime;
  return { projectId, dbPath, dbIdentity, repoRoot, cwd, laneScopeId, db, lanesEnabled };
}

/** Assigns V2's outer chat session as the native-lane scope before any lane is opened. */
export function setCarrierLaneScope(laneScopeId: string): void {
  if (runtime === undefined) throw new Error("carrier runtime is not initialized");
  if (laneScopeId.trim().length === 0) throw new Error("carrier lane scope must be non-empty");
  if (runtime.laneScopeId === laneScopeId) return;
  if (runtime.transports.size > 0 || runtime.detectors.size > 0) {
    throw new Error("carrier lane scope cannot change after lane initialization");
  }
  runtime = { ...runtime, laneScopeId };
}

/**
 * W4-R3a RA-1: THE ONE DECISION POINT for "is this write the run's own persistence owner's?". Every
 * conversation-message writer asks HERE — recordChatMessage, recordLaneTurnEvidence, and persistDebateTurn
 * each used to carry their OWN `carrier.dbPath === input.dbPath` raw string compare (evidence.ts:194,
 * evidence.ts:299, evidence-strict.ts:153), which is three chances for one file under two spellings to read
 * as two stores and drop the ledger mint. One function means a fourth writer cannot invent a fourth rule.
 *
 * Returns the owner (carrying the lane-capable handle + scoped project id) when `dbPath` names the SAME
 * FILE the runtime opened, else undefined. Undefined is the honest answer for the genuinely non-carrier
 * paths — memory off, a different project's db, a digest child — and leaves them byte-identically inert.
 * Deliberately NOT gated on `lanesEnabled`: the windowed second cockpit (chat-tui-boot.ts:55) runs with
 * lanes disabled and STILL mints ledger seqs (I-14/F-16), a documented invariant.
 */
export function persistenceOwnerFor(dbPath: string): CarrierRuntime | undefined {
  const owner = carrierRuntime();
  if (owner === undefined) {
    return undefined;
  }
  return canonicalDbIdentity(dbPath) === owner.dbIdentity ? owner : undefined;
}

/**
 * The per-lane compaction detector (T4), created lazily against the runtime's durable store — the
 * production wiring the wave-seal review demanded (B3): headless-carrier feeds it raw session updates
 * + ctx% and reports accepted prompts; the detector arms the durable carry flag, never clears it.
 */
export function getOrCreateLaneDetector(agent: AcpAgent | "gemini"): CompactionDetector {
  if (runtime === undefined) throw new Error("carrier runtime is not initialized");
  const existing = runtime.detectors.get(agent);
  if (existing !== undefined) return existing;
  const detector = createCompactionDetector({
    agent,
    db: runtime.db,
    projectId: runtime.projectId,
    ...(runtime.laneScopeId.length === 0 ? {} : { laneScopeId: runtime.laneScopeId }),
  });
  runtime.detectors.set(agent, detector);
  return detector;
}

export function resetCarrierRuntime(): void {
  const prior = runtime;
  runtime = undefined;
  if (prior !== undefined) closeDb(prior.db);
}

export function getOrCreateLaneTransport(
  agent: AcpAgent,
  hooks: LaneTransportHooks = {},
): CockpitLaneTransport {
  if (runtime === undefined) throw new Error("carrier runtime is not initialized");
  const existing = runtime.transports.get(agent);
  if (existing !== undefined) {
    updateHooks(existing.callbacks, hooks);
    return existing.transport;
  }
  const entry = createRuntimeEntry(runtime, agent, hooks);
  runtime.transports.set(agent, entry);
  return entry.transport;
}

/**
 * W4-1: the Shift+Tab mode-cycle's ONE entry point into the live ACP registry. Looks up an EXISTING
 * transport only (never creates one — a transport with no held connection would just report
 * "noSession" anyway, so creating one solely to ask has no benefit and would register a compaction
 * detector for an engine the operator has never actually used this session).
 */
export async function setLaneMode(agent: AcpAgent, modeId: string): Promise<SetLaneModeOutcome> {
  if (runtime === undefined) {
    return { outcome: "noSession" };
  }
  const existing = runtime.transports.get(agent);
  return existing === undefined ? { outcome: "noSession" } : existing.transport.setMode(modeId);
}

export function laneModels(agent: AcpAgent): AcpModelList | undefined {
  return runtime?.transports.get(agent)?.transport.models();
}

export async function setLaneModel(agent: AcpAgent, modelId: string): Promise<SetLaneModelOutcome> {
  const existing = runtime?.transports.get(agent);
  return existing === undefined ? { outcome: "noSession" } : existing.transport.setModel(modelId);
}

/**
 * BLOCK 3 (FIX-3b): drop ONE lane's held connection — the reconnect seam the pre-dispatch gate reaches
 * through when it sanctions a recovery attempt, so the retry rides a connection opened AFTER the sanction
 * and never the one held when the lane died. EXISTING transports only (setLaneMode's own rule: creating
 * one just to drop it would register a detector for an engine the operator never used, and there would be
 * nothing to drop). A missing runtime (the non-carrier path, which spawns a child per turn and holds
 * nothing) is a legitimate no-op, never an error.
 *
 * TWO CALLERS, NOT ONE (review P3-C): this reconnect seam (`lane-gate.ts`'s forceFreshConnection) and
 * the operator's cancel (`room-host-support.ts`'s dropCancelledLaneHold). Since FL-146 the drop also
 * supersedes opens still IN FLIGHT, so both callers get that reach, not just the cancel.
 *
 * FL-150: the returned boolean means the caller REACHED a connection — never that a turn stopped.
 * `CockpitLaneTransport.dropHold`'s own header (lane-hold.ts) is the authority on that distinction.
 */
export async function dropLaneHold(agent: AcpAgent): Promise<boolean> {
  const existing = runtime?.transports.get(agent);
  return existing === undefined ? false : existing.transport.dropHold();
}

export async function closeAllLaneTransports(): Promise<readonly number[]> {
  if (runtime === undefined) return [];
  const entries = [...runtime.transports.values()];
  runtime.transports.clear();
  const closed = await Promise.all(entries.map((entry) => entry.transport.close()));
  return closed.flatMap((result) =>
    result.outcome === "orphan" ? (result.pids ?? [result.pid]) : [],
  );
}

function createRuntimeEntry(
  state: RuntimeState,
  agent: AcpAgent,
  hooks: LaneTransportHooks,
): RuntimeTransportEntry {
  const callbacks: MutableLaneHooks = { onSessionUpdate: undefined, onText: undefined };
  updateHooks(callbacks, hooks);
  const input = runtimeTransportInput(state, agent, callbacks);
  return { callbacks, transport: createCockpitLaneTransport(input) };
}

function runtimeTransportInput(
  state: RuntimeState,
  agent: AcpAgent,
  callbacks: MutableLaneHooks,
): CockpitLaneTransportInput {
  return {
    agent,
    cwd: state.cwd,
    repoRoot: state.repoRoot,
    onSessionUpdate: (update: unknown) => callbacks.onSessionUpdate?.(update),
    onText: (chunk: string) => callbacks.onText?.(chunk),
    ...(state.openConnection !== undefined ? { openConnection: state.openConnection } : {}),
    ...(state.signal !== undefined ? { signal: state.signal } : {}),
    ...(carrierDecider !== undefined ? { decide: carrierDecider(agent) } : {}),
  };
}

function updateHooks(target: MutableLaneHooks, hooks: LaneTransportHooks): void {
  target.onSessionUpdate = hooks.onSessionUpdate;
  target.onText = hooks.onText;
}
