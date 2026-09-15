/**
 * @file src/chat/headless-prompt-notices.test.ts
 * @purpose MN fix round 2 (I-2, reviewer-confirmed): `memory-db-open-failed` and
 *   `memory-project-resolve-failed` were declared causes in the shared vocabulary
 *   (src/shared/room-notice.ts) with a fixed phrase in the Rust view, but the ONLY place either was
 *   ever minted (headless-prompt.ts) just logged and returned — no RoomNotice value was ever
 *   constructed for either one anywhere in the tree. These tests prove composePrompt now actually
 *   classifies and mints one (collectible through the optional `notices` out-array), and that a
 *   durable-log write failure is no longer silently discarded either.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ../evidence/db, ../shared/room-notice, ./headless-prompt, ./memory-failure-log, ./types
 *
 * Split out of headless-prompt.test.ts (gate-clamps' 500-line soft ceiling) once this lane added a
 * fourth describe block — same seam that file's own header already documents for T7's redirect suite.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomNotice } from "../shared/room-notice.js";
import { composePrompt } from "./headless-prompt.js";
import { memoryFailureLogPath } from "./memory-failure-log.js";
import type { ChatMessage, ChatSession } from "./types.js";

// `resolveSessionProject` throws only when a real, already-open db's own project/session queries
// fail — the shape of a corrupt PROJECTS table on an otherwise-healthy database, distinct from the
// DB-open failure the other tests below cover. Reused pattern: the same hostile-`prepare` proxy
// `lane-carrier.test.ts`'s R5b-05 suite already uses, scoped by a flag so every OTHER test in this
// file opens a completely real, unproxied db.
const projectResolveFails = { value: false };

vi.mock("../evidence/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evidence/db.js")>();
  return {
    ...actual,
    openMemoryDb: (...args: Parameters<typeof actual.openMemoryDb>) => {
      const real = actual.openMemoryDb(...args);
      if (!projectResolveFails.value) return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (/FROM (chat_sessions|projects)\b/i.test(sql)) {
                throw new Error("SQLITE_CORRUPT: projects is malformed");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const savedMemory = process.env.ZER0_MEMORY;
let tempRoot: string | undefined;

beforeEach(() => {
  process.env.ZER0_MEMORY = "off";
});

afterEach(() => {
  projectResolveFails.value = false;
  if (savedMemory === undefined) Reflect.deleteProperty(process.env, "ZER0_MEMORY");
  else process.env.ZER0_MEMORY = savedMemory;
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    tempRoot = undefined;
  }
});

function msg(role: "user" | "agent", agent: ChatMessage["agent"], text: string): ChatMessage {
  return {
    id: `m-${text}`,
    turn: 1,
    role,
    agent,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
  };
}

function sessionWith(messages: ChatMessage[], repoRoot: string): ChatSession {
  return {
    id: "chat-cp",
    repoRoot,
    runDir: `${repoRoot}/run`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages,
  };
}

describe("composePrompt — memory notice producers, mint (MN fix round 2, I-2)", () => {
  it("mints a memory-db-open-failed notice, not just a log line, when the db cannot be opened", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-open-notice-"));
    process.env.ZER0_MEMORY = "1";
    const notices: RoomNotice[] = [];
    const out = composePrompt(
      sessionWith([msg("user", "user", "hello")], tempRoot),
      "hello",
      "claude",
      1,
      // A directory sitting where the db file must be — better-sqlite3 refuses to open it as a db.
      { laneClass: "chat", dbPath: tempRoot, notices },
    );
    expect(out).toContain("Operator: hello");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ cause: "memory-db-open-failed", agent: "claude" });
    expect(notices[0]?.detail.length).toBeGreaterThan(0);
  });

  it("mints a memory-project-resolve-failed notice — previously this cause had NO producer at all", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-project-notice-"));
    process.env.ZER0_MEMORY = "1";
    projectResolveFails.value = true;
    const notices: RoomNotice[] = [];
    const out = composePrompt(
      sessionWith([msg("user", "user", "hello")], tempRoot),
      "hello",
      "codex",
      1,
      { laneClass: "chat", dbPath: join(tempRoot, "evidence.db"), notices },
    );
    expect(out).toContain("Operator: hello");
    expect(notices).toEqual([
      {
        cause: "memory-project-resolve-failed",
        agent: "codex",
        detail: "SQLITE_CORRUPT: projects is malformed",
      },
    ]);
    const logged = readFileSync(memoryFailureLogPath(tempRoot), "utf8");
    expect(logged).toContain("memory-project-resolve-failed");
  });
});

describe("composePrompt — memory notice producers, boolean + regression (MN fix round 2, I-2)", () => {
  it("consumes recordMemoryFailure's boolean: an unwritable failure log also raises memory-failure-log-unwritable", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-log-unwritable-"));
    process.env.ZER0_MEMORY = "1";
    // A directory standing where the log FILE must be makes every write into it fail — same trick as
    // lane-carrier-briefing.test.ts's own "raises a SECOND notice" case.
    mkdirSync(memoryFailureLogPath(tempRoot), { recursive: true });
    const notices: RoomNotice[] = [];
    composePrompt(sessionWith([msg("user", "user", "hi")], tempRoot), "hi", "gemini", 1, {
      laneClass: "chat",
      dbPath: tempRoot,
      notices,
    });
    expect(notices.map((notice) => notice.cause)).toEqual([
      "memory-db-open-failed",
      "memory-failure-log-unwritable",
    ]);
  });

  it("absent `notices` option is a no-op collection point — output and log behavior unchanged (regression)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-notices-absent-"));
    process.env.ZER0_MEMORY = "1";
    const out = composePrompt(
      sessionWith([msg("user", "user", "hello")], tempRoot),
      "hello",
      "claude",
      1,
      { laneClass: "chat", dbPath: tempRoot },
    );
    expect(out).toContain("Operator: hello");
    expect(existsSync(memoryFailureLogPath(tempRoot))).toBe(true);
  });
});
