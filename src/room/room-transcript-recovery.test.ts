/**
 * @file src/room/room-transcript-recovery.test.ts
 * @purpose Falsifiers for reopening a room whose transcript is damaged: quarantine, rebuild, or refuse — never hide.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it, vi } from "vitest";

const readFileFailures = new Map<string, NodeJS.ErrnoException>();
/**
 * Rewrites one path's content on a chosen read, so a file can change BETWEEN the read that classifies
 * it and any later read of the same path. That window is the whole of finding 2.
 */
const readFileSwaps = new Map<string, { onCall: number; content: Buffer; calls: number }>();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: async (file: unknown, options?: unknown) => {
      const forced = readFileFailures.get(String(file));
      if (forced !== undefined) throw forced;
      const swap = readFileSwaps.get(String(file));
      if (swap !== undefined) {
        swap.calls += 1;
        if (swap.calls >= swap.onCall) {
          await actual.writeFile(file as string, swap.content);
          return options === undefined || options === null
            ? swap.content
            : swap.content.toString("utf8");
        }
      }
      return actual.readFile(file as string, options as never);
    },
  };
});

const { openRoomTranscript, quarantinePathFor } = await import("./room-transcript-recovery.js");
const { appendMessage, createSession, loadSession, persistSession } = await import(
  "../chat/session-store.js"
);
const { createUserMessage } = await import("../chat/commands.js");
const { recordChatMessage } = await import("../chat/evidence.js");
const { AliveRoomHost } = await import("./room-host.js");
const { cleanupTestRoot } = await import("./room-test-cleanup.fixtures.js");

type RoomHostOptions = Parameters<typeof AliveRoomHost.create>[0];
type HeadlessTurnInput = Parameters<NonNullable<RoomHostOptions["runHeadlessTurn"]>>[0];

const roots: string[] = [];
const reported: string[] = [];
const SHUTDOWN_TIMEOUT_MS = 40_000;

