import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createUserMessage } from "../chat/commands.js";
import { appendMessage, createSession, persistSession } from "../chat/session-store.js";
import type { ChatSession } from "../chat/types.js";
import { type RoomHostFrame, spawnRoomHost } from "./room-host-process.js";
import {
  CLEANUP_DEADLINE_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  LOCK_HOLDER_SRC,
  LOCK_HOLDER_STUCK_SRC,
  cleanupTestRoot,
  lockTakenHold,
  pollUntil,
} from "./room-test-cleanup.fixtures.js";

// FL-175 round 4: a waitFor/closeStdinAndWait call here is a HANG DETECTOR, not a timing assertion — its
// only job is to name "waiting for room host frame timed out" instead of vitest's generic "Test timed
// out" if the host truly wedges. A fixed value (15_000, then 30_000 after 15_000 fired) can never carry
// real margin: a fired deadline only proves the true need is AT LEAST that large, and the round-3
// reviewer's own heaviest run made a single RPC round trip exceed 30_000 ms twice (this file and
// room-host-digest-process.test.ts). vitest kills the whole test at its OWN outer budget regardless, so
// sizing a call below that buys nothing but a different message under load — the work still has to fit
// the same wall clock either way. So every wait here is sized per test, from that test's own outer
// budget minus a fixed TEARDOWN_MARGIN_MS reserved for the rest of the test body: RPC_WAIT_MS = <outer
// budget literal, matching the it()'s own trailing argument> - TEARDOWN_MARGIN_MS.
const TEARDOWN_MARGIN_MS = 5_000;
// FL-175 round 4 reviewer finding: `elapsed` below is always ~= CLEANUP_DEADLINE_MS + retry/rm overshoot,
// so a FIXED ceiling silently thins whenever that deadline is raised without revisiting this — the old
// 10_000 stayed put while the deadline moved 2_000 -> 5_000, leaving only 1.95x on today's measured worst
// (5029/5037/5097/5124 ms, none capped). Deriving the ceiling puts the coupling in the code: 2x the
// deadline alone reproduces the same 10_000, so a flat 5_000 ms slack (>>the 124 ms worst overshoot seen)
// is added on top, landing at 2.93x.
const CLEANUP_EXHAUSTION_CEILING_MS = CLEANUP_DEADLINE_MS * 2 + 5_000;
const cleanupRoots: string[] = [];
const framingViolationCases: readonly Uint8Array[] = [
  Buffer.from(
    `{"jsonrpc":"2.0","id":"huge","method":"initialize","params":{"x":"${"x".repeat(1024 * 1024)}"}}\n`,
  ),
  Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
  Buffer.from('{"jsonrpc":"2.0"'),
];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => cleanupTestRoot(root)));
});

it("falsifier: host is silent before initialize, creates only after session/new, and response precedes readiness", async () => {
  // Outer budget 90_000 (matches this it()'s trailing argument below).
  const RPC_WAIT_MS = 90_000 - TEARDOWN_MARGIN_MS;
  const { host, root } = await freshHost();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.frames()).toEqual([]);
    await host.send(rpc(1, "zer0/room/submit", { sessionId: "none", text: "no" }));
    expect(error(await host.waitFor((frame) => frame.id === 1, RPC_WAIT_MS))).toMatchObject({
      code: -32600,
    });
    await initialize(host, 2, RPC_WAIT_MS);
    await host.send(rpc(3, "session/new", sessionParams(root)));
    const created = await result(host, 3, RPC_WAIT_MS);
    const sessionId = record(created.result).sessionId as string;
    expect(sessionId).toMatch(/^chat-/u);
    const ready = await host.waitFor(
      (frame) => isRoomEvent(frame) && frame.params.eventSeq === "0",
      RPC_WAIT_MS,
    );
    expect(host.frames().indexOf(created)).toBeLessThan(host.frames().indexOf(ready));
    const settings = JSON.parse(
      await readFile(
        path.join(root, ".home", ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    ) as { statusLine?: { enabled?: unknown; command?: unknown } };
    expect(settings.statusLine?.enabled).toBe(true);
    expect(settings.statusLine?.command).toContain("statusline-emit.cjs");
    await expect(
      readFile(path.join(root, ".zer0-test", "statusline", "statusline-emit.cjs"), "utf8"),
    ).resolves.toContain("writeFileSync");
    await host.send(rpc(3, "session/new", sessionParams(root)));
    await waitFor(() => host.frames().filter((frame) => frame.id === 3).length === 2);
    expect(host.frames().filter((frame) => frame.id === 3)).toHaveLength(2);
    expect(
      host.frames().filter((frame) => isRoomEvent(frame) && frame.params.eventSeq === "0"),
    ).toHaveLength(1);
    await host.send(rpc("bad", "unknown/method", { sessionId }));
    expect(error(await host.waitFor((frame) => frame.id === "bad", RPC_WAIT_MS))).toMatchObject({
      code: -32601,
    });
    await shutdown(host, sessionId, RPC_WAIT_MS);
  } finally {
    await host.dispose();
  }
}, 90_000);

