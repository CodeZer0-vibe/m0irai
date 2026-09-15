/**
 * @file src/memory/digest-handoff.ts
 * @purpose F10 — the close digest must outlive the packaged host. When the Rust parent sets
 *   ZER0_DIGEST_HANDOFF=1 this module writes a durable REQUEST instead of forking a child that its Windows
 *   Job Object would kill, and the parent spawns the identical child after the host exited. The request is
 *   the serialised digestSpawnArgs() plan and nothing recomputed. Boot catch-up always forks in process.
 * @exports DigestRequestLine, digestRequestFile, createHandoffSpawn, resolveDigestSpawns, DigestSpawnSeams
 * @depends node:fs, node:path, node:process, ./digest-runner
 */
// The measurement behind this (2026-08-18, .lead/tools/job-survival-probe.ps1): the Rust binary enrols the
// Node host in a job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and libuv's `detached: true` never sets
// CREATE_BREAKAWAY_FROM_JOB — KILL_ON_JOB_CLOSE alone: child KILLED; + BREAKAWAY_OK: KILLED; no job:
// SURVIVED. Selective breakaway was rejected (it would let every host child escape the reaper), so the only
// process that can start a surviving child is the one outside the job: the Rust binary. Dev, test and the
// hermetic oracle run without the flag and keep forking in process, which is why nothing red pointed here.
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type DigestRequest,
  type DigestSpawn,
  type DigestSpawnImpl,
  type DigestSpawnPlan,
  createDetachedSpawn,
  digestEntryPath,
  digestSpawnArgs,
} from "./digest-runner.js";

/** The env switch the Rust launcher sets on the host it owns. Exactly "1"; anything else is in-process. */
const HANDOFF_FLAG = "ZER0_DIGEST_HANDOFF";
const REQUEST_DIR = [".zer0", "journal"] as const;
const REQUEST_FILE = "digest-requests.jsonl";
/** Bumped only when a consumer written against the old shape would misread the new one. */
const SCHEMA_VERSION = 1;
/** The trailing argv positions the entry reads: sessionId, repoRoot, dbPath, projectId (digest-entry.ts). */
const ARGV_TUPLE_LENGTH = 4;

/**
 * One line of `<repoRoot>/.zer0/journal/digest-requests.jsonl` — the seam the Rust consumer reads. Every
 * key is required and no others are written: the consumer spawns `execPath argv…` with `env_clear()` + this
 * env, this cwd, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, null stdio, and NOT
 * enrolled in its job.
 */
export interface DigestRequestLine {
  readonly v: number;
  readonly kind: "digest";
  readonly sessionId: string;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly requestedAt: string;
}

/** The append-only request file for a project. Both sides derive it from the repo root, never from cwd. */
export function digestRequestFile(repoRoot: string): string {
  return path.join(repoRoot, ...REQUEST_DIR, REQUEST_FILE);
}

/**
 * The handoff spawn: writes ONE request line and forks nothing. Fails loudly (throws) when the line cannot
 * be made durable — the close path turns that into `digest=failed(…)` in the close record plus a diagnostic,
 * which is the honest outcome; silently returning would claim a digest that no one will ever run.
 *
 * @param entry - the entry the child must run; the same value the in-process spawn would fork
 * @param file - the request file, for tests that need to point it somewhere else; defaults to the seam path
 * @returns a DigestSpawn that reports `handed-off`
 */
export function createHandoffSpawn(entry: string = digestEntryPath(), file?: string): DigestSpawn {
  return (request: DigestRequest) => {
    const plan = digestSpawnArgs(request, entry);
    const line = requestLine(request, plan);
    appendDurably(file ?? digestRequestFile(request.repoRoot), line);
    return "handed-off" as const;
  };
}

/** The two seams the room needs, so the caller never has to know which one the flag selected. */
export interface DigestSpawnSeams {
  /** The CLOSE digest: handed off when the host runs under a job it cannot escape, else forked here. */
  readonly close: DigestSpawn;
  /** Boot catch-up: ALWAYS forked here. Those children run while the host runs, so the job never reaps them. */
  readonly catchUp: DigestSpawn;
}

/**
 * Picks the close seam from the environment. The flag is read per call, not captured at construction, so a
 * host object built before the environment was arranged still behaves the way the environment says.
 *
 * @param entry - the entry both seams fork or name; defaults to the runner's compiled sibling
 * @param spawnImpl - the process-spawn seam, so a test can prove the handoff path forks NOTHING
 * @returns the close and catch-up seams
 */
export function resolveDigestSpawns(
  entry: string = digestEntryPath(),
  spawnImpl?: DigestSpawnImpl,
): DigestSpawnSeams {
  const handoff = createHandoffSpawn(entry);
  const inProcess = createDetachedSpawn(entry, spawnImpl);
  return {
    close: (request) => (process.env[HANDOFF_FLAG] === "1" ? handoff : inProcess)(request),
    catchUp: inProcess,
  };
}

/**
 * Serialises the plan. The four identity fields are read back OUT of the plan's argv tail rather than
 * recomputed from the request, so the top-level fields and the argv the consumer spawns can never disagree —
 * and a plan whose tail is not this request's tuple is a programming error that must not reach the file.
 */
function requestLine(request: DigestRequest, plan: DigestSpawnPlan): string {
  const tuple = plan.argv.slice(-ARGV_TUPLE_LENGTH);
  const [sessionId, repoRoot, dbPath, projectId] = tuple;
  if (
    sessionId !== request.sessionId ||
    repoRoot !== request.repoRoot ||
    projectId !== request.projectId ||
    dbPath === undefined
  )
    throw new Error(
      `digest spawn plan does not end in this request's argv tuple: ${JSON.stringify(tuple)}`,
    );
  const payload: DigestRequestLine = {
    v: SCHEMA_VERSION,
    kind: "digest",
    sessionId,
    projectId,
    repoRoot,
    dbPath,
    execPath: process.execPath,
    argv: [...plan.argv],
    cwd: plan.options.cwd,
    env: plan.options.env,
    requestedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Appends one line and fsyncs it. Synchronous on purpose: the close path is the last thing that runs before
 * the host process exits, so an async write is a write that may never reach the disk. O_APPEND makes the
 * append itself atomic, so two writers can never interleave a half line.
 */
function appendDurably(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    writeSync(fd, line, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