afterEach(async () => {
  readFileFailures.clear();
  readFileSwaps.clear();
  reported.length = 0;
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function gitRoot(prefix: string): Promise<string> {
  const root = await freshRoot(prefix);
  await execa("git", ["init"], { cwd: root, shell: false });
  return root;
}

function roomPaths(root: string): { readonly dbPath: string; readonly blobRoot: string } {
  return {
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
  };
}

function open(sessionId: `chat-${string}`, repoRoot: string) {
  return openRoomTranscript({
    sessionId,
    repoRoot,
    report: (line) => reported.push(line),
  });
}

async function damagedFiles(runDir: string): Promise<readonly string[]> {
  return (await readdir(runDir)).filter((name) => name.startsWith("transcript.damaged-"));
}

it("a healthy room opens exactly as it was saved, with nothing quarantined", async () => {
  const root = await freshRoot("sl-open-healthy-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "still here")));

  const opened = await open(created.id, root);
  expect(opened.messages.map((message) => message.text)).toEqual(["still here"]);
  expect(reported).toEqual([]);
  expect(await damagedFiles(created.runDir)).toEqual([]);
});

it("falsifier: a torn transcript is copied aside byte-for-byte before the room reopens", async () => {
  const root = await freshRoot("sl-open-torn-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "the lost turn")));
  const transcript = path.join(created.runDir, "transcript.json");
  const whole = await readFile(transcript, "utf8");
  const torn = whole.slice(0, Math.floor(whole.length * 0.6));
  await writeFile(transcript, torn, "utf8");

  const opened = await open(created.id, root);

  const quarantined = await damagedFiles(created.runDir);
  expect(quarantined).toHaveLength(1);
  expect(await readFile(path.join(created.runDir, quarantined[0] ?? ""), "utf8")).toBe(torn);
  expect(opened.id).toBe(created.id);
  expect(opened.messages).toEqual([]);
  expect(reported).toHaveLength(1);
  expect(reported[0]).toContain(created.id);
  expect(reported[0]).toContain("transcript.damaged-");
});

it("falsifier: the rebuilt shell keeps the room's own place in the list, not today's date", async () => {
  const root = await freshRoot("sl-open-stamp-");
  const created = await createSession(root);
  // A room with real turns, so the 60% cut lands deep inside `messages` and well past the header the
  // stamp is read from — the same shape a crash mid-write leaves behind.
  const withTurns = appendMessage(created, createUserMessage(1, "x".repeat(4_000)));
  await persistSession({ ...withTurns, updatedAt: "2026-02-03T04:05:06.000Z" });
  const transcript = path.join(created.runDir, "transcript.json");
  const whole = await readFile(transcript, "utf8");
  await writeFile(transcript, whole.slice(0, Math.floor(whole.length * 0.6)), "utf8");

  expect((await open(created.id, root)).updatedAt).toBe("2026-02-03T04:05:06.000Z");
});

it("falsifier: a transcript that cannot be copied is left untouched and the attach refuses", async () => {
  const root = await freshRoot("sl-open-locked-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "possibly intact")));
  const transcript = path.join(created.runDir, "transcript.json");
  const before = await readFile(transcript, "utf8");
  readFileFailures.set(
    transcript,
    Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
  );

  const failure = await open(created.id, root).catch((error: unknown) => error);
  readFileFailures.clear();

  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(created.id);
  expect(message).toContain("EACCES");
  expect(message).toContain("left untouched");
  expect(await readFile(transcript, "utf8")).toBe(before);
  expect(await damagedFiles(created.runDir)).toEqual([]);
  expect(reported).toEqual([]);
});

it("falsifier: a room with no transcript is named, never answered as a generic failure", async () => {
  const root = await freshRoot("sl-open-absent-");
  const created = await createSession(root);
  await rm(path.join(created.runDir, "transcript.json"), { force: true });

  const failure = await open(created.id, root).catch((error: unknown) => error);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(created.id);
  expect(message).toContain("transcript.json");
  expect(message).not.toBe("internal error");
  expect((failure as { jsonRpcCode?: number }).jsonRpcCode).toBe(-32603);
});

// SL-1 (review round 1): "unreadable" used to cover four different facts, two of which fire on files
// whose bytes are perfectly good. Quarantining those and opening the room EMPTY presents intact history
// as a lost conversation. Intact bytes must never be copied aside; the attach refuses and says why.
it("falsifier: an intact transcript under the wrong session id refuses the attach and is not quarantined", async () => {
  const root = await freshRoot("sl-open-mismatch-");
  const created = await createSession(root);
  const kept = appendMessage(created, createUserMessage(1, "SIX MONTHS OF WORK"));
  await persistSession({ ...kept, id: "chat-1700000000000-copied-from-another-room" });
  const transcript = path.join(created.runDir, "transcript.json");
  const before = await readFile(transcript, "utf8");
  expect(JSON.parse(before).messages[0].text).toBe("SIX MONTHS OF WORK");

  const failure = await open(created.id, root).catch((error: unknown) => error);

  const message = failure instanceof Error ? failure.message : "";
  expect(message).toMatch(/mismatch/u);
  expect(message).toContain(created.id);
  expect(await readFile(transcript, "utf8")).toBe(before);
  expect(await damagedFiles(created.runDir)).toEqual([]);
  expect(reported).toEqual([]);
});

it("falsifier: an intact transcript the current schema rejects refuses the attach and is not quarantined", async () => {
  const root = await freshRoot("sl-open-skew-");
  const created = await createSession(root);
  const transcript = path.join(created.runDir, "transcript.json");
  // Schema skew: valid JSON, every message intact, one top-level member the current schema requires
  // written in a shape a different build produced. This is ordinary work on ChatSession, not corruption.
  const skewed = JSON.parse(await readFile(transcript, "utf8"));
  skewed.messages = [
    {
      id: "msg-1",
      turn: 1,
      role: "user",
      agent: "user",
      text: "SIX MONTHS OF WORK",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      tokenEstimate: 1,
    },
  ];
  skewed.summary = { text: "", throughTurn: 0, unknownFutureMember: [] };
  delete skewed.defaultAgent;
  const before = `${JSON.stringify(skewed, null, 2)}`;
  await writeFile(transcript, before, "utf8");

  const failure = await open(created.id, root).catch((error: unknown) => error);

  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(created.id);
  expect(message).toMatch(/shape|schema|defaultAgent/u);
  expect(await readFile(transcript, "utf8")).toBe(before);
  expect(await damagedFiles(created.runDir)).toEqual([]);
  expect(reported).toEqual([]);
});

it("falsifier: a transcript locked by another holder refuses the attach without quarantining it", async () => {
  const root = await freshRoot("sl-open-locked-race-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "healthy and held open")));
  const transcript = path.join(created.runDir, "transcript.json");
  const before = await readFile(transcript, "utf8");
  // The SL-2 race the reviewer suspected: the classify read fails on a transient lock and the
  // quarantine read then succeeds because the lock cleared, copying a HEALTHY file aside. A sharing
  // failure now refuses outright, so the second read never happens and the window cannot open.
  readFileFailures.set(
    transcript,
    Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
  );
  const failure = await open(created.id, root).catch((error: unknown) => error);
  readFileFailures.clear();

  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain("EBUSY");
  expect(await readFile(transcript, "utf8")).toBe(before);
  expect(await damagedFiles(created.runDir)).toEqual([]);
});

// Round 3, finding 1 (codex H: HOST_invalid-utf8 — attachSucceeded:true, rawUnchanged:false,
// backups:[]). Reading the transcript as a UTF-8 STRING substitutes U+FFFD for every invalid byte, so
// a file with a 0xFF in it parses, loads, and is silently rewritten without its original bytes.
it("falsifier: a transcript holding bytes that are not valid UTF-8 is damaged, not silently repaired", async () => {
  const root = await freshRoot("sl-open-utf8-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "history with a raw byte")));
  const transcript = path.join(created.runDir, "transcript.json");
  const good = await readFile(transcript);
  // One byte no UTF-8 decoder can accept, inside a string value so the document still parses.
  const corrupted = Buffer.from(good);
  corrupted[good.indexOf(Buffer.from("history"))] = 0xff;
  await writeFile(transcript, corrupted);

  const opened = await open(created.id, root).catch(() => undefined);

  const quarantined = await damagedFiles(created.runDir);
  expect(quarantined).toHaveLength(1);
  expect(await readFile(path.join(created.runDir, quarantined[0] ?? ""))).toEqual(corrupted);
  expect(opened?.messages ?? []).toEqual([]);
  expect(reported[0]).toContain(created.id);
});

// Round 3, finding 2 (codex H: HOST_healthy-race — validSameRoomBackups:1, returnedMessages:0). The
// quarantine used to re-read the path instead of copying the bytes it had already classified, so a
// file replaced in between was copied aside and then overwritten with an empty room.
it("falsifier: the quarantine holds the bytes that were classified, not whatever the path holds later", async () => {
  const root = await freshRoot("sl-open-swap-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "OLD COMPLETE")));
  const transcript = path.join(created.runDir, "transcript.json");
  const healthy = await readFile(transcript);
  const torn = Buffer.from(healthy.toString("utf8").slice(0, Math.floor(healthy.length * 0.6)));
  await writeFile(transcript, torn);
  // The classifier reads the torn bytes; a healthy same-room transcript lands before any later read.
  readFileSwaps.set(transcript, { onCall: 2, content: healthy, calls: 0 });

  await open(created.id, root).catch(() => undefined);

  const quarantined = await damagedFiles(created.runDir);
  expect(quarantined).toHaveLength(1);
  // The torn bytes are what was judged damaged, so the torn bytes are what may be copied aside.
  expect(await readFile(path.join(created.runDir, quarantined[0] ?? ""))).toEqual(torn);
});

// Round 3, finding 3 (codex H: HOST_no-ledger and HOST_journal-only). The line claimed the room "was
// rebuilt from the evidence ledger" BEFORE the rebuild ran, and it ran after a failure or produced an
// empty room. The sentence must only assert what is already true when it is printed.
it("falsifier: the recovery notice never claims a rebuild that has not happened yet", async () => {
  const root = await freshRoot("sl-open-claim-");
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "the lost turn")));
  const transcript = path.join(created.runDir, "transcript.json");
  const whole = await readFile(transcript, "utf8");
  await writeFile(transcript, whole.slice(0, Math.floor(whole.length * 0.6)), "utf8");

  await open(created.id, root);

  expect(reported).toHaveLength(1);
  const line = reported[0] ?? "";
  expect(line).not.toMatch(/was rebuilt/u);
  // What IS true at that moment: the bytes are saved, and the outcome is not yet known.
  expect(line).toContain("transcript.damaged-");
  expect(line).toMatch(/before anything else/u);
  expect(line).toMatch(/may reopen empty|if the ledger/u);
});

it("two quarantines of the same room never collide", () => {
  const at = new Date("2026-02-03T04:05:06.000Z");
  expect(quarantinePathFor("C:/room", at)).not.toBe(quarantinePathFor("C:/room", at));
  expect(quarantinePathFor("C:/room", at)).toMatch(
    /transcript\.damaged-2026-02-03T04-05-06-000Z-/u,
  );
});

/** A turn that commits one agent reply to the evidence ledger, the durable side of the recovery. */
function ledgerBackedTurn(dbPath: string, blobRoot: string) {
  return async (input: HeadlessTurnInput) => {
    const messageId = input.messageId;
    if (messageId === undefined) throw new Error("fixture needs a durable message identity");
    const outcome = {
      agent: "claude" as const,
      text: "the durable answer",
      exitCode: 0,
      state: "completed" as const,
      messageId,
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
    };
    await recordChatMessage({
      dbPath,
      blobRoot,
      sessionId: input.session.id,
      messageId,
      turn: input.turn,
      role: "agent",
      agent: "claude",
      text: outcome.text,
      createdAt: outcome.messageCreatedAt,
      status: "completed",
      tokenEstimate: 1,
    });
    await input.onLaneSettled?.("claude", outcome);
    return [outcome];
  };
}

const READY_EAGER_BOOT = () => ({
  claude: Promise.resolve({ outcome: "ready" as const }),
  codex: Promise.resolve({ outcome: "ready" as const }),
  gemini: Promise.resolve({ outcome: "ready" as const }),
});

/** Truncates the room's transcript the way a crash mid-write does, and proves it no longer loads. */
async function tearTranscript(runDir: string, sessionId: `chat-${string}`, repoRoot: string) {
  const transcript = path.join(runDir, "transcript.json");
  const whole = await readFile(transcript, "utf8");
  expect(whole).toContain("the durable answer");
  await writeFile(transcript, whole.slice(0, Math.floor(whole.length * 0.6)), "utf8");
  await expect(loadSession(sessionId, repoRoot)).rejects.toThrow();
}

it("falsifier: a room whose transcript is torn reopens with the turn the ledger still holds", async () => {
  const root = await gitRoot("sl-open-rebuild-");
  const { dbPath, blobRoot } = roomPaths(root);
  const first = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    runHeadlessTurn: ledgerBackedTurn(dbPath, blobRoot),
  });
  const sessionId = first.sessionId() as `chat-${string}`;
  await first.submit({ requestId: "rebuild-1", text: "@claude answer" });
  await first.shutdown();

  const runDir = path.join(root, ".council", "runs", sessionId);
  await tearTranscript(runDir, sessionId, root);

  const stderr: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const reopened = await AliveRoomHost.create({
    repoRoot: root,
    dbPath,
    blobRoot,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    continueSessionId: sessionId,
    startEagerSessionBoot: READY_EAGER_BOOT,
  });
  spy.mockRestore();
  try {
    const restored = await loadSession(sessionId, root);
    expect(restored.messages.map((message) => message.text)).toContain("the durable answer");
    expect((await damagedFiles(runDir))[0]).toBeDefined();
    expect(stderr.filter((line) => line.includes(sessionId))).not.toHaveLength(0);
  } finally {
    await reopened.shutdown();
  }
}, 120_000);
