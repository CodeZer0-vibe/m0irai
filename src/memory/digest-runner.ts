/**
 * @file src/memory/digest-runner.ts
 * @purpose The digest PROCESS orchestration (D1/D2). `spawnDetachedDigest` is the ONE trigger the room close
 *   path calls; `bootCatchUp` schedules one per on-disk session (minus the attached one, digested on close)
 *   and returns immediately, so no open is ever gated on a model call. Both fork the compiled entry beside
 *   this file — same directory, same extension as this module — through `process.execPath` with the PARENT
 *   runtime flags inherited, so the packaged host forks plain Node and a loader-started host forks a
 *   loader-started child. No TypeScript runtime is named anywhere here. See createDetachedSpawn for A6.
 * @exports DigestRequest, DigestSpawn, DigestSpawnOutcome, DetachedChild, DigestSpawnImpl, DigestSpawnPlan, BootCatchUpRequest, digestChildEnv, digestEntryPath, digestSpawnArgs, createDetachedSpawn, spawnDetachedDigest, bootCatchUp
 * @depends node:child_process, node:fs, node:os, node:path, node:url, ../chat/session-store, ../shared/child-env, ./digest-failsafe
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions } from "../chat/session-store.js";
import { childEnv } from "../shared/child-env.js";
import { recordDigestCatastrophe } from "./digest-failsafe.js";

/** Everything the detached digest entry needs — all resolved by the parent so the child makes no git call. */
export interface DigestRequest {
  readonly sessionId: `chat-${string}`;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly projectId: string;
}

/**
 * What the parent can honestly claim it did with the digest — the word the close record carries in its
 * `digest=` field. `requested`: a detached child was forked from THIS process. `handed-off`: a durable
 * request was written for the process outside this one's job object to spawn instead (F10, see
 * digest-handoff.ts). Every seam names one, including the injected test doubles: this word is copied into
 * a durable record, so the alternative is a record that carries the caller's guess.
 */
export type DigestSpawnOutcome = "requested" | "handed-off";

/** The spawn seam (injected in tests to assert the request; the default forks a real detached process).
 *  It always NAMES its outcome: the close record repeats that word, so a seam that said nothing would put a
 *  guess in a durable record. */
export type DigestSpawn = (request: DigestRequest) => DigestSpawnOutcome;

/** The child handle the process-spawn seam returns: enough to hear how it failed, and to detach. */
export interface DetachedChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  unref(): unknown;
}

/** The process-spawn seam itself, injected so a test can make a spawn fail the way the OS makes it fail. */
export type DigestSpawnImpl = (
  command: string,
  args: readonly string[],
  options: DigestSpawnPlan["options"],
) => DetachedChild;

/** What boot catch-up needs: the project, and the session it must NOT digest (see bootCatchUp). */
export interface BootCatchUpRequest {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly projectId: string;
  readonly exclude?: `chat-${string}`;
}

const SELF = fileURLToPath(import.meta.url);
const ENTRY = path.join(path.dirname(SELF), `digest-entry${path.extname(SELF)}`);

/** The absolute path of the entry this runner forks — its own sibling, carrying its own extension. */
export function digestEntryPath(): string {
  return ENTRY;
}

/**
 * Triggers a digest for one session — the SAME call every close trigger makes (D2). Fire-and-forget: the
 * default spawn detaches + unrefs the child so the parent returns instantly (D1) and the child journal write
 * lands after the parent has exited.
 */
export function spawnDetachedDigest(
  request: DigestRequest,
  spawnFn: DigestSpawn = realSpawn,
): DigestSpawnOutcome {
  return spawnFn(request);
}

// DECISION-3 (childEnv SSOT, codex MT3b): the non-secret ZER0_* keys the child reads — the debug switch, the
// test-only extractor fake, and the explicit trace destination. The dev-loader tsconfig variable rides along
// ONLY when the PARENT already carries it: a host started under a module loader must hand its tsconfig down,
// and the packaged host (which has no such variable) must not invent one. Everything else the child needs
// (PATH/APPDATA/…) comes from childEnv; provider API keys are deliberately absent.
const CHILD_PASSTHROUGH: readonly string[] = [
  "ZER0_DEBUG",
  "ZER0_DIGEST_FAKE",
  "ZER0_CHAT_TRACE",
  "TSX_TSCONFIG_PATH",
  // FL-172: the hermetic refusal MUST reach the child, because this is the ONE child that runs OUR
  // code — its inner codex-exec seam (digest-extractor.ts assertNotHermetic) reads the flag in the
  // CHILD process, and without this passthrough a real codex could run under a hermetic harness
  // whenever ZER0_DIGEST_FAKE is unset. (Correction 2026-08-25: an earlier wording blamed this hole
  // for a live .claude.json — that was a stale dist proving an unguarded probe; no claude spawn
  // exists in src/memory. The hole is real; that incident was not its work.)
  "ZER0_HERMETIC",
];

