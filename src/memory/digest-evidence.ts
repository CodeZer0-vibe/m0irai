/**
 * @file src/memory/digest-evidence.ts
 * @purpose Test support: the DIAGNOSIS a wait on a real detached digest child must carry when it does not
 *   arrive. F9 (Phase 4): the boot-catch-up wait went RED once in a full staged proof and left nothing
 *   behind — the teardown had deleted the workspace, and with it the failure log, the scratch rows and the
 *   leases that would have named the cause. The wait now ends on TERMINAL EVIDENCE (the caller's rows, or a
 *   durable failure record); on timeout it reports the row timeline, the catastrophe bodies, the failure
 *   log, every lease with its pid and its liveness, and the workspace to retain. No reader here throws.
 * @exports DigestRows, DigestLease, DigestEvidence, DigestWaitOptions, DigestWaitResult, readDigestRows, readDigestEvidence, digestFailures, formatDigestEvidence, awaitDigestEvidence, pidAlive
 * @depends node:fs, node:path, node:process, better-sqlite3
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";

/** What the digest actually wrote, as of one sample. `error` is set when the DB could not be read at all. */
export interface DigestRows {
  readonly decisions: number;
  readonly summaries: number;
  readonly scratch: readonly string[];
  readonly watermarks: readonly { readonly session: string; readonly n: number }[];
  readonly error: string | undefined;
}

/** A single-flight lease left under .zer0/leases, with the liveness of whoever holds it. */
export interface DigestLease {
  readonly file: string;
  readonly pid: number | undefined;
  readonly alive: boolean | undefined;
  readonly raw: string;
}

/** Everything a failed wait needs to name its own cause. */
export interface DigestEvidence {
  readonly workspace: string;
  readonly rows: DigestRows;
  readonly failureLog: string;
  readonly closeLog: readonly string[];
  readonly leases: readonly DigestLease[];
  readonly spawned: readonly { readonly pid: number; readonly alive: boolean }[];
}

export interface DigestWaitOptions {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly budgetMs: number;
  readonly expected: (rows: DigestRows) => boolean;
  /** Narrows the failure check to one session; omit when the wait covers every session in the project. */
  readonly sessionId?: string;
  readonly spawnedPids?: readonly number[];
}

export interface DigestWaitResult {
  readonly ok: boolean;
  readonly terminal: "expected" | "failure-record" | "timeout";
  readonly rows: DigestRows;
  /** A ready-to-assert diagnosis; empty string when the wait succeeded. */
  readonly report: string;
}

const SAMPLE_MS = 100;
const CATASTROPHE = "[digest-catastrophe]";

/**
 * Reads the digest's own output. Total: a DB that cannot be opened yet returns the reason, never a throw.
 * READ-ONLY on purpose — the migrating opener takes a write transaction, and sampling that every 100 ms
 * against the very children this watches would contend for the lock and could manufacture the stall it is
 * meant to diagnose.
 */
export function readDigestRows(dbPath: string): DigestRows {
  const empty = { decisions: 0, summaries: 0, scratch: [], watermarks: [] };
  if (!existsSync(dbPath)) return { ...empty, error: `db absent: ${dbPath}` };
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const entries = db.prepare("select category, body from journal_entries").all() as {
      category: string;
      body: string;
    }[];
    const marks = db
      .prepare(
        "select session_id as session, count(*) as n from digest_watermark group by session_id",
      )
      .all() as { session: string; n: number }[];
    return {
      decisions: entries.filter((row) => row.category === "decision").length,
      summaries: entries.filter((row) => row.category === "summary").length,
      scratch: entries.filter((row) => row.category === "scratch").map((row) => row.body),
      watermarks: marks,
      error: undefined,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // a half-open handle must not become the failure the caller reports
      }
    }
  }
}

/**
 * The DB the digest child actually opens. The child runs with cwd=os.tmpdir(), so digestSpawnArgs resolves a
 * relative dbPath against the repoRoot ARG (dogfood bug #1); a watcher that skipped this step would resolve
 * the same relative path against the TEST process instead and silently watch a different file — which is
 * precisely what it did until the F9 diagnosis named it.
 */
function resolveDbPath(repoRoot: string, dbPath: string): string {
  return path.resolve(repoRoot, dbPath);
}

/** Whether a pid is still running. EPERM means alive-but-not-ours; only ESRCH means gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function readLeases(repoRoot: string): readonly DigestLease[] {
  const dir = path.join(repoRoot, ".zer0", "leases");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((file) => {
    const raw = readTextFile(path.join(dir, file));
    const pid = parsePid(raw);
    return { file, pid, alive: pid === undefined ? undefined : pidAlive(pid), raw };
  });
}

function parsePid(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function readTextFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Collects every durable trace the digest could have left, from a workspace that is about to be retained. */
export function readDigestEvidence(
  repoRoot: string,
  dbPath: string,
  spawnedPids: readonly number[] = [],
): DigestEvidence {
  return {
    workspace: repoRoot,
    rows: readDigestRows(resolveDbPath(repoRoot, dbPath)),
    failureLog: readTextFile(path.join(repoRoot, ".zer0", "journal", "digest-failures.log")),
    closeLog: readTextFile(path.join(repoRoot, ".zer0", "journal", "room-close.log"))
      .split("\n")
      .filter((line) => line.trim().length > 0),
    leases: readLeases(repoRoot),
    spawned: spawnedPids.map((pid) => ({ pid, alive: pidAlive(pid) })),
  };
}

