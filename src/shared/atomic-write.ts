/**
 * @file src/shared/atomic-write.ts
 * @purpose Own the Windows file-sharing policy: replace a whole file by temp plus rename, and retry the sharing failures both writing and reading hit.
 * @exports AtomicWriteOptions, AtomicWriteSyncOptions, AtomicWriteSyncFs, AtomicWriteSyncResult, writeFileAtomic, writeFileAtomicSync, isTransientReplaceError, retryOnSharingViolation, SHARING_RETRY_BUDGET_MS
 * @depends node:crypto, node:fs, node:fs/promises, node:path
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Windows refuses to replace a file while ANY handle to it is open. Measured on this repo's own Node
 * (v24.18.0, win32, 2026-09-06): `unlink` of a file held by an open read handle SUCCEEDS (libuv passes
 * FILE_SHARE_DELETE), but `rename` onto that same destination fails EPERM every time — libuv's Windows
 * rename is MoveFileExW, whose replace path does not share the destination. The failure clears the
 * instant the reader closes, so the only correct answer is a bounded retry, never an unlink-first
 * (which would destroy the very file this module exists to protect).
 *
 * The budget is measured, not guessed. Against a reader repeating a 128-file listing pass with no idle
 * gap at all, 360 replacements over four scenarios produced ZERO failures with this budget, waiting
 * p50 43 ms / p95 89 ms / max 200 ms. The same runs with a 315 ms budget failed 9.5% of the time under
 * a single reader, so the headroom above the observed max is deliberate and roughly 10x.
 */
export const SHARING_RETRY_BUDGET_MS = 2_000;
const REPLACE_BACKOFF_START_MS = 5;
const REPLACE_BACKOFF_STEP_MS = 5;
const REPLACE_BACKOFF_CAP_MS = 50;

/** Replace failures that a later attempt can still win: another handle holds the destination. */
const TRANSIENT_REPLACE_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface AtomicWriteOptions {
  /** Create the destination's directory first. Off by default: most callers own their directory. */
  readonly ensureDirectory?: boolean;
  /**
   * Flush the bytes to the storage device before the rename. Node documents this exactly once, as
   * `fsPromises.writeFile`'s `flush` option: "If all data is successfully written to the file, and
   * flush is true, filehandle.sync() is used to flush the data." On by default — a rename that
   * publishes unflushed bytes buys nothing over the in-place write it replaces.
   */
  readonly flush?: boolean;
  /** Total time the replace may spend retrying a transient sharing failure. */
  readonly replaceBudgetMs?: number;
}

export interface AtomicWriteSyncFs {
  readonly mkdirSync: typeof mkdirSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly renameSync: typeof renameSync;
}

const REAL_SYNC_FS: AtomicWriteSyncFs = { mkdirSync, writeFileSync, renameSync };

export interface AtomicWriteSyncOptions {
  readonly ensureDirectory?: boolean;
  readonly flush?: boolean;
  /** Injected only so a test can force the rename to throw; production always uses the real fs. */
  readonly fs?: AtomicWriteSyncFs;
}

export type AtomicWriteSyncResult =
  | { readonly outcome: "written" }
  | { readonly outcome: "failed"; readonly reason: string };

export function isTransientReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_REPLACE_CODES.has(code);
}

/**
 * The temp file is a SIBLING of the destination, never in the system temp directory: a rename across
 * volumes is a copy, which is exactly the torn write this module prevents. The name carries both the
 * pid and a uuid, so two writers in one process racing on one destination cannot collide on it.
 */
