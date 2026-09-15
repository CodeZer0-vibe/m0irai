/**
 * @file src/chat/lane-availability-store.ts
 * @purpose F1 (FIX-3): the DURABLE + in-memory layer over the pure model. Persists one LaneAvailability per
 *   agent to `.zer0/lane-availability.json` (atomic, schema-versioned — native-mode-store idiom) so a TUI
 *   restart RECONSTRUCTS an exhausted/needs-auth lane before the first send. No carrier DB — F1 holds on the
 *   memory-OFF path where the field death (chat-1784553379589) happened. evaluateSend is the gate's read.
 * @exports LaneSendDecision, LaneAvailabilityFsOps, initLaneAvailabilityStore, getLaneAvailability, evaluateSend,
 *   availableLaneNames, noteLaneFailure, noteLaneResetWindow, noteLaneBlockedSend, noteLaneRetry, noteLaneRetryFailed, noteLaneSuccess, resetLaneAvailabilityStore
 * @depends node:fs, node:path, ../shared/atomic-write, ./lane-availability, ./types
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../shared/atomic-write.js";
import {
  type LaneAvailability,
  type LaneFailureClass,
  initialAvailability,
  isLaneBlocked,
  onBlockedSend,
  onDispatchFailure,
  onDispatchSuccess,
  onRetry,
  onRetryFailed,
  plausiblyReset,
} from "./lane-availability.js";
import type { AgentName } from "./types.js";

const SCHEMA_VERSION = 1;

/** Injectable fs seam (tests only) — mirrors native-mode-store.ts's NativeModeFsOps. */
export interface LaneAvailabilityFsOps {
  readonly mkdirSync: typeof mkdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly renameSync: typeof renameSync;
}

const REAL_FS: LaneAvailabilityFsOps = { mkdirSync, readFileSync, writeFileSync, renameSync };

// Process-lifetime state. `registry` is the in-memory truth every gate read hits; the JSON file is the
// durable mirror reconstructed on init. `boundRoot`/`fsOps` are set by initLaneAvailabilityStore.
let registry = new Map<AgentName, LaneAvailability>();
let boundRoot: string | undefined;
let fsOps: LaneAvailabilityFsOps = REAL_FS;
// BLOCK 1: the latest reset instant (epoch ms) the usage stream reported per agent — the claude rate-window
// data zer0 already decodes (usage-reporter feeds this via noteLaneResetWindow). Used as the REAL resetsAtMs
// on a death when the caller passes none, so recovery keys off the true window, not only the fallback TTL.
const knownResetWindow = new Map<AgentName, number>();

interface PersistedEntry {
  readonly state: LaneAvailability["state"];
  readonly cause?: LaneFailureClass;
  readonly reason?: string;
  readonly resetsAtMs?: number;
  /** ITEM B: the INTERNAL probe deadline, persisted because the block itself is durable — a restart that
   *  reloaded a death with no deadline would have nothing to recover off. Absent in a file written by an
   *  earlier build; plausiblyReset falls back to resetsAtMs for exactly that case. */
  readonly probeAtMs?: number;
  readonly updatedMs: number;
}

function filePath(repoRoot: string): string {
  return join(repoRoot, ".zer0", "lane-availability.json");
}

/**
 * Loads the persisted lane availability for `repoRoot` into the process registry, so a restart reconstructs
 * an exhausted/needs-auth lane before any send. Absent/malformed/unknown-version file → an empty registry
 * (every lane defaults to ready) — a corrupted internal-state file is never a reason to block a live lane.
 * Idempotent per root; a test can inject `fs` to force a read/write outcome.
 */
