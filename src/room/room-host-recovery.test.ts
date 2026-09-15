import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { chatRunId, recordChatMessage, recordChatSession } from "../chat/evidence.js";
import type { ChatMessage, ChatSession } from "../chat/types.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { mintSeq } from "../memory/ledger.js";
import type { RoomEvent } from "./room-engine-contract.js";
import { reconcileRoomRecovery } from "./room-host-recovery.js";
import { validateRoomEvent } from "./room-protocol.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(): ChatSession {
  return {
    id: "chat-recovery-host",
    repoRoot: "/repo",
    runDir: "/repo/run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}

function event(seq: number): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId: "chat-recovery-host",
    eventSeq: String(seq),
    eventId: `event-${seq}`,
    turnId: "turn-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "session.saved",
    payload: {},
  };
}

it("returns the journal untouched and writes nothing when no carrier runtime owns the db", async () => {
  const journal = [event(1), event(2)];
  const persistSession = vi.fn(async (_session: ChatSession) => undefined);
  const appendEvent = vi.fn(async () => undefined);
  const result = await reconcileRoomRecovery(
    {
      dbPath: "/nowhere/evidence.db",
      blobRoot: "/nowhere/blobs",
      session: session(),
      journal,
      persistSession,
      appendEvent,
    },
    undefined,
  );
  expect(result).toBe(journal);
  expect(persistSession).not.toHaveBeenCalled();
  expect(appendEvent).not.toHaveBeenCalled();
});

it("with an owner whose ledger holds nothing for the room, repairs to an equal session, persists it once, appends nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-recovery-"));
  roots.push(root);
  const db = openLaneStateDb(path.join(root, "evidence.db"));
  try {
    const current = session();
    const persistSession = vi.fn(async (_session: ChatSession) => undefined);
    const appendEvent = vi.fn(async () => undefined);
    const result = await reconcileRoomRecovery(
      {
        dbPath: path.join(root, "evidence.db"),
        blobRoot: path.join(root, "blobs"),
        session: current,
        journal: [],
        persistSession,
        appendEvent,
      },
      { db, projectId: "project-recovery-host" },
    );
    expect(result).toEqual([]);
    // Pre-existing behaviour, preserved by the extraction: repair returns a NEW (equal) messages array,
    // so the identity check persists the session once per boot even when nothing changed.
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(persistSession.mock.calls[0]?.[0]).toEqual({ ...current, messages: [] });
    expect(appendEvent).not.toHaveBeenCalled();
  } finally {
    closeDb(db);
  }
});

/** Writes one durable ledger row (chat_sessions parent row, chat_messages, a minted ledger_seq) directly
 *  on `db`, bypassing the global carrier registry `recordChatMessage` normally requires — this test owns
 *  its db handle instead. The chat_sessions row is the FK `chat_messages.session_id` needs to exist. */
async function seedLedgerMessage(
  dbPath: string,
  blobRoot: string,
  db: ReturnType<typeof openLaneStateDb>,
  projectId: string,
  message: Pick<ChatMessage, "id" | "turn" | "text">,
): Promise<void> {
  await recordChatSession({
    dbPath,
    sessionId: "chat-recovery-host",
    runId: chatRunId("chat-recovery-host"),
    repoRoot: "/repo",
    runDir: "/repo/run",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const written = await recordChatMessage({
    dbPath,
    blobRoot,
    sessionId: "chat-recovery-host",
    messageId: message.id,
    turn: message.turn,
    role: "user",
    agent: "user",
    text: message.text,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
    dispatchedAgents: ["claude"],
  });
  if (written !== message.id) throw new Error("test fixture: ledger message write was swallowed");
  // ledger_seq.project_id is a FK into projects(project_id) (migrations-v16.test.ts's own insertProject
  // fixture does the same before minting) — a real boot resolves this row via resolveBootLiveness; this
  // unit test mints directly, so it seeds the parent row itself.
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run(projectId, "/repo", "/repo/.git", "2026-01-01T00:00:00.000Z");
  mintSeq(db, projectId, message.id);
}

// SEAM-1 (D:/m0irai-evidence/wave1/lanes-0901/sl-review-r3.md:26-70): `repaired.session.messages ===
// input.session.messages` is never true — `mergeTranscript` always returns a fresh array — so a notice
// gated on that reference check would fire on every healthy attach and never on a genuine empty rebuild.
// These two cases are the falsifier: RED on `45a04c6`, where no notice-emission code exists at all.

it("RED/GREEN: a rebuild that restores messages the shell did not arrive with appends exactly one room.notice, N computed by content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-recovery-notice-"));
  roots.push(root);
  const dbPath = path.join(root, "evidence.db");
  const blobRoot = path.join(root, "blobs");
  const db = openLaneStateDb(dbPath);
  try {
    const projectId = "project-recovery-notice-restored";
    await seedLedgerMessage(dbPath, blobRoot, db, projectId, {
      id: "msg-restored-1",
      turn: 1,
      text: "hello",
    });
    const current = session();
    const persistSession = vi.fn(async (_session: ChatSession) => undefined);
    const appendEvent = vi.fn(async () => undefined);
    const result = await reconcileRoomRecovery(
      {
        dbPath,
        blobRoot,
        session: current,
        journal: [],
        persistSession,
        appendEvent,
      },
      { db, projectId },
    );
    const notices = result.filter((event) => event.type === "room.notice");
    expect(notices).toHaveLength(1);
    const notice = notices[0] as RoomEvent;
    expect(() => validateRoomEvent(notice)).not.toThrow();
    expect(notice.payload.cause).toBe("room-rebuilt-from-ledger");
    expect(typeof notice.payload.detail).toBe("string");
    expect(notice.payload.detail as string).toContain(
      "room chat-recovery-host was rebuilt from the evidence ledger: 1 messages restored to its transcript.",
    );
    // The notice is durably appended through the same capacity-checked write path as every other
    // recovery event — never a side channel the journal on disk would disagree with.
    expect(appendEvent).toHaveBeenCalledWith(notice);
  } finally {
    closeDb(db);
  }
});

it("RED/GREEN: a rebuild whose content the input session already had emits no notice, even though repair returns a NEW (unequal-by-reference) messages array", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zer0-room-host-recovery-notice-"));
  roots.push(root);
  const dbPath = path.join(root, "evidence.db");
  const blobRoot = path.join(root, "blobs");
  const db = openLaneStateDb(dbPath);
  try {
    const projectId = "project-recovery-notice-nochange";
    await seedLedgerMessage(dbPath, blobRoot, db, projectId, {
      id: "msg-present-1",
      turn: 1,
      text: "already here",
    });
    const alreadyPresent: ChatMessage = {
      id: "msg-present-1",
      turn: 1,
      role: "user",
      agent: "user",
      text: "already here",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      tokenEstimate: 1,
      dispatchedAgents: ["claude"],
    };
    const current: ChatSession = { ...session(), messages: [alreadyPresent] };
    const persistSession = vi.fn(async (_session: ChatSession) => undefined);
    const appendEvent = vi.fn(async () => undefined);
    const result = await reconcileRoomRecovery(
      {
        dbPath,
        blobRoot,
        session: current,
        journal: [],
        persistSession,
        appendEvent,
      },
      { db, projectId },
    );
    expect(result.some((event) => event.type === "room.notice")).toBe(false);
  } finally {
    closeDb(db);
  }
});