function describeRows(rows: DigestRows): string {
  return `decisions=${String(rows.decisions)} summaries=${String(rows.summaries)} scratch=${String(rows.scratch.length)} watermarks=${JSON.stringify(rows.watermarks)}${rows.error === undefined ? "" : ` dbError=${rows.error}`}`;
}

/**
 * The durable failures this wait must not ignore: catastrophe rows and failure-log lines, narrowed to the
 * caller's session when it named one. Checked BEFORE the success predicate (codex #19) — rows arriving and
 * a catastrophe being recorded are not mutually exclusive, and a wait that answers "expected rows are
 * there, pass" while the digest recorded a fatal error is exactly how a real failure stays invisible.
 *
 * @param options - the wait's workspace and optional session scope
 * @param rows - the sample just taken
 * @returns every durable failure line in scope, newest last; empty when the digest recorded none
 */
export function digestFailures(
  options: Pick<DigestWaitOptions, "repoRoot" | "sessionId">,
  rows: DigestRows,
): readonly string[] {
  const inScope = (text: string): boolean =>
    text.includes(CATASTROPHE) &&
    (options.sessionId === undefined || text.includes(`session=${options.sessionId}`));
  const log = readTextFile(path.join(options.repoRoot, ".zer0", "journal", "digest-failures.log"));
  return [...rows.scratch.filter(inScope), ...log.split("\n").filter(inScope)];
}

/** The whole diagnosis as one block, ready to hand to an assertion message. */
export function formatDigestEvidence(
  evidence: DigestEvidence,
  timeline: readonly string[],
  budgetMs: number,
  failures: readonly string[] = [],
): string {
  return [
    failures.length > 0
      ? `the digest recorded ${String(failures.length)} durable failure(s) for this wait: ${JSON.stringify(failures)}`
      : `digest wait exhausted its ${String(budgetMs)}ms budget with no terminal evidence.`,
    `WORKSPACE RETAINED FOR DIAGNOSIS: ${evidence.workspace}`,
    `rows now: ${describeRows(evidence.rows)}`,
    `timeline (ms since the wait began): ${timeline.length === 0 ? "no change observed" : timeline.join(" | ")}`,
    `catastrophe rows: ${evidence.rows.scratch.length === 0 ? "none" : JSON.stringify(evidence.rows.scratch)}`,
    `digest-failures.log: ${evidence.failureLog === "" ? "absent or empty" : JSON.stringify(evidence.failureLog)}`,
    `room-close.log: ${evidence.closeLog.length === 0 ? "absent or empty" : JSON.stringify(evidence.closeLog)}`,
    `leases: ${evidence.leases.length === 0 ? "none (no child holds this project's digest lock)" : JSON.stringify(evidence.leases)}`,
    `spawned pids: ${evidence.spawned.length === 0 ? "not recorded by this caller" : JSON.stringify(evidence.spawned)}`,
  ].join("\n  ");
}

/**
 * Waits for a real detached digest child to leave TERMINAL EVIDENCE: either the rows the caller expects, or a
 * durable failure record (a catastrophe row or the failure log), which ends the wait immediately rather than
 * burning the whole budget on a digest that has already given up. On timeout the returned `report` names the
 * cause as far as the disk can: see formatDigestEvidence.
 *
 * The budget is a DIAGNOSIS trigger, not a pass condition — a healthy pass returns as soon as the rows land.
 *
 * @param options - the workspace, the DB, the caller's success predicate, and any pids it spawned itself
 */
export async function awaitDigestEvidence(options: DigestWaitOptions): Promise<DigestWaitResult> {
  const started = Date.now();
  const timeline: string[] = [];
  const dbPath = resolveDbPath(options.repoRoot, options.dbPath);
  let previous = "";
  let rows = readDigestRows(dbPath);
  for (;;) {
    rows = readDigestRows(dbPath);
    const shape = describeRows(rows);
    if (shape !== previous) {
      timeline.push(`+${String(Date.now() - started)}ms ${shape}`);
      previous = shape;
    }
    // Failures FIRST (codex #19): a durable catastrophe for this session is never a pass, however many of
    // the caller's rows also happen to be there.
    const failures = digestFailures(options, rows);
    if (failures.length === 0 && options.expected(rows))
      return { ok: true, terminal: "expected", rows, report: "" };
    if (failures.length > 0 || Date.now() - started > options.budgetMs) {
      const evidence = readDigestEvidence(
        options.repoRoot,
        options.dbPath,
        options.spawnedPids ?? [],
      );
      return {
        ok: false,
        terminal: failures.length > 0 ? "failure-record" : "timeout",
        rows,
        report: formatDigestEvidence(evidence, timeline, options.budgetMs, failures),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  }
}