it("falsifier: malformed and mismatched-session requests fail as JSON-RPC without stdout noise", async () => {
  // Outer budget 90_000 (matches this it()'s trailing argument below).
  const RPC_WAIT_MS = 90_000 - TEARDOWN_MARGIN_MS;
  const { host, root } = await freshHost();
  try {
    await host.sendRaw("not-json");
    expect(error(await host.waitFor((frame) => frame.id === null, RPC_WAIT_MS))).toMatchObject({
      code: -32600,
    });
    await initialize(host, "init", RPC_WAIT_MS);
    await host.send(rpc("new", "session/new", sessionParams(root)));
    const sessionId = record((await result(host, "new", RPC_WAIT_MS)).result).sessionId as string;
    await host.waitFor((frame) => isRoomEvent(frame) && frame.params.eventSeq === "0", RPC_WAIT_MS);
    await host.send(
      rpc("wrong-session", "zer0/room/resync", { sessionId: "chat-other", afterEventSeq: "0" }),
    );
    expect(
      error(await host.waitFor((frame) => frame.id === "wrong-session", RPC_WAIT_MS)),
    ).toMatchObject({ code: -32602 });
    await shutdown(host, sessionId, RPC_WAIT_MS);
    expect(host.frames().every(isProtocolFrame)).toBe(true);
  } finally {
    await host.dispose();
  }
}, 90_000);

it("falsifier: oversized, invalid UTF-8, and EOF-truncated ingress are fatal framing violations", async () => {
  // Outer budget 120_000 (matches this it()'s trailing argument below), for up to 3 sequential closes.
  const RPC_WAIT_MS = 120_000 - TEARDOWN_MARGIN_MS;
  for (const bytes of framingViolationCases) {
    const { host } = await freshHost();
    try {
      await host.sendBytes(bytes);
      expect((await host.closeStdinAndWait(RPC_WAIT_MS)).code).toBe(4);
      expect(host.frames()).toEqual([]);
    } finally {
      await host.dispose();
    }
  }
}, 120_000);

it("falsifier: session/list excludes legacy sessions and session/load emits its response before restored readiness", async () => {
  // Outer budget 120_000 (matches this it()'s trailing argument below).
  const RPC_WAIT_MS = 120_000 - TEARDOWN_MARGIN_MS;
  const { host: first, root, env } = await freshHost();
  let second: ReturnType<typeof spawnRoomHost> | undefined;
  try {
    await initialize(first, "init", RPC_WAIT_MS);
    await first.send(rpc("new", "session/new", sessionParams(root)));
    const sessionId = record((await result(first, "new", RPC_WAIT_MS)).result).sessionId as string;
    await first.waitFor(
      (frame) => isRoomEvent(frame) && frame.params.eventSeq === "0",
      RPC_WAIT_MS,
    );
    await shutdown(first, sessionId, RPC_WAIT_MS);
    second = spawnRoomHost({ cwd: root, env });
    await initialize(second, "init-2", RPC_WAIT_MS);
    await second.send(rpc("list", "session/list", {}));
    expect(record((await result(second, "list", RPC_WAIT_MS)).result).sessions).toEqual([
      expect.objectContaining({ sessionId }),
    ]);
    await second.send(rpc("load", "session/load", { ...sessionParams(root), sessionId }));
    const loaded = await result(second, "load", RPC_WAIT_MS);
    const ready = await second.waitFor(
      (frame) => isRoomEvent(frame) && frame.params.eventSeq === "0",
      RPC_WAIT_MS,
    );
    expect(second.frames().indexOf(loaded)).toBeLessThan(second.frames().indexOf(ready));
    await shutdown(second, sessionId, RPC_WAIT_MS);
  } finally {
    await second?.dispose();
    await first.dispose();
  }
}, 120_000);

