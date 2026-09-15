/**
 * @file src/shared/debug-mode.ts
 * @purpose The ONE resolution seam for ZER0_DEBUG (the operator's "full audit set" switch). `debugEnabled()` is
 *   the canonical truthiness gate; `activateDebugSession` creates `.zer0/debug/<sessionId>/` + stores its sink
 *   paths in a process singleton (screen-claim precedent) so the always-on sinks ROUTE there while on and fall
 *   back to cwd defaults when off (byte-identical). Explicit envs still win. shared/ only — node:* imports only.
 * @exports DebugSession, debugEnabled, activateDebugSession, debugSession, resetDebugSession, resolveTraceSink
 * @depends node:fs, node:path, node:process
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** The active debug session's resolved ABSOLUTE folder + the three sink paths gathered under it. */
export interface DebugSession {
  readonly sessionId: string;
  readonly dir: string;
  readonly tracePath: string;
  readonly flickerPath: string;
  readonly suppressedPath: string;
}

// The debug folder root (cwd-relative segments; resolved to absolute at activation so /debug + the exit
// pointer can print an openable path and the sinks are cwd-independent for the mount's life).
const DEBUG_ROOT_SEGMENTS: readonly [string, string] = [".zer0", "debug"];

// Process singleton: the currently-active debug session, or undefined when debug is off / not yet activated.
// Module-level (the screen-claim precedent) because the sinks that route into the folder (logger, flicker,
// suppressed) run in contexts with no sessionId to thread. Set once per cockpit mount; re-set on a /resume swap.
let active: DebugSession | undefined;

// The values that read as OFF after normalization. Compared against a trimmed, lowercased ZER0_DEBUG so a
// falsy-LOOKING value can never surprise-enable: "False", "FALSE", " 0 ", "No", "OFF" all disable.
const OFF_SENTINELS: ReadonlySet<string> = new Set(["", "0", "false", "no", "off"]);

/**
 * Whether ZER0_DEBUG is meaningfully truthy. B2a-1 (2026-07-18, operator ruling): OPT-OUT — UNSET now
 * reads ON (the full audit set is on by default; a fresh boot writes debug artifacts). An EXPLICIT falsy
 * value still disables it: the value is normalized (trim + lowercase) BEFORE matching, so `ZER0_DEBUG=0`
 * / `false` / `False` / ` 0 ` / `No` / `OFF` all read as OFF (no operator surprise). Off-sentinels:
 * "", "0", "false", "no", "off"; unset OR anything else (after normalizing) is ON.
 * DISK NOTE: on-by-default means .zer0/debug/<session>/ artifacts accrue every session, unbounded across
 * sessions until the operator sets ZER0_DEBUG=0 or a retention cap ships (named follow-up, B2a-1 report).
 */
export function debugEnabled(): boolean {
  const raw = process.env.ZER0_DEBUG;
  if (raw === undefined) {
    return true;
  }
  return !OFF_SENTINELS.has(raw.trim().toLowerCase());
}

/**
 * Activates the per-session debug folder IFF debug is enabled: resolves `.zer0/debug/<sessionId>/` to an
 * absolute path, creates it, stores the session in the singleton, and returns it. A no-op returning undefined
 * when debug is off — nothing is created and every sink keeps its default path (acceptance 2: byte-identical
 * when unset). `sessionId` is a trusted internal id (`chat-<ts>`); its path separators are stripped
 * defensively so the folder can never escape `.zer0/debug/`. `baseDir` (MT3e) roots the folder under an
 * EXPLICIT directory instead of process.cwd() — the detached digest child passes its repoRoot ARG so its
 * traces land under the project without the child ever CD'ing into (and thus holding) the project root.
 * Absent baseDir → cwd-relative, byte-identical to before (the cockpit path is unchanged).
 */
export function activateDebugSession(
  sessionId: string,
  baseDir?: string,
): DebugSession | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.resolve(baseDir ?? ".", ...DEBUG_ROOT_SEGMENTS, safeId);
  const session: DebugSession = {
    sessionId,
    dir,
    tracePath: path.join(dir, "trace.ndjson"),
    flickerPath: path.join(dir, "flicker.log"),
    suppressedPath: path.join(dir, "suppressed.log"),
  };
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort eager create: each sink also mkdir-recursives on write, so a failed create here (a race, a
    // permission blip) never loses artifacts — it just defers the folder to the first sink that writes.
  }
  active = session;
  return session;
}

/** The currently-active debug session, or undefined when debug is off. Read by the sinks + /debug + exit pointer. */
export function debugSession(): DebugSession | undefined {
  return active;
}

/** Test seam: clear the singleton so one test's activation can't leak into the next (byte-identical-off). */
export function resetDebugSession(): void {
  active = undefined;
}

/**
 * The chat-trace sink path: an explicit ZER0_CHAT_TRACE destination WINS (acceptance 3 — the switch sets a
 * default, never fights an explicit setting); otherwise the active debug session's trace.ndjson; otherwise
 * undefined (no trace — byte-identical when both are unset).
 */
export function resolveTraceSink(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  return active?.tracePath;
}