/**
 * The detached child COMPLETE environment (node:child_process spawn REPLACES env when set). Subscription-
 * first: the childEnv allowlist (no provider API keys) + the node runtime keys + the passthrough the child
 * reads — never the full process.env (DECISION-3: forwarding provider keys would breach the env trust
 * boundary and flip the inner codex-exec to per-call API billing).
 */
export function digestChildEnv(): Record<string, string> {
  const env: Record<string, string> = { ...childEnv(), NODE_NO_WARNINGS: "1" };
  for (const key of CHILD_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** The full spawn contract for the detached digest child — pure + exported so a test asserts it (cwd, env,
 *  detached flags, argv) with NO real process. `argv` are the args after process.execPath. */
export interface DigestSpawnPlan {
  readonly argv: readonly string[];
  readonly options: {
    readonly detached: true;
    readonly stdio: "ignore";
    readonly windowsHide: true;
    readonly cwd: string;
    readonly env: Record<string, string>;
  };
}

/**
 * Builds the detached child argv + spawn options. INVARIANT (MT3e): the child CWD is os.tmpdir(), NEVER the
 * project root. Windows holds a process CWD open for its whole lifetime, so a repoRoot cwd would EBUSY-block
 * rmdir(repoRoot) until the child exits — hitting a user who deletes their project mid-digest AND the test
 * teardown (the earlier rmSync-retry only RACED that hold; this REMOVES it). Every path the child needs is
 * passed via argv (sessionId/repoRoot/dbPath/projectId); the trace folder resolves against the repoRoot ARG
 * (activateDebugSession baseDir), not cwd — so the child touches nothing under the project through its CWD.
 *
 * The child inherits `process.execArgv`, so whatever runtime flags started the PARENT start the child too:
 * empty in the packaged host, a module loader when a test or a developer started the host with one.
 */
// The child inherits the parent's runtime flags so a loader-started host forks a loader-started child — but
// NEVER a debugger. `--inspect-brk` would leave this detached background child paused on its first line
// forever, with no console anyone will ever attach to, and an inherited fixed debug port collides with
// itself the moment boot catch-up forks more than one. Everything else is kept: the loader `--import`
// carries an absolute file URL, so the child's temp cwd cannot break it.
const DEBUGGER_FLAG = /^--(?:inspect|debug)/u;

function inheritedExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index] ?? "";
    if (!DEBUGGER_FLAG.test(flag)) {
      kept.push(flag);
      continue;
    }
    // A separated value (`--inspect-port 0`) is its own token. Dropping the flag and leaving the value
    // behind would shift the entry out of position and the child would try to run the port number.
    const next = execArgv[index + 1];
    if (next !== undefined && !next.startsWith("-")) index += 1;
  }
  return kept;
}

export function digestSpawnArgs(request: DigestRequest, entry: string = ENTRY): DigestSpawnPlan {
  // The child cwd is tmpdir() (hold invariant), so dbPath MUST be absolute or it resolves against tmpdir -> the wrong DB (dogfood bug #1).
  const dbPath = path.resolve(request.repoRoot, request.dbPath);
  return {
    argv: [
      ...inheritedExecArgv(process.execArgv),
      entry,
      request.sessionId,
      request.repoRoot,
      dbPath,
      request.projectId,
    ],
    options: {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: tmpdir(),
      env: digestChildEnv(),
    },
  };
}