// FL-175 round-3 acceptance: measured RED at 47,137 ms against this test's own pre-existing 45,000 ms
// budget (never touched by rounds 1-3) on a run heavier than any earlier measurement this session —
// other individual tests in that same run ran 4-8x their typical cost. 120_000 ms is >=2.5x that.
it("falsifier: session/list returns only marked rooms in activity order", async () => {
  // Outer budget 120_000 (matches this it()'s trailing argument below).
  const RPC_WAIT_MS = 120_000 - TEARDOWN_MARGIN_MS;
  const { host, root } = await freshHost();
  try {
    const first = await listedSession(root, "2026-01-02T00:00:00.000Z", true);
    const second = await listedSession(root, "2026-01-02T00:00:00.000Z", true);
    const latest = await listedSession(
      root,
      "2026-01-03T00:00:00.000Z",
      true,
      "Design the real model and resume pickers",
    );
    await listedSession(root, "2026-01-04T00:00:00.000Z", false);
    await initialize(host, "list-order-init", RPC_WAIT_MS);
    await host.send(rpc("list-order", "session/list", {}));
    const sessions = record((await result(host, "list-order", RPC_WAIT_MS)).result)
      .sessions as Record<string, unknown>[];
    expect(sessions.map((session) => session.sessionId)).toEqual([
      latest.id,
      ...[first.id, second.id].sort((left, right) => right.localeCompare(left)),
    ]);
    expect(sessions[0]?.title).toBe("Design the real model and resume pickers");
  } finally {
    await host.dispose();
  }
}, 120_000);

// FL-175 round 2 F2 / round 3 F2: this falsifier's own 129-room writer (see listedRoomBatch's header)
// already trimmed the spawn count once. Round 3 asked whether the remaining 387 real git spawns (129
// rooms x 3, one resolveProjectId call per persistSession) can be cut further or the room count reduced.
// Checked both, in scope (test files only):
// - Room count is the contract itself: ROOM_SESSION_ROW_LIMIT is 128, so proving the cap needs >=129
//   distinguishable rooms; it is not a test-authoring choice.
// - Read zer0-v2-host.ts's list() handler directly: session/list is 100% filesystem (listSessions +
//   isV2Session + loadSession's transcript.json read) — it never queries the DB row
//   persistSessionEvidence/resolveProjectId writes. That write is real production behavior worth
//   exercising SOMEWHERE, but not per-room 129 times over for THIS falsifier's own claim, and there is
//   no test-side way to skip it without hand-writing transcript.json's format outside the real writer
//   (session-store.ts's TRANSCRIPT_FILE/JSON_INDENT/UTF8 constants are not exported) — a hand-rolled
//   fixture that can silently drift from the real writer is a worse trade than a bigger number. Cutting
//   the git-spawn cost itself would require a production change (e.g. caching resolveProjectId's result
//   within one process), out of this lane's scope.
// Sized the budget instead, per round 3's own fallback: measured 21.6-21.8s (this lane, clean box), 65.3s
// (dispatching lead's two alone-runs, 2026-09-01), 70.7s (4087a2f receipt), 105.3s (round-2 review),
// 159.8s (round-3 review, heaviest run yet). 360_000 ms is >=2.25x that round-3 worst case.
describe("falsifier: session/list keeps the newest 128 rooms within the Rust picker contract", () => {
  let host: ReturnType<typeof spawnRoomHost> | undefined;
  let root: string | undefined;
  let created: readonly ChatSession[] | undefined;
  // Round-3 nit: NOT rethrown from beforeAll — a rethrow leaves the it() "skipped" (hook failures hide
  // in the counts line) and afterAll crashing on an unassigned host masks the real cause. Recorded here
  // instead so the it() runs and fails loudly with an attributed message; afterAll only touches what
  // actually got assigned.
  let seedFailure: unknown;

  beforeAll(async () => {
    try {
      const fresh = await freshHost();
      host = fresh.host;
      root = fresh.root;
      // Pulled out of the shared cleanupRoots (afterAll below owns dispose-then-cleanup ordering
      // directly) — guarded so an absent root can't fall through to splicing the array's last entry.
      const index = cleanupRoots.indexOf(root);
      if (index !== -1) cleanupRoots.splice(index, 1);
      created = await listedRoomBatch(root, 129);
      // Sole RPC round trip in this hook; the 129-room write above is the real cost, so this can take
      // almost the whole 360_000 ms hook budget without touching the seed's own headroom.
      await initialize(host, "bounded-list-init", 360_000 - TEARDOWN_MARGIN_MS);
    } catch (error) {
      seedFailure = error;
    }
  }, 360_000);

  afterAll(async () => {
    await host?.dispose();
    if (root !== undefined) await cleanupTestRoot(root);
  });

  it("keeps the newest 128 of 129 within the Rust picker contract", async () => {
    // Outer budget 30_000 (matches this it()'s trailing argument below). Round-4 fix: this call
    // previously hardcoded 30_000 inside result()'s own default — identical to the outer test budget,
    // so the inner wait could never itself be the first thing to fire; now explicit and derived.
    const RPC_WAIT_MS = 30_000 - TEARDOWN_MARGIN_MS;
    if (seedFailure !== undefined || host === undefined || created === undefined) {
      throw new Error(`the 129-room seed never completed: ${String(seedFailure)}`);
    }
    await host.send(rpc("bounded-list", "session/list", {}));
    const sessions = record((await result(host, "bounded-list", RPC_WAIT_MS)).result)
      .sessions as Record<string, unknown>[];
    assertBounded128(sessions, created);
  }, 30_000);
});

