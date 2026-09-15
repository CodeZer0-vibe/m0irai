/**
 * @file src/adapters/agy-mode-probe.ts
 * @purpose W4-2 STARTUP CAPABILITY PROBE: parses `agy --help` (BOTH streams — agy prints to stderr)
 *   to detect --mode support; probe-failed is never conflated with a confirmed "unsupported" absence.
 *   W4-R REFIT R3 (referee FALSIFIED the env hypothesis — a real spawn answered in 188ms): a completed
 *   outcome is PERSISTED (path+version key, agy-mode-probe-store.ts) and checked before spawning — a
 *   cache hit costs zero spawns. A TIMEOUT retries ONCE before probe-failed; ENOENT is never retried.
 * @exports ModeProbeOutcome, cachedAgyModeSupport, probeAgyModeOutcome, probeAgyModeSupport, supportsModeFlag
 * @depends execa, ./agy-mode-probe-store, ./pty/agy-pty-spawn, ./pty/agy-version
 */
import { execa } from "execa";
import { persistProbeOutcome, readCachedProbeOutcome } from "./agy-mode-probe-store.js";
import { agyChildEnv, agyExePath } from "./pty/agy-pty-spawn.js";
import { probeAgyVersion } from "./pty/agy-version.js";

const HELP_FLAG = "--help";
const PROBE_TIMEOUT_MS = 8_000;
// A flag token: whitespace/line-start before it, so this never matches a substring inside a longer
// flag name or a prose mention of "mode" in a description line.
const MODE_FLAG_PATTERN = /(?:^|\s)--mode\b/;

/** Pure: does this `agy --help` text advertise a `--mode` flag. No I/O — trivially unit-testable. */
export function supportsModeFlag(helpText: string): boolean {
  return MODE_FLAG_PATTERN.test(helpText);
}

/** D-0: the probe's first-class result. "unsupported" means the help text was genuinely READ and
 *  the flag is genuinely absent — never conflated with "probe-failed" (spawn error, empty output,
 *  timeout), which means the install's support is UNKNOWN, not confirmed lacking. Only "supported"/
 *  "unsupported" are cache-worthy (R3) — a probe-failed result is never persisted. */
export type ModeProbeOutcome =
  | { readonly outcome: "supported" }
  | { readonly outcome: "unsupported" }
  | { readonly outcome: "probe-failed"; readonly reason: string };

let cachedOutcome: ModeProbeOutcome | undefined;
let pending: Promise<ModeProbeOutcome> | undefined;

/**
 * D-0: the cached, once-per-session capability check's first-class outcome (supported / unsupported /
 * probe-failed with a reason) — the ONE source both the boolean-facing accessors below and
 * chat-tui-mount.ts's boot notice project from, so the two can never drift into disagreeing stories
 * about WHY --mode isn't being passed.
 */
export async function probeAgyModeOutcome(): Promise<ModeProbeOutcome> {
  if (cachedOutcome !== undefined) {
    return cachedOutcome;
  }
  pending ??= runAndParse();
  cachedOutcome = await pending;
  return cachedOutcome;
}

/**
 * The cached, once-per-session capability check, projected to a boolean for the argv-building call
 * sites (agy.ts's resolveAgyModeArg already treats "not confirmed true" as the safe default regardless
 * of WHY — a probe failure and a confirmed absence are the SAME "never pass the flag" answer there;
 * only the boot notice's WORDING needs the 3-way distinction, via probeAgyModeOutcome above). The real
 * per-turn dispatch path (agy.ts's executeAgy) always awaits this BEFORE building argv, so a live turn
 * never races the probe.
 */
export async function probeAgyModeSupport(): Promise<boolean> {
  const result = await probeAgyModeOutcome();
  return result.outcome === "supported";
}

/** Synchronous best-effort read of the LAST RESOLVED probe value, projected to boolean — undefined
 *  when the probe has not settled yet this session. For the synchronous buildAgyCommand introspection
 *  path (used by the temporal build pillar via registry.ts, which never awaits): "not yet known" is
 *  treated as unsupported by its caller, the same safe default as a confirmed-unsupported probe. */
export function cachedAgyModeSupport(): boolean | undefined {
  if (cachedOutcome === undefined) {
    return undefined;
  }
  return cachedOutcome.outcome === "supported";
}

