// The digest wiring proved at the PROCESS boundary: a real room host, started from source with a TypeScript
// loader, forks a real detached digest child that inherits that loader through process.execArgv — the same
// inheritance the packaged host uses to fork plain compiled JavaScript. Explicit shutdown and stdin EOF each
// go through the one close path and each leave exactly one durable close record; a session left on disk by a
// crash is recovered by the next boot's catch-up. Split from room-host-process.test.ts (the JSON-RPC framing
// falsifiers) rather than growing that file past its line clamp: this is a different subject.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { createUserMessage } from "../chat/commands.js";
import { appendMessage, createSession, persistSession } from "../chat/session-store.js";
import type { ChatSession } from "../chat/types.js";
import { awaitDigestEvidence } from "../memory/digest-evidence.js";
import { type DigestRequestLine, digestRequestFile } from "../memory/digest-handoff.js";
import { type RoomHostFrame, spawnRoomHost } from "./room-host-process.js";
import { cleanupTestRoot } from "./room-test-cleanup.fixtures.js";

const cleanupRoots: string[] = [];

// FL-175 round 4: a waitFor/closeStdinAndWait call here is a HANG DETECTOR, not a timing assertion —
// see room-host-process.test.ts's header for the full rule. This file's own round-3-reviewer RED
// (test "stdin EOF forks the same digest child ...", "waiting for room host frame timed out after
// 30000ms" at 49,267 ms) is the same construct: a fixed 30_000 ms per-call budget that a fired
// deadline never actually measured. Every test here shares one outer budget (120_000), so one shared
// derived constant covers the whole file instead of a per-test literal.
const RPC_WAIT_MS = 120_000 - 5_000;
// F9: a diagnosis trigger, not a pass condition — the wait returns as soon as the rows land or a durable
// failure record appears. Measured here: 3.2 s, 3.1 s, 2.5 s for these three closes (a real host start under
// a TypeScript loader plus a real detached child); the lead's ten probes on master span 2.0-3.6 s. 60 s is
// ~17x the worst observation and is not raised. The test cannot know the child's pid — the host forks it —
// but the lease file under .zer0/leases carries that pid, and the evidence reader reports its liveness.
const DIGEST_BUDGET_MS = 60_000;

/** ZER0_HERMETIC refuses every agent spawn at the seam, so the submitted turn is deterministic; the canned
 *  extraction is what makes the digest child hermetic in turn (no model call, fixed facts). */
const DIGEST_ENV = {
  ZER0_HERMETIC: "1",
  ZER0_MEMORY: "1",
  ZER0_DIGEST_FAKE: JSON.stringify({
    decisions: [{ topic: "process-close", body: "the room close forked the digest child" }],
    summary: "one submitted turn",
  }),
};

// F9: on failure the workspace IS the diagnosis (the DB, .zer0/journal/digest-failures.log, .zer0/leases with
// the digest child's own pid, .zer0/journal/room-close.log). Deleted only when the test passed.
afterEach(async (ctx) => {
  const roots = cleanupRoots.splice(0);
  if (ctx.task.result?.state === "fail") {
    for (const root of roots)
      process.stderr.write(`RETAINED room workspace for diagnosis: ${root}\n`);
    return;
  }
  await Promise.all(roots.map((root) => cleanupTestRoot(root)));
});

it("the explicit shutdown forks the REAL digest child, whose fact lands in the DB after the host exits", async () => {
  const { host, root, dbPath } = await freshHost();
  try {
    const sessionId = await submitOneTurn(host, root);
    await host.send(rpc("shutdown", "zer0/room/shutdown", { sessionId }));
    await result(host, "shutdown");
    expect((await host.closeStdinAndWait(RPC_WAIT_MS)).code).toBe(0);

    expect(await awaitDigestFact(root, dbPath, sessionId)).toBe("digested");
    expect(digestFacts(dbPath)).toEqual({ decisions: 1, summaries: 1, scratch: [] });
    const record = closeRecord(root);
    expect(record).toHaveLength(1);
    expect(record[0]).toContain(`session=${sessionId} reason=zer0/room/shutdown digest=requested`);
  } finally {
    await host.dispose();
  }
}, 120_000);

