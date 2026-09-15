/**
 * @file src/memory/digest-entry.ts
 * @purpose The DETACHED digest entry (D1/D2) - the child spawnDetachedDigest forks: argv = sessionId,
 *   repoRoot, dbPath, projectId. Settles on the watermark over a READ-ONLY handle first (FL-074), then
 *   opens the memory DB for write, runs one digest pass, and exits. Emits ZERO stdout/stderr (under
 *   ZER0_DEBUG, a memory.trace sink into .zer0/debug; else none). A busy DB is waited out against a
 *   MONOTONIC wall-clock budget; only a genuinely exhausted budget records a catastrophe, and that record
 *   names how long the child waited. In src, not scripts, because it SHIPS beside digest-runner.
 * @exports DigestEntryArgs, DigestEntryOptions, parseDigestArgs, runDigestEntry
 * @depends better-sqlite3, node:path, node:perf_hooks, node:process, node:url, ../chat/chat-trace, ../chat/events, ../chat/session-store, ../evidence/db, ./digest, ./digest-extractor, ./digest-failsafe, ./journal-store, ../shared/debug-mode
 */
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { attachTraceSink } from "../chat/chat-trace.js";
import { ChatEventBus } from "../chat/events.js";
import { loadSession } from "../chat/session-store.js";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { activateDebugSession, debugEnabled, resolveTraceSink } from "../shared/debug-mode.js";
import { type DigestDispatch, createCodexDispatch } from "./digest-extractor.js";
import {
  type DigestRunCtx,
  acquireDigestLock,
  recordDigestCatastrophe,
  releaseDigestLock,
} from "./digest-failsafe.js";
import { readWatermarkSet, runDigestPass } from "./digest.js";
import type { MemoryTraceBus } from "./journal-store.js";

const BACKOFF_MS = 60;

// THE BUDGET, as arithmetic - because the old ladder's did not survive contact with SQLite. openMemoryDb
// does its schema and migration work inside DEFERRED transactions (evidence/db.ts:277), and SQLite
// deliberately does NOT invoke the busy handler on a read-to-write promotion it could deadlock on
// ("If SQLite determines that invoking the busy handler could result in a deadlock, it will go ahead and
// return SQLITE_BUSY to the application instead of invoking the busy handler" - sqlite.org/c3ref/
// busy_handler.html). So busy_timeout=5000 (evidence/db.ts:266) never runs on this path and every attempt
// fails in ~3ms (measured). The old 10-attempt ladder therefore spent its entire budget on backoff -
// 60ms x (1..9) plus jitter = 2.7-3.2s, not the ~50s (10 attempts x a 5s wait) its own comment assumed.
// FL-074 is exactly that gap: the child gave up 2.7s into another host's legitimate write burst. The budget
// is now WALL-CLOCK, so it means what it says whatever an individual attempt costs. 30s is well under the
// ~50s the old code intended and far over any contention window observed, and it is cheap: this child is
// detached and unwatched, so a long wait holds nothing but its own single-flight lease (TTL 300s).
const BUSY_BUDGET_MS = 30_000;

/** The four positional arguments the parent passes; identical to the catastrophe recorder context. */
export type DigestEntryArgs = DigestRunCtx;

/** Caller-tunable limits. `busyBudgetMs` is how long the child waits out a busy DB before it gives up and
 *  records a catastrophe. Production takes the default; a test shortens it so the exhausted path can be
 *  proven against a REAL held write lock in under a second instead of a real half-minute. */
export interface DigestEntryOptions {
  readonly busyBudgetMs?: number;
}

// No repoRoot: MT3f made createCodexDispatch cwd-neutral (tmpdir), so the extractor no longer needs the repo
// path - passing it would only risk re-introducing the CWD hold. The extraction prompt is self-contained.
function resolveDispatch(): DigestDispatch {
  const fake = process.env.ZER0_DIGEST_FAKE;
  return fake !== undefined && fake.length > 0 ? async () => fake : createCodexDispatch();
}

// ZER0_DEBUG on -> a memory.trace sink into the session .zer0/debug folder; off -> undefined (no trace
// bytes). repoRoot (MT3e): the debug folder roots under the repoRoot ARG, not process.cwd() - the child cwd
// is os.tmpdir() (it must not hold the project root open), so the destination comes from argv instead.
function resolveTrace(sessionId: string, repoRoot: string): MemoryTraceBus | undefined {
  if (!debugEnabled()) {
    return undefined;
  }
  activateDebugSession(sessionId, repoRoot);
  const tracePath = resolveTraceSink(process.env.ZER0_CHAT_TRACE);
  if (tracePath === undefined || tracePath.length === 0) {
    return undefined;
  }
  const bus = new ChatEventBus();
  attachTraceSink(bus, tracePath);
  return bus;
}

