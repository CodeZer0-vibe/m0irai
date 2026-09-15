/**
 * @file src/chat/evidence-failure.ts
 * @purpose Shared chat evidence-write failure handling: classify a sqlite/fs error into a
 *   legible reason, log it, and surface a user-facing message. One shared path for every chat
 *   evidence write so callers stay under the line cap.
 * @exports surfaceEvidenceFailure
 * @depends ../shared/logger, ./ui
 */
import { createLogger } from "../shared/logger.js";
import { printChatError } from "./ui.js";

const logger = createLogger();
const EVIDENCE_PHASE: string = "chat";
// FL-077: SQLite's EXTENDED busy codes are real contention, not failures — a deferred read
// transaction upgrading against a stale WAL snapshot reports SQLITE_BUSY_SNAPSHOT (FL-074 measured
// a 3 ms throw under busy_timeout 5000), recovery-time a freshly recovered -wal reports
// SQLITE_BUSY_RECOVERY, an exhausted internal retry SQLITE_BUSY_TIMEOUT. Each must take the same
// swallow-and-warn branch as bare SQLITE_BUSY (https://sqlite.org/rescode.html#busy).
const BUSY_CODES: readonly string[] = [
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_TIMEOUT",
];
const DISK_FULL_CODES: readonly string[] = ["SQLITE_FULL", "ENOSPC"];
const FOREIGN_KEY_CODES: readonly string[] = ["SQLITE_CONSTRAINT_FOREIGNKEY"];

/**
 * Logs and surfaces a chat evidence-write failure. A transient busy (SQLITE_BUSY) is logged at
 * warn and swallowed; any other failure is classified (disk-full / schema-drift / unknown) and
 * shown to the operator. Never throws — evidence writes are best-effort side effects.
 */
export async function surfaceEvidenceFailure(err: unknown, op: string): Promise<void> {
  const code = errorCode(err);
  const message = errorMessage(err);
  if (code !== undefined && BUSY_CODES.includes(code)) {
    logger.warn({ phase: EVIDENCE_PHASE }, "chat evidence write busy", { op, code, message });
    return;
  }
  const reason = evidenceFailureReason(code, message);
  logger.warn({ phase: EVIDENCE_PHASE }, "chat evidence write failed", {
    op,
    code,
    reason,
    message,
  });
  printChatError(`Evidence write failed for ${op}: ${reason}`);
}

function evidenceFailureReason(
  code: string | undefined,
  message: string,
): "disk-full" | "schema-drift" | "unknown" {
  if (code !== undefined && DISK_FULL_CODES.includes(code)) return "disk-full";
  if (code !== undefined && FOREIGN_KEY_CODES.includes(code)) return "schema-drift";
  if (message.includes("FOREIGN KEY")) return "schema-drift";
  return "unknown";
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