it("stdin EOF forks the same digest child through the same close path, and closes exactly once", async () => {
  const { host, root, dbPath } = await freshHost();
  try {
    const sessionId = await submitOneTurn(host, root);
    expect((await host.closeStdinAndWait(RPC_WAIT_MS)).code).toBe(0);

    expect(await awaitDigestFact(root, dbPath, sessionId)).toBe("digested");
    expect(digestFacts(dbPath)).toEqual({ decisions: 1, summaries: 1, scratch: [] });
    const record = closeRecord(root);
    expect(record).toHaveLength(1);
    expect(record[0]).toContain(`session=${sessionId} reason=stdin-eof digest=requested`);
  } finally {
    await host.dispose();
  }
}, 120_000);

it("a session whose transcript survived a crash is digested by the NEXT boot's catch-up", async () => {
  const { host, root, dbPath } = await freshHost();
  try {
    // A session left on disk with a completed turn and no digest: what a killed host leaves behind.
    const crashed = await seedCrashedSession(root);
    await initialize(host, "catchup-init");
    await host.send(rpc("new", "session/new", sessionParams(root)));
    const sessionId = record((await result(host, "new")).result).sessionId as string;
    await host.waitFor((frame) => isRoomEvent(frame) && frame.params.eventSeq === "0", RPC_WAIT_MS);

    expect(await awaitWatermark(root, dbPath, crashed.id)).toBe("recovered");
    expect(digestFacts(dbPath).decisions).toBe(1);
    await host.send(rpc("shutdown", "zer0/room/shutdown", { sessionId }));
    await result(host, "shutdown");
  } finally {
    await host.dispose();
  }
}, 120_000);

it("under ZER0_DIGEST_HANDOFF the close QUEUES the digest for the parent and runs none itself (F10)", async () => {
  const { host, root, dbPath } = await freshHost({ ZER0_DIGEST_HANDOFF: "1" });
  try {
    const sessionId = await submitOneTurn(host, root);
    await host.send(rpc("shutdown", "zer0/room/shutdown", { sessionId }));
    await result(host, "shutdown");
    expect((await host.closeStdinAndWait(RPC_WAIT_MS)).code).toBe(0);

    const requests = requestLines(root);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.sessionId).toBe(sessionId);
    expect(requests[0]?.repoRoot).toBe(root);
    expect(requests[0]?.argv.at(-4)).toBe(sessionId);
    expect(requests[0]?.argv.some((arg) => arg.endsWith("digest-entry.ts"))).toBe(true);
    // The projectId slot is load-bearing and fails SILENTLY when wrong: the 5c Rust lane measured that a
    // path in it makes the digest child exit 0 while writing only "FOREIGN KEY constraint failed" to
    // digest-failures.log. Pin all three identities: shape, the DB's own project row, and the argv slot.
    expect(requests[0]?.projectId).toMatch(/^[0-9a-f]{64}$/u);
    const projectRow = new Database(dbPath, { readonly: true })
      .prepare("SELECT project_id FROM projects")
      .pluck()
      .all();
    expect(projectRow).toEqual([requests[0]?.projectId]);
    expect(requests[0]?.argv.at(-1)).toBe(requests[0]?.projectId);

    const record = closeRecord(root);
    expect(record).toHaveLength(1);
    expect(record[0]).toContain(`session=${sessionId} reason=zer0/room/shutdown digest=handed-off`);

    // The negative half, and the reason it means anything: any child this host forked would have been forked
    // BEFORE it exited, and one measured digest child costs 0.7-2.6 s end to end (digest-runner.test.ts,
    // oracle waitForDigest). Waiting 4 s after the exit is past that whole window, so an empty journal here
    // is "no child ran", not "no child has finished yet".
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(digestFacts(dbPath)).toEqual({ decisions: 0, summaries: 0, scratch: [] });
    expect(leaseFiles(root)).toEqual([]);
    expect(existsSync(path.join(root, ".zer0", "journal", "digest-failures.log"))).toBe(false);
  } finally {
    await host.dispose();
  }
}, 120_000);

async function freshHost(extraEnv: Record<string, string> = {}): Promise<{
  readonly host: ReturnType<typeof spawnRoomHost>;
  readonly root: string;
  readonly dbPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-digest-"));
  cleanupRoots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const dbPath = path.join(root, ".zer0-test", "evidence.db");
  const env = {
    HOME: path.join(root, ".home"),
    USERPROFILE: path.join(root, ".home"),
    ZER0_BLOB_ROOT: path.join(root, ".zer0-test", "blobs"),
    ZER0_DB_PATH: dbPath,
    ZER0_STATUSLINE_DIR: path.join(root, ".zer0-test", "statusline"),
    ...DIGEST_ENV,
    ...extraEnv,
  };
  return { host: spawnRoomHost({ cwd: root, env }), root, dbPath };
}