function assertBounded128(
  sessions: readonly Record<string, unknown>[],
  created: readonly ChatSession[],
): void {
  expect(sessions).toHaveLength(128);
  expect(sessions.map((session) => session.sessionId)).toEqual(
    created
      .slice(1)
      .reverse()
      .map((session) => session.id),
  );
  expect(
    sessions.every(
      (session) => Object.keys(session).sort().join(",") === "cwd,sessionId,title,updatedAt",
    ),
  ).toBe(true);
}

it("falsifier: cleanup recovers once a live child's CWD lock releases", async () => {
  // Reproduces the real defect this room hit under load: a still-exiting host held its temp root as its
  // CWD, so the afterEach's rm() raced it and lost with EBUSY. This pins RECOVERY — a lock that clears
  // mid-retry does not leave the root behind — not any specific retry width; it passes at the old 5/100
  // budget too (round-2 F9/F10). The exhaustion falsifier below is what pins cleanupTestRoot's own
  // deadline. The child is killed EXPLICITLY (not on its own timer), and cleanup starts before the kill,
  // so nothing here depends on how long an OS handle release happens to take.
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-process-cleanup-"));
  const lockedCwd = path.join(root, "child-cwd");
  await mkdir(lockedCwd, { recursive: true });
  const child = spawn(process.execPath, ["-e", LOCK_HOLDER_SRC], {
    cwd: lockedCwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Outer budget 30_000 (matches this it()'s trailing argument below), minus the teardown margin.
  await lockTakenHold(child, 30_000 - TEARDOWN_MARGIN_MS);
  await expect(rm(root, { recursive: true, force: false, maxRetries: 0 })).rejects.toMatchObject({
    code: "EBUSY",
  });
  const cleanup = cleanupTestRoot(root);
  child.kill();
  await cleanup;
  expect(existsSync(root)).toBe(false);
}, 30_000);

it("falsifier: cleanup gives up within its own deadline and names the path plus the last error", async () => {
  // F4: proves cleanupTestRoot owns a HARD deadline (round-2 correction — fs.rm's own maxRetries/
  // retryDelay backoff is not linear and was measured retrying past 900_000 ms against a lock that never
  // cleared). The child here outlives that deadline on purpose, so the retry loop must exhaust and
  // rethrow rather than hang — proof the fix actually bounds the span, not just that a retry exists.
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-process-cleanup-stuck-"));
  const lockedCwd = path.join(root, "child-cwd");
  await mkdir(lockedCwd, { recursive: true });
  const child = spawn(process.execPath, ["-e", LOCK_HOLDER_STUCK_SRC], {
    cwd: lockedCwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Outer budget 20_000 (this it()'s trailing argument) minus the teardown margin; never a fixed sleep.
  await lockTakenHold(child, 20_000 - TEARDOWN_MARGIN_MS);
  const started = Date.now();
  let caught: Error | undefined;
  try {
    await cleanupTestRoot(root);
  } catch (error) {
    caught = error instanceof Error ? error : new Error(String(error));
  }
  const elapsed = Date.now() - started;
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  expect(caught?.message).toContain(root);
  expect(caught?.message).toContain("EBUSY");
  // Proves the bound is real, not merely documented — coupled to CLEANUP_DEADLINE_MS (see
  // CLEANUP_EXHAUSTION_CEILING_MS above) so raising that constant can't silently thin this margin again.
  expect(elapsed).toBeLessThan(CLEANUP_EXHAUSTION_CEILING_MS);
}, 20_000);

async function listedSession(
  root: string,
  updatedAt: string,
  marked: boolean,
  firstPrompt?: string,
) {
  const created = await createSession(root);
  const withPrompt =
    firstPrompt === undefined ? created : appendMessage(created, createUserMessage(1, firstPrompt));
  const session = { ...withPrompt, updatedAt };
  await persistSession(session);
  if (marked)
    await writeFile(
      path.join(session.runDir, "zer0-v2-room.json"),
      JSON.stringify({ version: 1 }),
      "utf8",
    );
  return session;
}

/** The 129-room fixture for the picker cap. `listedSession` persists every room TWICE (once inside
 * createSession, once for the overridden updatedAt/title) and each persist spawns three git processes
 * for the evidence project id — 774 spawns on Windows, which put this falsifier at 45–50 s of its 60 s
 * budget inside the 4-fork pool and over it under any extra machine load (verify:staged tree 07219d5,
 * RED twice). Here every room is written through the store's own writer exactly once; the layout comes
 * from one real createSession (no store paths hard-coded here); rooms are written in bounded batches so
 * 129 concurrent git spawns never thrash the host. session/list reads only what this writes: the run
 * directory, its transcript, and the room marker. */
async function listedRoomBatch(
  root: string,
  count: number,
  batch = 8,
): Promise<readonly ChatSession[]> {
  const seed = await createSession(root);
  const runsDir = path.dirname(seed.runDir);
  const rooms: ChatSession[] = [];
  for (let start = 0; start < count; start += batch) {
    const indices = Array.from({ length: Math.min(batch, count - start) }, (_, i) => start + i);
    rooms.push(
      ...(await Promise.all(
        indices.map(async (index) => {
          const id = `chat-${String(Date.now())}-${randomUUID()}` as const;
          const runDir = path.join(runsDir, id);
          await mkdir(runDir, { recursive: true });
          const withPrompt = appendMessage(
            { ...seed, id, runDir },
            createUserMessage(1, `Room ${String(index).padStart(3, "0")}`),
          );
          const session: ChatSession = {
            ...withPrompt,
            updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          };
          await persistSession(session);
          await writeFile(
            path.join(runDir, "zer0-v2-room.json"),
            JSON.stringify({ version: 1 }),
            "utf8",
          );
          return session;
        }),
      )),
    );
  }
  return rooms;
}

async function freshHost(): Promise<{
  readonly host: ReturnType<typeof spawnRoomHost>;
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-process-"));
  cleanupRoots.push(root);
  await execa("git", ["init", "-q"], { cwd: root, shell: false });
  const env = {
    HOME: path.join(root, ".home"),
    USERPROFILE: path.join(root, ".home"),
    ZER0_BLOB_ROOT: path.join(root, ".zer0-test", "blobs"),
    ZER0_DB_PATH: path.join(root, ".zer0-test", "evidence.db"),
    ZER0_STATUSLINE_DIR: path.join(root, ".zer0-test", "statusline"),
  };
  return { host: spawnRoomHost({ cwd: root, env }), root, env };
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
  waitMs: number,
): Promise<void> {
  await host.send(rpc(id, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
  await result(host, id, waitMs);
}
async function shutdown(
  host: ReturnType<typeof spawnRoomHost>,
  sessionId: string,
  waitMs: number,
): Promise<void> {
  await host.send(rpc("shutdown", "zer0/room/shutdown", { sessionId }));
  await result(host, "shutdown", waitMs);
}
// FL-175 round 4: waitMs is a mandatory call-site argument (no default) so a caller cannot silently
// inherit a stale guess — every call site above derives it from its own test's outer budget.
async function result(
  host: ReturnType<typeof spawnRoomHost>,
  id: string | number,
  waitMs: number,
): Promise<RoomHostFrame> {
  return host.waitFor((frame) => frame.id === id && Object.hasOwn(frame, "result"), waitMs);
}
function error(frame: RoomHostFrame): Record<string, unknown> {
  return record(frame.error);
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
function isProtocolFrame(frame: RoomHostFrame): boolean {
  return (
    frame.jsonrpc === "2.0" &&
    (typeof frame.id === "string" || typeof frame.id === "number" || frame.id === null
      ? Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")
      : isRoomEvent(frame))
  );
}
async function waitFor(
  predicate: () => boolean,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<void> {
  await pollUntil(predicate, { timeoutMs, message: "condition did not arrive before timeout" });
}