function temporaryPathFor(target: string): string {
  return `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
}

/** Text for the JSON files, bytes for the content-addressed blob store. */
export type AtomicWriteData = string | Uint8Array;

function assertWritable(target: string, data: AtomicWriteData): void {
  if (target.length === 0) throw new Error("atomic write needs a destination path");
  if (path.dirname(target) === target)
    throw new Error(`atomic write cannot replace a filesystem root: ${target}`);
  if (typeof data !== "string" && !ArrayBuffer.isView(data))
    throw new Error(`atomic write needs string or byte content for ${target}`);
}

/** `encoding` is meaningful for text and ignored for bytes, so it is only sent for text. */
function encodingFor(data: AtomicWriteData): BufferEncoding | undefined {
  return typeof data === "string" ? "utf8" : undefined;
}

function replaceFailure(target: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `could not replace ${target}: ${reason}. The previous file is unchanged; retry the write.`,
    { cause },
  );
}

async function replaceWithRetry(
  temporary: string,
  target: string,
  budgetMs: number,
): Promise<void> {
  try {
    await retryOnSharingViolation(() => rename(temporary, target), budgetMs);
  } catch (error) {
    throw replaceFailure(target, error);
  }
}

/**
 * Runs `operation` until it stops failing with a Windows sharing violation, or the budget runs out.
 *
 * A held handle blocks READING a file exactly as it blocks replacing one, and it clears the same way —
 * so the classifier and the budget belong to both paths. Announcing a room damaged because a backup
 * agent had its transcript open for 40 ms, while the writer beside it retried the identical error code
 * for two seconds, was the inconsistency this exists to remove. Every other error propagates at once:
 * an ENOENT is an answer, not a wait.
 */
export async function retryOnSharingViolation<T>(
  operation: () => Promise<T>,
  budgetMs: number = SHARING_RETRY_BUDGET_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let backoff = REPLACE_BACKOFF_START_MS;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientReplaceError(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(REPLACE_BACKOFF_CAP_MS, backoff + REPLACE_BACKOFF_STEP_MS);
    }
  }
}

/**
 * Writes `data` as the whole new content of `target`. The destination is never opened for writing, so
 * it holds either its previous bytes or the complete new ones — a crash, a full disk, or a refused
 * replace all leave the previous file byte-identical.
 *
 * Durability is scoped to what Node documents: the temp file's own data is flushed before the replace.
 * Node documents no API for flushing the DIRECTORY entry, so this makes no claim that the replace
 * itself survives a power cut — only that no reader ever observes a partial file.
 */
export async function writeFileAtomic(
  target: string,
  data: AtomicWriteData,
  options: AtomicWriteOptions = {},
): Promise<void> {
  assertWritable(target, data);
  if (options.ensureDirectory === true) await mkdir(path.dirname(target), { recursive: true });
  const temporary = temporaryPathFor(target);
  try {
    // "wx" fails rather than adopting a file already at this path: a temp we did not create is not ours.
    await writeFile(temporary, data, {
      encoding: encodingFor(data),
      flag: "wx",
      flush: options.flush ?? true,
    });
    await replaceWithRetry(temporary, target, options.replaceBudgetMs ?? SHARING_RETRY_BUDGET_MS);
  } finally {
    // Best-effort, and deliberately last: a cleanup failure must never mask the real error above.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * The synchronous twin, for the small settings files whose owners are synchronous. It does NOT retry a
 * transient replace failure: the only synchronous wait available is a busy loop, which on Windows
 * starves the very handle-holder it is waiting for (the reason graceful-fs's own retry yields to the
 * scheduler). These files are written on operator actions, not per turn, and nothing reads them in a
 * loop, so a single attempt matches their real contention.
 *
 * It NEVER throws — the guards are inside the try with everything else. `lane-availability-store.ts`
 * calls this with no try/catch of its own because a durability failure must not take down the dispatch
 * that triggered it, so a guard that threw would be the one way this helper could do exactly that.
 */
export function writeFileAtomicSync(
  target: string,
  data: AtomicWriteData,
  options: AtomicWriteSyncOptions = {},
): AtomicWriteSyncResult {
  const fs: AtomicWriteSyncFs = options.fs ?? REAL_SYNC_FS;
  const temporary = temporaryPathFor(target);
  try {
    assertWritable(target, data);
    if (options.ensureDirectory === true) fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, data, {
      encoding: encodingFor(data),
      flag: "wx",
      flush: options.flush ?? true,
    });
    fs.renameSync(temporary, target);
    return { outcome: "written" };
  } catch (error) {
    // The real rmSync, never the injected one: a test swaps renameSync to force a failure, and its
    // genuinely-on-disk temp file still has to go. Best-effort — it never masks the reason returned.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best-effort; the caller's reason below is the one that matters.
    }
    // The RAW cause, not the wrapped sentence the async path returns. These callers already compose
    // their own operator-facing note from this string and one of them pins it exactly, so the helper
    // hands back what happened and lets the owner say what it means.
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