async function submitOneTurn(
  host: ReturnType<typeof spawnRoomHost>,
  root: string,
): Promise<string> {
  await initialize(host, "digest-init");
  await host.send(rpc("new", "session/new", sessionParams(root)));
  const sessionId = record((await result(host, "new")).result).sessionId as string;
  await host.waitFor((frame) => isRoomEvent(frame) && frame.params.eventSeq === "0", RPC_WAIT_MS);
  await host.send(rpc("submit", "zer0/room/submit", { sessionId, text: "@all remember this" }));
  await result(host, "submit");
  // Every lane refuses under ZER0_HERMETIC, but the operator message is persisted either way — that is the
  // completed transcript row the digest reads.
  await host.waitFor(
    (frame) => isRoomEvent(frame) && frame.params.type === "turn.completed",
    RPC_WAIT_MS,
  );
  return sessionId;
}

async function seedCrashedSession(root: string): Promise<ChatSession> {
  const created = await createSession(root);
  const session = appendMessage(created, createUserMessage(1, "work from before the crash"));
  await persistSession(session);
  await writeFile(
    path.join(session.runDir, "zer0-v2-room.json"),
    JSON.stringify({ version: 1 }),
    "utf8",
  );
  return session;
}

function digestFacts(dbPath: string): {
  decisions: number;
  summaries: number;
  scratch: string[];
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("select category, body from journal_entries").all() as {
      category: string;
      body: string;
    }[];
    return {
      decisions: rows.filter((row) => row.category === "decision").length,
      summaries: rows.filter((row) => row.category === "summary").length,
      scratch: rows.filter((row) => row.category === "scratch").map((row) => row.body),
    };
  } finally {
    db.close();
  }
}

/** Waits for the close's own digest; on timeout the returned string IS the diagnosis (see digest-evidence). */
async function awaitDigestFact(
  repoRoot: string,
  dbPath: string,
  sessionId: string,
): Promise<string> {
  const result = await awaitDigestEvidence({
    repoRoot,
    dbPath,
    budgetMs: DIGEST_BUDGET_MS,
    sessionId,
    expected: (rows) => rows.decisions > 0 && rows.summaries > 0,
  });
  return result.ok ? "digested" : result.report;
}

/** Waits for boot catch-up to watermark the crashed session; the diagnosis is the failure value. */
async function awaitWatermark(
  repoRoot: string,
  dbPath: string,
  sessionId: string,
): Promise<string> {
  const result = await awaitDigestEvidence({
    repoRoot,
    dbPath,
    budgetMs: DIGEST_BUDGET_MS,
    sessionId,
    expected: (rows) => rows.watermarks.some((mark) => mark.session === sessionId && mark.n > 0),
  });
  return result.ok ? "recovered" : result.report;
}

/** The durable close record the attached-session lifecycle appends: exactly one line per close. */
function closeRecord(root: string): string[] {
  const file = path.join(root, ".zer0", "journal", "room-close.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** The F10 queue the handoff writer appends to: one JSON object per line, read back as the seam defines it. */
function requestLines(root: string): DigestRequestLine[] {
  const file = digestRequestFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DigestRequestLine);
}

/** The single-flight leases a digest child takes: none of them means no child ever started a pass. */
function leaseFiles(root: string): string[] {
  try {
    return readdirSync(path.join(root, ".zer0", "leases"));
  } catch {
    return [];
  }
}

function rpc(
  id: string | number,
  method: string,
  params: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, method, params };
}

function sessionParams(cwd: string): Record<string, unknown> {
  return { cwd, mcpServers: [] };
}

async function initialize(
  host: ReturnType<typeof spawnRoomHost>,
  id: string | number,
): Promise<void> {
  await host.send(rpc(id, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
  await result(host, id);
}

async function result(
  host: ReturnType<typeof spawnRoomHost>,
  id: string | number,
): Promise<RoomHostFrame> {
  return host.waitFor((frame) => frame.id === id && Object.hasOwn(frame, "result"), RPC_WAIT_MS);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object");
  return value as Record<string, unknown>;
}

function isRoomEvent(
  frame: RoomHostFrame,
): frame is RoomHostFrame & { readonly params: Record<string, unknown> } {
  return (
    frame.jsonrpc === "2.0" &&
    frame.method === "zer0/room/event" &&
    frame.params !== null &&
    typeof frame.params === "object" &&
    !Array.isArray(frame.params)
  );
}