/**
 * Builds the real detached fork against a NAMED entry file (production binds the sibling entry; a falsifier
 * binds an absent one). A6: the entry is a separate compiled file, so a broken package or a partial copy can
 * leave it missing — and a spawn against a missing entry exits non-zero with its diagnostics thrown away by
 * stdio:"ignore", i.e. silently no memory, forever. So the spawn checks first and records the same durable,
 * classified failure the child would have recorded (scratch row, else .zer0/journal/digest-failures.log).
 * Byte-silent, never throws, and never blocks the close: the caller just gets a plain return.
 *
 * @param entry - absolute path of the entry module to fork
 * @param spawnImpl - the process-spawn seam; a test injects one that fails the way the OS would
 */
export function createDetachedSpawn(
  entry: string,
  spawnImpl: DigestSpawnImpl = spawn,
): DigestSpawn {
  return (request: DigestRequest): DigestSpawnOutcome => {
    const { argv, options } = digestSpawnArgs(request, entry);
    const ctx = { ...request, dbPath: path.resolve(request.repoRoot, request.dbPath) };
    if (!existsSync(entry)) {
      recordDigestCatastrophe(
        ctx,
        new Date().toISOString(),
        new Error(`digest entry is missing: ${entry}`),
      );
      return "requested";
    }
    const child = spawnImpl(process.execPath, [...argv], options);
    // R1: Node raises `error` ON THE CHILD when the process could not be spawned at all (EAGAIN/ENOMEM/
    // EPERM — anti-virus interference, process-table pressure). An EventEmitter `error` with no listener is
    // an UNCAUGHT exception, raised asynchronously on the close path where detach's try/catch is long gone:
    // the host would die with a stack on stderr instead of recording the failure, taking the shutdown exit
    // code with it. Recording it keeps the same contract as every other digest failure — durable,
    // classified, byte-silent, no throw. Attached before unref(); a listener never holds the loop open.
    child.once("error", (error: Error) => {
      recordDigestCatastrophe(ctx, new Date().toISOString(), error);
    });
    // A child that STARTS and then dies before it can record anything — a missing transitive import, an
    // unreadable entry, an out-of-memory kill — exits nonzero with its diagnostics thrown away by
    // stdio:"ignore". Nothing else would ever notice. Scope, stated plainly: this listener only covers the
    // parent's remaining lifetime, so it sees boot catch-up children in full but a close child only while
    // the host is still alive; the packaged-entry smoke in Phase 6 is what covers the rest.
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) return;
      recordDigestCatastrophe(
        ctx,
        new Date().toISOString(),
        new Error(`digest child exited ${signal ?? String(code)} before recording anything`),
      );
    });
    child.unref();
    return "requested";
  };
}

const realSpawn: DigestSpawn = createDetachedSpawn(ENTRY);

// Boot children each re-open the DB (re-running the migration writes). Firing all at once deadlocks their
// deferred migration transactions (SQLITE_BUSY), so the spawns are STAGGERED — one immediately, the rest on
// a rising timer — so their opens barely overlap. The entry SQLITE_BUSY retry is the backstop for residual
// contention. The stagger timers are unref'd so they never keep the parent alive past its own lifetime.
const STAGGER_MS = 250;

/**
 * Boot catch-up (D2): schedules a detached digest for every on-disk session EXCEPT the one the caller is
 * attaching, and RETURNS IMMEDIATELY with the count — no transcript read, no model call, so the morning open
 * is never gated. The attached session is excluded because its close digests it from a complete transcript;
 * digesting it here would only race that close on one session, and a crash that skips the close is recovered
 * by the NEXT boot (this same call). The spawns are staggered (STAGGER_MS) to prevent a concurrent-open
 * deadlock. Each digest is idempotent (the watermark set), so scheduling one per session is safe.
 *
 * @param request - the project identity plus the session to exclude
 * @param spawnFn - the spawn seam; defaults to the real detached fork
 * @returns the number of sessions a digest was scheduled for
 */
export async function bootCatchUp(
  request: BootCatchUpRequest,
  spawnFn: DigestSpawn = realSpawn,
): Promise<number> {
  const { repoRoot, dbPath, projectId, exclude } = request;
  const sessions = (await listSessions(repoRoot)).filter((sessionId) => sessionId !== exclude);
  sessions.forEach((sessionId, index) => {
    const digest: DigestRequest = { sessionId, repoRoot, dbPath, projectId };
    if (index === 0) {
      spawnDetachedDigest(digest, spawnFn);
      return;
    }
    const timer = setTimeout(() => spawnDetachedDigest(digest, spawnFn), index * STAGGER_MS);
    timer.unref();
  });
  return sessions.length;
}