// better-sqlite3 puts the EXTENDED result code in .code (node_modules/better-sqlite3/src/
// better_sqlite3.cpp:404 calls sqlite3_extended_errcode), and every extended busy code shares the
// SQLITE_BUSY prefix (SQLITE_BUSY_SNAPSHOT / _RECOVERY / _TIMEOUT) while reporting the same "database is
// locked" message. An === test on the primary name therefore reads three retryable collisions as fatal.
// This is the predicate ledger.ts:96 and lane-state.ts:126 already use; this file was the one that diverged.
function isBusy(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED");
}

// An exhausted budget must SAY what it spent. FL-074's durable record read only "database is locked", so the
// finding had to be reconstructed from a retained temp root; a reader could not tell a child that gave up
// instantly from one that waited half a minute. The wait and the code now travel with the message.
function busyExhausted(err: unknown, waitedMs: number): Error {
  const detail = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && "code" in err ? String((err as { code?: unknown }).code) : "unknown";
  return new Error(`busy-exhausted-after-${waitedMs}ms (${code}): ${detail}`, { cause: err });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunArgs {
  readonly sessionId: `chat-${string}`;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly projectId: string;
  readonly dispatch: DigestDispatch;
  readonly now: string;
  readonly trace: MemoryTraceBus | undefined;
  readonly busyBudgetMs: number;
}

/**
 * The redundant-child gate (FL-074). One session can get two close triggers, so the second child routinely
 * has nothing left to do - yet openMemoryDb WRITES on every open (schema.sql:9 is an INSERT, and the
 * migration transactions promote to a write), so that child contended for the file write lock anyway and,
 * when a live host legitimately held it, recorded a catastrophe for a session whose facts were already
 * durable.
 *
 * The question is asked on a READ-ONLY handle instead: WAL readers never take the write lock and do not
 * block on a writer (measured at 3ms while a second connection held BEGIN IMMEDIATE), so this gate cannot
 * become the collision it exists to avoid.
 *
 * Race-honest by construction. It applies the SAME predicate as the pass (completed AND not in the
 * watermark - digest.ts:64) through the SAME reader, it runs before the write open, and its only possible
 * action is to decline to work. It therefore cannot re-introduce the lost update that the single-flight
 * lease and the in-transaction watermark re-read (digest.ts:194) exist to prevent: that hazard requires two
 * children that both WRITE, and this gate only ever removes a writer, never adds one. Both later checks are
 * untouched, so the ordering is three monotonically stricter reads of one predicate. It fails OPEN on any
 * doubt - an unreadable transcript or DB falls through to the normal path, which reports it as it always did.
 */
async function alreadySettled(ctx: DigestEntryArgs): Promise<boolean> {
  let db: Db | undefined;
  try {
    const session = await loadSession(ctx.sessionId as `chat-${string}`, ctx.repoRoot);
    db = new Database(ctx.dbPath, { readonly: true, fileMustExist: true });
    const digested = readWatermarkSet(db, ctx.projectId, ctx.sessionId);
    return session.messages.every((m) => m.status !== "completed" || digested.has(m.id));
  } catch {
    return false; // fail open: a doubtful gate must never be the reason a digest is skipped
  } finally {
    db?.close();
  }
}

// Opens + digests, waiting out a busy DB against the MONOTONIC budget (performance.now, so a system clock
// step cannot lengthen or truncate the wait). Idempotent via the watermark, so a retry never
// double-processes. Only two ways out: the pass ran, or an error that is not a survivable collision.
async function runWithRetry(args: RunArgs): Promise<void> {
  const { dbPath, trace, busyBudgetMs, ...pass } = args;
  const startedAt = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    let db: Db | undefined;
    try {
      db = openMemoryDb(dbPath);
      await runDigestPass({ db, ...pass, ...(trace ? { trace } : {}) });
      closeDb(db);
      return;
    } catch (err) {
      if (db !== undefined) closeDb(db);
      if (!isBusy(err)) {
        throw err;
      }
      const waitedMs = Math.round(performance.now() - startedAt);
      const remainingMs = busyBudgetMs - waitedMs;
      if (remainingMs <= 0) {
        throw busyExhausted(err, waitedMs);
      }
      // Jittered backoff: children that collided must NOT retry in lockstep (a thundering herd re-collides)
      // - the random component de-synchronises them so they converge. Never overshoot what is left.
      const backoffMs = BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * BACKOFF_MS);
      await delay(Math.min(backoffMs, remainingMs));
    }
  }
}