// R3: a good probe survives reboots — the agy VERSION (agy-version.ts's own, much cheaper, separately
// cached probe) is the OTHER half of the cache key alongside the binary path. A path-or-version
// mismatch (a different install, an upgrade) forces a fresh probe rather than serving a stale answer;
// an UNKNOWN version (agy-version.ts's own documented failure fallback) skips the cache entirely —
// there is nothing safe to key a persisted write on either.
async function runAndParse(): Promise<ModeProbeOutcome> {
  const agyPath = agyExePath();
  const agyVersion = await probeAgyVersion();
  if (agyVersion !== undefined) {
    const cached = readCachedProbeOutcome(agyPath, agyVersion);
    if (cached !== undefined) {
      return { outcome: cached };
    }
  }
  const outcome = await spawnWithRetry();
  if (agyVersion !== undefined && outcome.outcome !== "probe-failed") {
    persistProbeOutcome(agyPath, agyVersion, outcome.outcome);
  }
  return outcome;
}

// R3 (referee-confirmed cause: CPU-oversubscription / cold first-touch stalls, NOT env construction):
// a TIMEOUT retries exactly once before declaring probe-failed — a one-off stall must not cost the
// whole boot's mode support. A non-timeout failure (ENOENT, a genuinely missing binary) is NEVER
// retried: it cannot succeed on a second attempt, so retrying only doubles the wait for the same answer.
// gate-l5-mandates' G2 check is a local, per-call-site heuristic (a `try {` within 5 lines behind, or
// `reject:false` within 30 ahead) — it cannot see a guard one function away. The two attempts below
// used to share a `spawnOnce()` helper whose OWN execa() call had no LOCAL guard even though both real
// callers caught it; that passed the gate as a false negative once (R3), then correctly started
// failing it once the gate itself was actually run end-to-end (not masked by a piped exit code) — so
// the execa() call now sits directly inside each try{}, matching what a reader sees at a glance.
async function spawnWithRetry(): Promise<ModeProbeOutcome> {
  try {
    return parseSpawnResult(await execa(agyExePath(), [HELP_FLAG], agySpawnOptions()));
  } catch (error) {
    if (!isTimeoutError(error)) {
      return { outcome: "probe-failed", reason: errorReason(error) };
    }
    try {
      return parseSpawnResult(await execa(agyExePath(), [HELP_FLAG], agySpawnOptions()));
    } catch (retryError) {
      // Still failing after the retry — a genuine persistent failure, surfaced honestly (never
      // retried a second time, and never persisted by the caller since outcome === "probe-failed").
      return { outcome: "probe-failed", reason: errorReason(retryError) };
    }
  }
}

// `as const` keeps every literal field (extendEnv/shell/stdin/stdout/stderr/windowsHide) at its exact
// literal type instead of widening to `boolean`/`string` — execa's Options type requires the literal
// ("pipe", not any string) for stdout/stderr. env is re-read fresh on every call (agyChildEnv() is not
// itself const-folded), matching the pre-inline behavior of a fresh env snapshot per spawn attempt.
function agySpawnOptions() {
  return {
    env: agyChildEnv(),
    extendEnv: false,
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  } as const;
}

// D-0: parse BOTH streams — agy's real --help text renders on stderr on this install (live-verified:
// `agy --help 2>$null` returns length 0, exit 0; the flag list only appears under `2>&1`), so a
// stdout-only read is silently blind to it. A newline join keeps MODE_FLAG_PATTERN's `\s`-boundary
// matching correct regardless of which stream (or both) actually carries the flag.
function parseSpawnResult(result: {
  readonly stdout: string;
  readonly stderr: string;
}): ModeProbeOutcome {
  const combined = `${result.stdout}\n${result.stderr}`;
  return supportsModeFlag(combined) ? { outcome: "supported" } : { outcome: "unsupported" };
}

// execa v9's ExecaError carries a genuine `timedOut: boolean` (node_modules/execa/lib/return/result.js).
// Duck-typed rather than `instanceof ExecaError` so this also recognizes plain-Error-shaped timeout
// mocks in tests, without requiring ExecaError as an import dependency.
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { timedOut?: unknown }).timedOut === true
  );
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
