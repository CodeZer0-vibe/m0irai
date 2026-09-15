/**
 * @file src/adapters/pty/agy-runner.ts
 * @purpose One-shot ConPTY transport for the Antigravity CLI (agy): given an injected spawn seam,
 *   run agy once, collect stdout to exit, bounded by a turn cap (kill + typed reject), abort-aware,
 *   with conpty-teardown recovery (non-clean exit + stdout present => success, mirroring gemini).
 *   Pure (no node-pty) so the lifecycle is unit-testable with a fake pty; prod spawns via agy-pty-spawn.
 * @exports PtyLike, AgyRunResult, SpawnAgy, RunAgyOptions, runAgyOnce
 * @depends ../../shared/errors, ../agy-output
 */
import { DispatchError } from "../../shared/errors.js";
import { normalizeAgyDiagnostic } from "../agy-output.js";

/** The minimal pty surface the runner drives (node-pty in prod, a fake in tests). */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

/** The collected result of one agy invocation (raw stdout; the adapter strips + parses). */
export interface AgyRunResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Spawn seam: returns a live ConPTY child for `agy <args>` in `cwd`. */
export type SpawnAgy = (cmd: string, args: readonly string[], cwd: string) => PtyLike;

/** Inputs for one bounded agy run. */
export interface RunAgyOptions {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly spawn: SpawnAgy;
}

const AGENT = "gemini";
const TIMEOUT_EXIT = 124;
const ABORT_EXIT = 130;
const FAILURE_EXIT = 1;

/**
 * Runs agy once under an injected ConPTY spawn. Resolves the collected stdout on a clean exit (or a
 * teardown-dirty exit that still produced output); rejects with a typed DispatchError on the turn
 * cap (124), abort (130), or a genuine empty-output failure.
 *
 * @param opts - command, cwd, caller signal, turn-cap ms, and the spawn seam
 * @returns the collected raw stdout + a normalized exit code
 */
export function runAgyOnce(opts: RunAgyOptions): Promise<AgyRunResult> {
  if (opts.signal.aborted) {
    return Promise.reject(
      new DispatchError("agy dispatch aborted before start", AGENT, ABORT_EXIT),
    );
  }
  return new Promise<AgyRunResult>((resolve, reject) => collectAgyTurn(opts, resolve, reject));
}

/** Exit 0 → result. ANY non-zero exit → typed failure with a stdout preview — NEVER mask an agy
 *  error printed to stdout as a successful reply (codex review F3). */
function classifyExit(exitCode: number, buf: string): AgyRunResult | DispatchError {
  if (exitCode === 0) {
    return { exitCode: 0, stdout: buf };
  }
  const preview = normalizeAgyDiagnostic(buf).slice(0, 400);
  const detail = preview.length > 0 ? ` — output: ${preview}` : " with no output";
  return new DispatchError(`agy exited ${exitCode}${detail}`, AGENT, exitCode || FAILURE_EXIT);
}

/** Spawns the child once, returning a typed error instead of throwing (codex review F4). */
function safeSpawn(opts: RunAgyOptions): PtyLike | DispatchError {
  try {
    return opts.spawn(opts.cmd, opts.args, opts.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new DispatchError(`agy spawn failed: ${message}`, AGENT, FAILURE_EXIT);
  }
}

/** Wires the turn-cap / abort / data / exit on a spawned child, settling exactly once. */
function collectAgyTurn(
  opts: RunAgyOptions,
  resolve: (result: AgyRunResult) => void,
  reject: (err: DispatchError) => void,
): void {
  const child = safeSpawn(opts);
  if (child instanceof DispatchError) {
    reject(child);
    return;
  }
  let buf = "";
  let settled = false;
  const settle = (err: DispatchError | undefined, result?: AgyRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    if (err !== undefined) {
      try {
        child.kill();
      } catch {
        /* child already gone */
      }
      reject(err);
    } else if (result !== undefined) {
      resolve(result);
    }
  };
  function onAbort(): void {
    settle(new DispatchError("agy dispatch aborted", AGENT, ABORT_EXIT));
  }
  const timer = setTimeout(
    () => settle(new DispatchError(`agy turn exceeded ${opts.timeoutMs}ms`, AGENT, TIMEOUT_EXIT)),
    opts.timeoutMs,
  );
  opts.signal.addEventListener("abort", onAbort, { once: true });
  child.onData((d) => {
    buf += d;
  });
  child.onExit((event) => {
    const outcome = classifyExit(event.exitCode, buf);
    if (outcome instanceof DispatchError) settle(outcome);
    else settle(undefined, outcome);
  });
}