/**
 * Validates the four positional arguments. A malformed invocation has NO durable target (no db, no session
 * to key a record on), so it returns undefined and the caller emits nothing at all.
 *
 * @param args - process.argv.slice(2)
 * @returns the validated run context, or undefined when the invocation is malformed
 */
export function parseDigestArgs(args: readonly string[]): DigestEntryArgs | undefined {
  const [sessionId, repoRoot, dbPath, projectId] = args;
  if (
    sessionId === undefined ||
    repoRoot === undefined ||
    dbPath === undefined ||
    projectId === undefined ||
    !sessionId.startsWith("chat-")
  ) {
    return undefined; // malformed invocation - no durable target, emit nothing
  }
  return { sessionId, repoRoot, dbPath, projectId };
}

function resolveBudget(options: DigestEntryOptions): number {
  const budget = options.busyBudgetMs ?? BUSY_BUDGET_MS;
  if (!Number.isFinite(budget) || budget <= 0) {
    const received = String(options.busyBudgetMs);
    throw new Error(
      `digest busy budget must be a positive finite number of ms, received ${received} - pass a valid busyBudgetMs or omit it for the ${BUSY_BUDGET_MS}ms default`,
    );
  }
  return budget;
}

/**
 * Runs one digest pass for the session named in `args`, under the single-flight lock. Never throws and never
 * writes a byte to stdout/stderr: every fatal path lands as a durable classified record instead (D4/BLOCK-2).
 *
 * @param args - process.argv.slice(2): sessionId, repoRoot, dbPath, projectId
 * @param options - caller-tunable limits; production passes none
 */
export async function runDigestEntry(
  args: readonly string[],
  options: DigestEntryOptions = {},
): Promise<void> {
  const ctx = parseDigestArgs(args);
  if (ctx === undefined) {
    return;
  }
  const now = new Date().toISOString();
  try {
    const busyBudgetMs = resolveBudget(options); // validated before anything durable is touched
    // BLOCK-1b: single-flight - if a LIVE sibling already holds this session digest lock, skip (fail open on
    // any doubt so a needed digest is never lost). Otherwise run under the lock and release it in a finally.
    const lock = acquireDigestLock(ctx.repoRoot, ctx.sessionId, Date.now(), process.pid);
    if (lock === "in-flight") {
      return;
    }
    try {
      // FL-074: settle on the watermark BEFORE opening for write. Inside the lease, so a sibling arriving
      // while we look sees a live holder and skips instead of racing us to the same answer.
      if (await alreadySettled(ctx)) {
        return;
      }
      await runWithRetry({
        sessionId: ctx.sessionId as `chat-${string}`,
        repoRoot: ctx.repoRoot,
        dbPath: ctx.dbPath,
        projectId: ctx.projectId,
        dispatch: resolveDispatch(),
        now,
        trace: resolveTrace(ctx.sessionId, ctx.repoRoot),
        busyBudgetMs,
      });
    } finally {
      if (lock !== "no-lock") {
        releaseDigestLock(lock);
      }
    }
  } catch (err) {
    // BLOCK-2 (no-silent-swallow): a fatal digest (missing transcript, schema drift, an exhausted busy
    // budget, a poisoned DB) must leave a DURABLE record, not vanish - best-effort a classified row,
    // last-resort a log file, but NEVER stdout/stderr (O2). recordDigestCatastrophe is itself no-throw.
    recordDigestCatastrophe(ctx, now, err);
  }
}

// Case-insensitive on win32: the parent builds this path from import.meta.url while a developer or a staged
// copy may invoke it with a differently-cased drive letter, and a mismatch here would make the child exit
// silently having done nothing - the one failure this byte-silent process could never report.
function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? path.resolve(invoked).toLowerCase() === self.toLowerCase()
    : path.resolve(invoked) === self;
}

// Truly-last resort: recordDigestCatastrophe never throws, so this only fires if argv access itself threw. A
// background process must never leak diagnostics - stdout/stderr stay byte-empty on every path.
if (isDirectInvocation()) runDigestEntry(process.argv.slice(2)).catch(() => {});
