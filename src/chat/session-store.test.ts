/**
 * @file src/chat/session-store.test.ts
 * @purpose Tests on-disk chat session persistence (transcript.json, prompt files, dispatch log).
 * @exports (none)
 * @depends vitest, node:fs, node:os, node:path, ./session-store
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "./types.js";

const TEMP_PREFIX: string = "zer0-chat-store-";

let tempRoot: string | undefined;
const recordChatSession = vi.fn(() => Promise.resolve());

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  // Neutralize the evidence-DB side-effect: persistSession() calls recordChatSession,
  // which would open a real SQLite DB at config.dbPath (.zer0/evidence.db in the repo).
  // The disk assertions below cover the real transcript/prompt/log writes; the DB path
  // is covered by src/chat/evidence integration tests, not this unit.
  vi.doMock("./evidence.js", () => ({
    recordChatSession,
    recordChatDispatch: vi.fn(() => Promise.resolve(undefined)),
    recordChatMessage: vi.fn(() => Promise.resolve()),
  }));
});

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  recordChatSession.mockClear();
  vi.resetModules();
  vi.doUnmock("./evidence.js");
});

function repoRoot(): string {
  if (tempRoot === undefined) throw new Error("tempRoot not initialized");
  return tempRoot;
}

function message(turn: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${String(turn)}`,
    turn,
    role: "user",
    agent: "user",
    text: `message ${String(turn)}`,
    createdAt: "2026-05-28T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 4,
    ...overrides,
  };
}

it("creates a session with transcript.json and the prompt/response/stderr dirs", async () => {
  const { createSession } = await import("./session-store.js");

  const session = await createSession(repoRoot());

  expect(session.id).toMatch(/^chat-/);
  expect(session.messages).toEqual([]);
  const transcript = readFileSync(join(session.runDir, "transcript.json"), "utf8");
  expect(JSON.parse(transcript)).toMatchObject({ id: session.id, defaultAgent: "claude" });
  const dirs = readdirSync(session.runDir).sort();
  expect(dirs).toEqual(["prompts", "responses", "stderr", "transcript.json"]);
  expect(recordChatSession).toHaveBeenCalledTimes(1);
});

it("round-trips a persisted session through loadSession", async () => {
  const { createSession, persistSession, appendMessage, loadSession } = await import(
    "./session-store.js"
  );
  const session = await createSession(repoRoot());

  const updated = appendMessage(session, message(1, { role: "agent", agent: "codex" }));
  await persistSession(updated);
  const loaded = await loadSession(session.id, repoRoot());

  expect(loaded.messages).toHaveLength(1);
  expect(loaded.messages[0]).toMatchObject({ id: "msg-1", agent: "codex" });
  expect(loaded.lastAgent).toBe("codex");
});

// T5 (FIX WAVE Round A, 2026-07-18 = trust#5): loadSession used to trust the PERSISTED repoRoot/runDir
// verbatim from transcript.json — a malicious/stale transcript could pivot spawned agents' cwd and
// prompt/response writes outside the repo the operator actually opened. Rebinding to the CURRENT
// call's own repoRoot/sessionId (never the file's own claim) closes that path-authority hole.
it("T5: loadSession REBINDS repoRoot/runDir to the current call, never trusting the persisted file's own claim", async () => {
  const { createSession, loadSession } = await import("./session-store.js");
  const { writeFileSync } = await import("node:fs");
  const session = await createSession(repoRoot());
  const tampered = {
    ...session,
    repoRoot: "C:/some/other/attacker-controlled/repo",
    runDir: `C:/some/other/attacker-controlled/repo/.council/runs/${session.id}`,
  };
  writeFileSync(join(session.runDir, "transcript.json"), JSON.stringify(tampered, null, 2), "utf8");

  const loaded = await loadSession(session.id, repoRoot());

  expect(loaded.repoRoot).toBe(repoRoot());
  expect(loaded.runDir).toBe(session.runDir);
});

it("T5: loadSession REJECTS a transcript whose own id does not match the requested sessionId", async () => {
  const { createSession, loadSession } = await import("./session-store.js");
  const { writeFileSync } = await import("node:fs");
  const session = await createSession(repoRoot());
  const spoofed = { ...session, id: "chat-some-other-session-id" };
  writeFileSync(join(session.runDir, "transcript.json"), JSON.stringify(spoofed, null, 2), "utf8");

  await expect(loadSession(session.id, repoRoot())).rejects.toThrow(/mismatch/);
});

it("appendMessage advances lastAgent only for real agent names", async () => {
  const { createSession, appendMessage } = await import("./session-store.js");
  const session = await createSession(repoRoot());

  const afterAgent = appendMessage(session, message(1, { role: "agent", agent: "gemini" }));
  expect(afterAgent.lastAgent).toBe("gemini");

  const afterUser = appendMessage(afterAgent, message(2, { role: "user", agent: "user" }));
  expect(afterUser.lastAgent).toBe("gemini");
  expect(afterUser.messages).toHaveLength(2);
});

it("appendMessage does not mutate the input session", async () => {
  const { createSession, appendMessage } = await import("./session-store.js");
  const session = await createSession(repoRoot());

  appendMessage(session, message(1));

  expect(session.messages).toEqual([]);
});

it("writePromptFile writes zero-padded turn content and returns its path", async () => {
  const { createSession, writePromptFile } = await import("./session-store.js");
  const session = await createSession(repoRoot());

  const filePath = await writePromptFile(session, 7, "claude", "prompt body");

  expect(filePath).toBe(join(session.runDir, "prompts", "turn-0007-claude.md"));
  expect(readFileSync(filePath, "utf8")).toBe("prompt body");
});

it("writePromptFile includes round when provided", async () => {
  const { createSession, writePromptFile } = await import("./session-store.js");
  const session = await createSession(repoRoot());

  const first = await writePromptFile(session, 7, "claude", "round one", 1);
  const second = await writePromptFile(session, 7, "claude", "round two", 2);

  expect(first).toBe(join(session.runDir, "prompts", "turn-0007-r1-claude.md"));
  expect(second).toBe(join(session.runDir, "prompts", "turn-0007-r2-claude.md"));
  expect(readFileSync(first, "utf8")).toBe("round one");
  expect(readFileSync(second, "utf8")).toBe("round two");
});

it("appendDispatchLog appends one JSONL line per call", async () => {
  const { createSession, appendDispatchLog } = await import("./session-store.js");
  const session = await createSession(repoRoot());
  const entry = {
    agent: "codex" as const,
    turn: 1,
    durationMs: 100,
    exitCode: 0,
    tokenEstimate: 12,
    timestamp: "2026-05-28T00:00:00.000Z",
  };

  await appendDispatchLog(session, entry);
  await appendDispatchLog(session, { ...entry, turn: 2 });

  const logPath = join(session.runDir, "dispatch-log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ turn: 1, agent: "codex" });
  expect(JSON.parse(lines[1] ?? "")).toMatchObject({ turn: 2 });
});

it("listSessions returns chat dirs newest-first and ignores non-chat dirs", async () => {
  const { createSession, listSessions } = await import("./session-store.js");
  const { mkdirSync } = await import("node:fs");
  const first = await createSession(repoRoot());
  // Distinct id requires a subsequent millisecond stamp; createSession derives id from Date.now().
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await createSession(repoRoot());
  mkdirSync(join(repoRoot(), ".council", "runs", "not-a-chat-dir"), { recursive: true });

  const sessions = await listSessions(repoRoot());

  expect(sessions).toContain(first.id);
  expect(sessions).toContain(second.id);
  expect(sessions).not.toContain("not-a-chat-dir");
  expect(sessions.indexOf(second.id)).toBeLessThan(sessions.indexOf(first.id));
});

it("listSessions returns an empty list when the runs dir is absent", async () => {
  const { listSessions } = await import("./session-store.js");

  const sessions = await listSessions(join(repoRoot(), "does-not-exist"));

  expect(sessions).toEqual([]);
});
