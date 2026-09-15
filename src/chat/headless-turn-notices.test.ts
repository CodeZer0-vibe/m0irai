/**
 * @file src/chat/headless-turn-notices.test.ts
 * @purpose MN round 2b: proves the room-reachable non-carrier lane (`runNonCarrierLane`) actually
 *   publishes the notices `composePrompt` classifies onto the room bus, the same way
 *   `headless-carrier.ts` already does for the carrier lane's trace. Round 2 made
 *   `memory-db-open-failed` a real, classified `RoomNotice` value; this proves it now reaches
 *   `room.notice` on the bus that `room-host-support.ts`'s `createRoomBus` joins to
 *   `RoomEngine.notice`.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant, ./events, ./evidence-identity, ./evidence, ./headless-turn, ./types
 *
 * Split from headless-turn.test.ts (that file is already at the top of its own @size-justified
 * 500-600 band) rather than adding to it — same seam headless-prompt-notices.test.ts already used
 * in round 2 for the identical reason.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { type ChatEvent, ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import type { ChatSession } from "./types.js";

// Only `openMemoryDb` is mocked to fail — `finalizeLane`/`recordChatMessage`'s own evidence writes go
// through `openDb`, a DIFFERENT exported function from the same module (evidence.ts:87,143,218,313),
// so this does not touch the rest of the turn's persistence.
const dbOpenFails = { value: false };

vi.mock("../evidence/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evidence/db.js")>();
  return {
    ...actual,
    openMemoryDb: (...args: Parameters<typeof actual.openMemoryDb>) => {
      if (dbOpenFails.value) throw new Error("SQLITE_CORRUPT: evidence db would not open");
      return actual.openMemoryDb(...args);
    },
  };
});

const savedMemory = process.env.ZER0_MEMORY;
const dirs: string[] = [];

afterEach(async () => {
  dbOpenFails.value = false;
  if (savedMemory === undefined) Reflect.deleteProperty(process.env, "ZER0_MEMORY");
  else process.env.ZER0_MEMORY = savedMemory;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeSession(): Promise<{ session: ChatSession; dbPath: string; blobRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "headless-turn-notices-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-headless-notices-test" as const;
  await recordChatSession({
    dbPath,
    sessionId: id,
    runId: chatRunId(id),
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const session: ChatSession = {
    id,
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  return { session, dbPath, blobRoot };
}

it("a memory DB that fails to open reaches the room as a room.notice event on the bus", async () => {
  const { session, dbPath, blobRoot } = await makeSession();
  const bus = new ChatEventBus();
  const notices: ChatEvent[] = [];
  bus.on("room.notice", (event) => notices.push(event));
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => ({
    stdout: "the answer",
    exitCode: 0,
  });
  process.env.ZER0_MEMORY = "1";
  dbOpenFails.value = true;

  await runHeadlessTurn({
    session,
    addresses: [{ agent: "claude", prompt: "hello" }],
    bus,
    turn: 1,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: { dbPath, blobRoot },
    signal: new AbortController().signal,
    dispatch,
  });

  expect(notices).toEqual([
    {
      kind: "room.notice",
      cause: "memory-db-open-failed",
      turn: 1,
      agent: "claude",
      detail: "SQLITE_CORRUPT: evidence db would not open",
    },
  ]);
});
