/**
 * @file src/memory/digest-failsafe.ts
 * @purpose Fail-safes for the DETACHED digest child (codex MT3b): a fail-OPEN single-flight lock so boot
 *   catch-up can't stack live children per session (BLOCK-1 — skip only a LIVE holder, else proceed unlocked;
 *   a redundant pass is watermark-safe, a skipped one loses memory), and a durable catastrophe recorder so a
 *   fatal error records (scratch row → last-resort .zer0/journal log) instead of vanishing (BLOCK-2), NEVER to
 *   stdout/stderr (O2) and NEVER throwing.
 * @exports DigestLock, DigestRunCtx, acquireDigestLock, releaseDigestLock, recordDigestCatastrophe
 * @depends node:fs, node:path, node:process, ../evidence/db, ./journal-store
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { appendEntry } from "./journal-store.js";

// A backstop TTL only — a holder whose pid is GONE is reclaimed immediately regardless. Longer than the codex
// digest timeout (CODEX_DIGEST_TIMEOUT_MS) so a genuinely-running digest is never stolen mid-flight.
const DIGEST_LOCK_TTL_MS = 300_000;

/** A held single-flight lock (the caller MUST releaseDigestLock it in a finally). */
export interface DigestLock {
  readonly path: string;
  readonly pid: number;
}

/** Everything the catastrophe recorder needs to key + persist a durable failure record. */
export interface DigestRunCtx {
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly projectId: string;
}

interface LockRecord {
  readonly pid: number;
  readonly expiresAt: number;
}

/**
 * Best-effort single-flight (BLOCK-1). Returns the held lock, "in-flight" when a LIVE sibling already holds it
 * (the caller SKIPS — another child is digesting this session), or "no-lock" when the state is indeterminate
 * (a parse error / fs race) so the caller PROCEEDS unlocked (fail open — see file header).
 */
export function acquireDigestLock(
  repoRoot: string,
  sessionId: string,
  now: number,
  pid: number,
): DigestLock | "in-flight" | "no-lock" {
  const file = lockPath(repoRoot, sessionId);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return "no-lock"; // cannot even create the lease folder — proceed unlocked rather than lose the digest
  }
  const record: LockRecord = { pid, expiresAt: now + DIGEST_LOCK_TTL_MS };
  if (tryCreateLock(file, record)) {
    return { path: file, pid };
  }
  const holder = readLock(file);
  if (holder === undefined) {
    return "no-lock"; // occupied but unreadable/garbage — indeterminate, fail open
  }
  if (isLive(holder, now)) {
    return "in-flight"; // a real sibling is digesting this session — skip
  }
  rmSync(file, { force: true }); // holder is stale (pid gone or expired) — reclaim
  return tryCreateLock(file, record) ? { path: file, pid } : "no-lock";
}

/** Release a held lock (best-effort; removes the file only when it still holds OUR pid, never a reclaimer's). */
export function releaseDigestLock(lock: DigestLock): void {
  if (readLock(lock.path)?.pid === lock.pid) {
    rmSync(lock.path, { force: true });
  }
}

/**
 * Durable catastrophe record (BLOCK-2). Best-effort a classified scratch row in a FRESH DB handle (the
 * original may have failed mid-flight); if the DB itself is the failure, LAST-RESORT append one line to
 * <repoRoot>/.zer0/journal/digest-failures.log. Never writes stdout/stderr (O2); never throws.
 */
export function recordDigestCatastrophe(ctx: DigestRunCtx, now: string, err: unknown): void {
  const detail = firstLine(err);
  try {
    writeCatastropheRow(ctx, now, detail);
    return;
  } catch {
    // The DB is (or became) the failure — fall through to the durable file sink.
  }
  fallbackLog(ctx, now, detail);
}

function lockPath(repoRoot: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(repoRoot, ".zer0", "leases", `digest-${safe}.lock`);
}

function tryCreateLock(file: string, record: LockRecord): boolean {
  try {
    writeFileSync(file, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST (occupied) or any write error → not acquired
  }
}

function readLock(file: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      pid?: unknown;
      expiresAt?: unknown;
    };
    if (typeof parsed.pid === "number" && typeof parsed.expiresAt === "number") {
      return { pid: parsed.pid, expiresAt: parsed.expiresAt };
    }
  } catch {
    // unreadable or non-JSON — treated as indeterminate by the caller
  }
  return undefined;
}

function isLive(holder: LockRecord, now: number): boolean {
  return holder.expiresAt > now && isPidAlive(holder.pid);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeCatastropheRow(ctx: DigestRunCtx, now: string, detail: string): void {
  const db: Db = openMemoryDb(ctx.dbPath);
  try {
    appendEntry(db, {
      projectId: ctx.projectId,
      category: "scratch",
      author: "ledger",
      body: `[digest-catastrophe] session=${ctx.sessionId}: ${detail}`,
      createdAt: now,
    });
  } finally {
    closeDb(db);
  }
}

function fallbackLog(ctx: DigestRunCtx, now: string, detail: string): void {
  try {
    const dir = path.join(ctx.repoRoot, ".zer0", "journal");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "digest-failures.log"),
      `${now} session=${ctx.sessionId} [digest-catastrophe] ${detail}\n`,
      "utf8",
    );
  } catch {
    // Last resort exhausted (read-only fs / permission) — nothing durable is possible; still no stdout/stderr.
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/, 1)[0] ?? "unknown error";
}