export function initLaneAvailabilityStore(
  repoRoot: string,
  fs: LaneAvailabilityFsOps = REAL_FS,
): void {
  // Idempotent per project: once bound to this root, a repeat call (boot then lazy ensures) must NOT wipe
  // the in-memory registry — a lane that died THIS session would otherwise be forgotten mid-run. A test
  // forces a genuine reload with resetLaneAvailabilityStore() first (clears boundRoot).
  if (boundRoot === repoRoot) return;
  boundRoot = repoRoot;
  fsOps = fs;
  registry = new Map();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath(repoRoot), "utf8") as string;
  } catch {
    return; // no file yet — normal
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; lanes?: unknown };
    if (
      parsed.version !== SCHEMA_VERSION ||
      typeof parsed.lanes !== "object" ||
      parsed.lanes === null
    ) {
      return; // unknown schema / malformed -> defaults
    }
    for (const [agent, entry] of Object.entries(parsed.lanes as Record<string, unknown>)) {
      const availability = validatedEntry(entry);
      if (availability !== undefined) registry.set(agent as AgentName, availability);
    }
  } catch {
    // malformed JSON -> defaults (this file is write-exclusive to persist() below)
  }
}

function validatedEntry(raw: unknown): LaneAvailability | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as PersistedEntry;
  const states = ["ready", "exhausted", "needs_auth", "local_blocked", "retrying"];
  if (typeof e.state !== "string" || !states.includes(e.state)) return undefined;
  if (typeof e.updatedMs !== "number") return undefined;
  return {
    state: e.state,
    ...(e.cause === "exhausted" || e.cause === "needs_auth" ? { cause: e.cause } : {}),
    ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
    ...(typeof e.resetsAtMs === "number" ? { resetsAtMs: e.resetsAtMs } : {}),
    ...(typeof e.probeAtMs === "number" ? { probeAtMs: e.probeAtMs } : {}),
    updatedMs: e.updatedMs,
  };
}

/** The current availability for `agent` (ready by default when nothing is recorded). */
export function getLaneAvailability(agent: AgentName): LaneAvailability {
  return registry.get(agent) ?? initialAvailability(0);
}

/** The gate's verdict for one send. `allow` false → block locally (no child); `retrying` true → this send
 *  is the recovery attempt (window reset OR explicit operator retry) and must force a real dispatch/open. */
export interface LaneSendDecision {
  readonly allow: boolean;
  readonly retrying: boolean;
  readonly availability: LaneAvailability;
}

/**
 * Decide whether a send to `agent` may dispatch. A ready/retrying lane always dispatches. A blocked lane
 * dispatches ONLY as a recovery attempt — when a probe is due (plausiblyReset: the binding reset window has
 * passed, or the liveness ceiling has) — and that dispatch is flagged `retrying` so the caller forces a
 * fresh open (needs_auth reconnect). Otherwise the send is blocked locally, burning no child.
 * FIX-3c BLOCK 2: the `explicitRetry` parameter is GONE. It was never supplied by production — the gate
 * context is built from `{bus, repoRoot, turn}` alone — so it read as "operator retry is wired" while no
 * operator could ever reach it. Recovery does not need it: plausiblyReset's liveness ceiling guarantees a
 * probe becomes due even behind a days-away weekly window, so removing it cannot lock a lane out. W4-R2
 * reintroduces an operator override together with the actual retry command that calls it.
 */
export function evaluateSend(agent: AgentName, nowMs: number): LaneSendDecision {
  const availability = getLaneAvailability(agent);
  if (!isLaneBlocked(availability)) {
    return { allow: true, retrying: false, availability };
  }
  if (plausiblyReset(availability, nowMs)) {
    return { allow: true, retrying: true, availability };
  }
  return { allow: false, retrying: false, availability };
}

/** The agents (from `candidates`) whose lane is currently dispatchable (ready/retrying) — the "which lanes
 *  ARE available" list the instant local notice names when another lane is blocked. */
export function availableLaneNames(candidates: readonly AgentName[]): readonly AgentName[] {
  return candidates.filter((agent) => !isLaneBlocked(getLaneAvailability(agent)));
}

/** A dispatch FAILED with `errorText`: classify + transition + persist. Returns the new availability (or the
 *  unchanged one when the error was an ordinary transport/timeout that does not mark the lane dead). */
