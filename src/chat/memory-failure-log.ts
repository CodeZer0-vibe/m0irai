/**
 * @file src/chat/memory-failure-log.ts
 * @purpose The durable, BOUNDED record of every memory-briefing failure — one line per occurrence,
 *   including the repeats the room deliberately does not re-announce, with a cap that cannot be
 *   outgrown and a return value that says whether the write actually landed.
 * @exports MemoryFailureClass, MEMORY_FAILURE_LOG_MAX_BYTES, MEMORY_FAILURE_LOG_KEEP_BYTES,
 *   memoryFailureLogPath, recordMemoryFailure
 * @depends node:fs, node:path, ../shared/room-notice
 *
 * WHY THIS IS ITS OWN FILE. It was four lines inside headless-prompt.ts, and being four lines is how
 * it stayed unbounded and unreadable for as long as it did: nothing owned it, so nothing capped it,
 * nothing rotated it, and its own failure had nowhere to go. It is a durable record with a retention
 * policy, which is a thing, not a helper.
 *
 * WHAT THIS DOES NOT DO. It does not announce. The room announces (once per session per cause, see
 * room-notice-gate.ts); this file's job is that the DETAIL of every occurrence — first and repeat
 * alike — survives on disk for whoever reads the journal afterwards.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RoomNoticeCause, boundRoomNoticeDetail } from "../shared/room-notice.js";

/**
 * The log's classification IS the notice's cause — one vocabulary, so a line on disk and a row on
 * screen name the same thing and a reader never has to translate between two enums that drift.
 */
export type MemoryFailureClass = RoomNoticeCause;

/**
 * THE CAP, AND WHY THIS NUMBER.
 *
 * A line is at most a timestamp, a classification and a detail bounded to 200 code points — call it
 * 1 KiB in the worst UTF-8 case. 64 KiB therefore retains AT LEAST 64 worst-case failures and, at the
 * realistic line width of roughly 80 bytes, several hundred. A single session that produces more than
 * that is not producing diagnostics any more, it is producing a loop, and the newest entries are the
 * ones that describe it. The file is a diagnostic tail, not an archive: nothing reads it
 * programmatically, an operator or an agent opens it after something went wrong, and 64 KiB is what
 * a person can actually page through.
 *
 * Measured against the defect this replaces: 500 failures of 1,000 characters each wrote 520,500
 * bytes and would have kept going. Under this cap the same run ends at 65,536 bytes or less.
 */
export const MEMORY_FAILURE_LOG_MAX_BYTES: number = 64 * 1024;

/**
 * What survives a rotation. Keeping HALF rather than trimming to just under the cap is what stops the
 * rotation from running on nearly every subsequent write: trimming to the cap makes the next line
 * overflow again, turning a bounded log into a read-rewrite of 64 KiB per failure.
 */
export const MEMORY_FAILURE_LOG_KEEP_BYTES: number = 32 * 1024;

export function memoryFailureLogPath(repoRoot: string): string {
  return join(repoRoot, ".zer0", "journal", "memory-failures.log");
}

/**
 * Appends one bounded failure line, rotating the file when it would cross the cap.
 *
 * @param repoRoot - the project root whose `.zer0/journal` holds the log
 * @param classification - which briefing call site failed (never derived from the message text)
 * @param error - the thrown value; bounded and neutralized before it touches the disk
 * @returns true when the line is durably on disk; false is the caller's cue to raise
 *   `memory-failure-log-unwritable`, because a fail-soft record that cannot record has become silent
 */
export function recordMemoryFailure(
  repoRoot: string,
  classification: MemoryFailureClass,
  error: unknown,
): boolean {
  // Invariant: fail-soft memory injection must not become fail-silent. The boolean is the whole
  // point of this function's contract — the old version swallowed its own failure and returned void,
  // so the ONE record of a memory failure could itself vanish with nothing left to notice it.
  const path = memoryFailureLogPath(repoRoot);
  try {
    mkdirSync(join(repoRoot, ".zer0", "journal"), { recursive: true });
    const line = failureLine(classification, error);
    rotateIfFull(path, Buffer.byteLength(line, "utf8"));
    appendFileSync(path, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops the OLDEST bytes when the next line would cross the cap, cutting at a line boundary so the
 * surviving tail never opens mid-record. A file already larger than the keep budget (a log written
 * before this cap existed) is trimmed on its first write rather than grandfathered.
 */
function rotateIfFull(path: string, incomingBytes: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // No file yet: nothing to rotate, and the append will create it.
  }
  // The size question is answered by a stat, never by reading the file: the read below happens only
  // on the rotation itself. Reading 64 KiB to decide NOT to rotate turned a bounded log into 64 KiB
  // of I/O per failure, which is how a diagnostic becomes the slowest thing in the turn.
  if (size + incomingBytes <= MEMORY_FAILURE_LOG_MAX_BYTES) return;
  const existing = readFileSync(path);
  const tail = existing.subarray(Math.max(0, existing.length - MEMORY_FAILURE_LOG_KEEP_BYTES));
  const firstLf = tail.indexOf(0x0a);
  // A tail with no LF at all is one oversized partial record; keeping none of it is correct.
  writeFileSync(path, firstLf < 0 ? Buffer.alloc(0) : tail.subarray(firstLf + 1));
}

function failureLine(classification: MemoryFailureClass, error: unknown): string {
  return `${new Date().toISOString()} ${classification} ${boundRoomNoticeDetail(error)}\n`;
}