export function noteLaneFailure(
  agent: AgentName,
  errorText: string,
  nowMs: number,
  resetsAtMs?: number,
): LaneAvailability {
  // BLOCK 1: prefer a caller-supplied reset time, else the latest known usage window for this agent; the
  // pure model applies its conservative fallback cooldown only when NEITHER exists (recovery always reachable).
  const reset = resetsAtMs ?? knownResetWindow.get(agent);
  return mutate(agent, (prev) => onDispatchFailure(prev, errorText, nowMs, reset));
}

/** BLOCK 1: record the latest reset instant (epoch ms) the usage stream reported for `agent` — fed by the
 *  usage-reporter from the claude rate-window data, so a later death keys recovery off the TRUE window. */
export function noteLaneResetWindow(agent: AgentName, resetsAtMs: number): void {
  knownResetWindow.set(agent, resetsAtMs);
}

/** A send was blocked locally at an already-dead lane: EXHAUSTED/NEEDS_AUTH → LOCAL_BLOCKED (persisted). */
export function noteLaneBlockedSend(agent: AgentName, nowMs: number): LaneAvailability {
  return mutate(agent, (prev) => onBlockedSend(prev, nowMs));
}

/** A recovery attempt is starting (reset-window plausible or explicit retry): → RETRYING (persisted). */
export function noteLaneRetry(agent: AgentName, nowMs: number): LaneAvailability {
  return mutate(agent, (prev) => onRetry(prev, nowMs));
}

/** FIX-3c BLOCK 1: the sanctioned recovery attempt FAILED (classified or NOT) — the lane returns to its
 *  prior blocked state with a fresh cooldown, so an unclassified failure can never leave it dispatchable.
 *  The latest known usage window is offered to the pure model, which honours it only if still in the
 *  future (a past window would make the very next send re-probe — a retry storm). */
export function noteLaneRetryFailed(agent: AgentName, nowMs: number): LaneAvailability {
  return mutate(agent, (prev) => onRetryFailed(prev, nowMs, knownResetWindow.get(agent)));
}

/** A REAL successful dispatch/open: → READY (persisted). The only edge back to available. */
export function noteLaneSuccess(agent: AgentName, nowMs: number): LaneAvailability {
  return mutate(agent, (prev) => onDispatchSuccess(prev, nowMs));
}

/** Test-only: clears the process registry + unbinds the root, so one test's recorded deaths never bleed
 *  into another (mirrors resetCarrierRuntime / resetLaneAcquireCache). */
export function resetLaneAvailabilityStore(): void {
  registry = new Map();
  knownResetWindow.clear();
  boundRoot = undefined;
  fsOps = REAL_FS;
}

// Applies a pure transition, stores it, and persists the whole registry (best-effort — a persist failure
// leaves the in-memory truth intact and never throws into the dispatch path; durability is degraded for
// that one write, not correctness of THIS process's gating).
function mutate(
  agent: AgentName,
  transition: (prev: LaneAvailability) => LaneAvailability,
): LaneAvailability {
  const next = transition(getLaneAvailability(agent));
  registry.set(agent, next);
  persist();
  return next;
}

function persist(): void {
  if (boundRoot === undefined) return; // not bound to a project (e.g. a pure unit test) — memory-only
  const lanes: Record<string, PersistedEntry> = {};
  for (const [agent, a] of registry) {
    lanes[agent] = {
      state: a.state,
      ...(a.cause !== undefined ? { cause: a.cause } : {}),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.resetsAtMs !== undefined ? { resetsAtMs: a.resetsAtMs } : {}),
      ...(a.probeAtMs !== undefined ? { probeAtMs: a.probeAtMs } : {}),
      updatedMs: a.updatedMs,
    };
  }
  // The replace lives in src/shared/atomic-write.ts (one idiom, five hand-written copies before this).
  // The result is deliberately dropped: this mirror exists so a RESTART can reconstruct a blocked lane,
  // and a durability failure must never take down the dispatch that triggered it. The in-memory registry
  // above is still correct for this process; the next state change writes the file again.
  writeFileAtomicSync(
    filePath(boundRoot),
    `${JSON.stringify({ version: SCHEMA_VERSION, lanes }, null, 2)}\n`,
    { ensureDirectory: true, fs: fsOps },
  );
}
