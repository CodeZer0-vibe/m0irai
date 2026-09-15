/**
 * @file src/chat/headless-prompt.test.ts
 * @purpose Falsifying contract for composePrompt: it always injects the team setup (so the agent knows it is
 *          one of three named teammates) + the prior shared transcript (teammates' replies = shared memory)
 *          + the agent's OWN task last (the @routing prefix stripped). A name-based chain segment's task is
 *          its own ("audit the plan"), not the whole operator line.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./headless-prompt, ./types
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { composePrompt } from "./headless-prompt.js";
import type { ChatMessage, ChatSession } from "./types.js";

const savedMemory = process.env.ZER0_MEMORY;
const savedDbPath = process.env.ZER0_DB_PATH;
let tempRoot: string | undefined;

beforeEach(() => {
  process.env.ZER0_MEMORY = "off";
  Reflect.deleteProperty(process.env, "ZER0_DB_PATH");
});

afterEach(() => {
  restoreEnv();
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    tempRoot = undefined;
  }
});

function restoreEnv(): void {
  if (savedMemory === undefined) Reflect.deleteProperty(process.env, "ZER0_MEMORY");
  else process.env.ZER0_MEMORY = savedMemory;
  if (savedDbPath === undefined) Reflect.deleteProperty(process.env, "ZER0_DB_PATH");
  else process.env.ZER0_DB_PATH = savedDbPath;
}

function msg(role: "user" | "agent", agent: ChatMessage["agent"], text: string): ChatMessage {
  return msgT(1, role, agent, text);
}

// Turn-parametrized variant: lets a test place a reply on turn N while it sits OUT OF ARRIVAL ORDER in the
// messages array (a slow reply that persisted late) — to prove the consumer reads ask order, not arrival.
function msgT(
  turn: number,
  role: "user" | "agent",
  agent: ChatMessage["agent"],
  text: string,
): ChatMessage {
  return {
    id: `m-${text}`,
    turn,
    role,
    agent,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
  };
}

function sessionWith(messages: ChatMessage[], repoRoot = "/r"): ChatSession {
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

describe("composePrompt — team setup + shared transcript + own task", () => {
  it("turn 1 sends the team setup + the operator's task (the agent knows it is in a 3-agent team)", () => {
    const out = composePrompt(
      sessionWith([msg("user", "user", "@all hello")]),
      "hello",
      "claude",
      1,
      "chat",
    );
    expect(out).toContain("you are claude"); // the team setup names this agent
    expect(out).toContain("codex and gemini"); // …and its two teammates (cross-agent awareness)
    expect(out).toContain("Operator: hello"); // the task, routing prefix stripped
  });
});

describe("composePrompt — visible teammate handoff contract", () => {
  it("falsifier: the setup permits one visible read-only teammate handoff, not hidden coordination", () => {
    const out = composePrompt(
      sessionWith([msg("user", "user", "@claude investigate")]),
      "investigate",
      "claude",
      1,
      "chat",
    );
    expect(out).toContain("@codex: <question>");
    expect(out).toContain("one read-only teammate handoff");
    expect(out).toContain("do not start a private or multi-round discussion");
  });
});

describe("composePrompt — shared transcript + own task", () => {
  it("includes a teammate's prior reply (shared memory) and the agent's OWN task last", () => {
    const out = composePrompt(
      sessionWith([
        msg("user", "user", "claude plan it, codex audit it"),
        msg("agent", "claude", "Plan: do X then Y."),
      ]),
      "audit the plan",
      "codex",
      1,
      "chat",
    );
    expect(out).toContain("you are codex"); // setup names the dispatched agent
    expect(out).toContain("Plan: do X then Y."); // claude's reply is shared memory codex builds on
    expect(out).toContain("Operator: audit the plan"); // codex's OWN task, not the whole operator line
    expect(out).not.toContain("plan it, codex audit it"); // current operator line NOT duplicated (P1 fix)
  });

  it("strips the @routing prefix and does not duplicate this turn's operator line", () => {
    const out = composePrompt(
      sessionWith([msg("user", "user", "@codex build the parser")]),
      "build the parser",
      "codex",
      1,
      "chat",
    );
    expect(out).toContain("Operator: build the parser");
    expect(out).not.toContain("@codex build the parser"); // the directive never reaches the agent as content
  });
});

describe("composePrompt — multi-@ tag stripping (an addressed agent must not see itself excluded)", () => {
  it("strips the WHOLE leading @-tag run so a multi-@ message gives each agent just the task", () => {
    // Regression: with single-tag stripping, claude saw "@codex @gemini hi" and bowed out ("that's for them").
    const out = composePrompt(
      sessionWith([msg("user", "user", "@claude @codex @gemini hi")]),
      "@claude @codex @gemini hi",
      "claude",
      1,
      "chat",
    );
    expect(out).toContain("Operator: hi");
    const task = out.slice(out.lastIndexOf("Operator:"));
    expect(task).not.toContain("@codex"); // no teammate tag leaks into claude's task
    expect(task).not.toContain("@gemini");
  });
});

describe("composePrompt — history attribution (live bug #a825: gemini answered teammates' questions)", () => {
  it("REPRO #a825: a history line addressed to codex carries '(to codex)' — the agent can tell it was never its question", () => {
    // Live failure: turns 10-12 were '@claude/@codex what model…'; the strip rendered them as bare
    // 'Operator:' lines, so gemini read them as team-wide unanswered questions and answered them in
    // its turn-13 reply ("I wanted to make sure I answered for my part").
    const out = composePrompt(
      sessionWith([
        msgT(1, "user", "user", "@codex what model do you use and what effort ?"),
        msgT(1, "agent", "codex", "gpt-5.5-codex, effort high."),
        msgT(2, "user", "user", "@gemini I cant click the links you responded with"),
      ]),
      "I cant click the links you responded with",
      "gemini",
      2,
      "chat",
    );
    expect(out).toContain("Operator (to codex): what model do you use and what effort ?");
    // The CURRENT task line stays bare — the bow-out fix is untouched.
    expect(out).toContain("Operator: I cant click the links you responded with");
  });

  it("an @all history line is marked '(to all)'", () => {
    const out = composePrompt(
      sessionWith([
        msgT(1, "user", "user", "@all research jobs for me"),
        msgT(1, "agent", "gemini", "Here are roles…"),
        msgT(2, "user", "user", "@gemini thanks"),
      ]),
      "thanks",
      "gemini",
      2,
      "chat",
    );
    expect(out).toContain("Operator (to all): research jobs for me");
  });
});

describe("composePrompt — history attribution edge shapes (#a825)", () => {
  it("a multi-address history line names every addressed teammate", () => {
    const out = composePrompt(
      sessionWith([
        msgT(1, "user", "user", "@claude @codex compare your approaches"),
        msgT(1, "agent", "claude", "Mine is X."),
        msgT(2, "user", "user", "@gemini summarize"),
      ]),
      "summarize",
      "gemini",
      2,
      "chat",
    );
    expect(out).toContain("Operator (to claude and codex): compare your approaches");
  });

  it("an un-addressed history line stays a bare 'Operator:' line", () => {
    const out = composePrompt(
      sessionWith([
        msgT(1, "user", "user", "hello team"),
        msgT(1, "agent", "claude", "hi"),
        msgT(2, "user", "user", "@claude continue"),
      ]),
      "continue",
      "claude",
      2,
      "chat",
    );
    expect(out).toContain("Operator: hello team");
    // Nothing fabricates an address that was never typed (the setup's own "(to X)" rule text is fine).
    expect(out).not.toMatch(/Operator \(to [^)]+\): hello team/);
  });

  it("the team setup carries the never-re-answer rule for '(to X)' lines", () => {
    const out = composePrompt(
      sessionWith([msg("user", "user", "@claude hi")]),
      "hi",
      "claude",
      1,
      "chat",
    );
    expect(out).toContain("never answer a teammate's question");
  });
});

describe("composePrompt — ask-order transcript (arrival-order-safe, U1-T3c BLOCK-2)", () => {
  it("renders a turn-1 reply BEFORE turn-2's content even when it persisted AFTER turn-2 in storage", () => {
    // Per-agent independence means replies persist in COMPLETION order: a slow turn-1 gemini reply can land
    // AFTER turn-2's user+claude rows. The composed shared transcript must present it in ASK order (turn 1
    // before turn 2), not as if it were the newest message.
    const out = composePrompt(
      sessionWith([
        msgT(2, "user", "user", "turn two prompt"),
        msgT(2, "agent", "claude", "TURN-TWO-CLAUDE"),
        msgT(1, "agent", "gemini", "TURN-ONE-GEMINI"), // arrived late, but belongs to turn 1
      ]),
      "turn three task",
      "codex",
      3,
      "chat",
    );
    expect(out).toContain("TURN-ONE-GEMINI");
    expect(out).toContain("TURN-TWO-CLAUDE");
    expect(out.indexOf("TURN-ONE-GEMINI")).toBeLessThan(out.indexOf("TURN-TWO-CLAUDE"));
  });
});

// T7: the redirect payload injection. Positioned after briefing/before task, and it BYPASSES
// MAX_PROMPT_CHARS — the history portion (setup+dialogue+briefing) is truncated on its own budget;
// the redirect block + task are appended afterward, untouched by that truncation. composePrompt's 5th
// param accepts a bare LaneClass OR {laneClass, redirect} (see headless-prompt.ts's file header for why
// — a bare 6th param would exceed the 5-param gate and rewriting the many external call sites is out of
// scope here).
describe("composePrompt — redirect payload injection (T7), regression + positioning", () => {
  it("with no redirect option, output is byte-identical to the bare-LaneClass call (regression)", () => {
    const session = sessionWith([msg("user", "user", "@all hello")]);
    const withOptions = composePrompt(session, "hello", "claude", 1, { laneClass: "chat" });
    const withBareLaneClass = composePrompt(session, "hello", "claude", 1, "chat");
    expect(withOptions).toBe(withBareLaneClass);
  });

  it("places the redirect block after the transcript and before the task", () => {
    const out = composePrompt(
      sessionWith([
        msg("user", "user", "claude do the thing"),
        msg("agent", "claude", "done, see PR"),
      ]),
      "continue",
      "claude",
      2,
      { laneClass: "dispatch", redirect: "[Redirect from operator]: please also add a test" },
    );
    const redirectIdx = out.indexOf("please also add a test");
    const taskIdx = out.indexOf("Operator: continue");
    const transcriptIdx = out.indexOf("done, see PR");
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(transcriptIdx).toBeGreaterThan(-1);
    expect(transcriptIdx).toBeLessThan(redirectIdx);
    expect(redirectIdx).toBeLessThan(taskIdx);
  });
});

describe("composePrompt — redirect payload injection (T7), truncation bypass + empty edge", () => {
  it("FALSIFIER: the redirect survives byte-intact even when the recent-window content alone exceeds MAX_PROMPT_CHARS", () => {
    const giant = "x".repeat(30_000);
    const redirectBlock = "[Redirect from operator]: UNIQUE-REDIRECT-MARKER-789 do not drop me";
    const out = composePrompt(
      sessionWith([msg("user", "user", "start"), msg("agent", "claude", giant)]),
      "continue",
      "claude",
      2,
      { laneClass: "dispatch", redirect: redirectBlock },
    );
    // The giant transcript content DID get truncated (proves this scenario actually exercises the
    // truncation path — a non-truncating test would prove nothing about "bypass").
    expect(out.length).toBeLessThan(giant.length);
    expect(out).toContain("…\n");
    // The redirect itself is present, whole, and unelided.
    expect(out).toContain(redirectBlock);
    expect(out).toContain("Operator: continue");
  });

  it("an empty-string redirect is treated as absent (no stray blank block)", () => {
    const withEmpty = composePrompt(sessionWith([msg("user", "user", "hi")]), "hi", "claude", 1, {
      laneClass: "chat",
      redirect: "",
    });
    const withoutRedirect = composePrompt(
      sessionWith([msg("user", "user", "hi")]),
      "hi",
      "claude",
      1,
      {
        laneClass: "chat",
      },
    );
    expect(withEmpty).toBe(withoutRedirect);
  });
});

describe("composePrompt - memory fail-soft recorder", () => {
  it("keeps composing without memory and records classified DB-open failures", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-fail-"));
    process.env.ZER0_MEMORY = "1";
    process.env.ZER0_DB_PATH = tempRoot;
    const out = composePrompt(
      sessionWith([msg("user", "user", "hello")], tempRoot),
      "hello",
      "codex",
      1,
      "chat",
    );
    const logPath = join(tempRoot, ".zer0", "journal", "memory-failures.log");
    expect(out).toContain("Operator: hello");
    expect(out).not.toContain("# Static memory briefing");
    expect(existsSync(logPath)).toBe(true);
    // Lane MN: the log's classification is now the ROOM NOTICE cause, so one vocabulary names the
    // failure on disk and on screen. Same assertion, current spelling.
    expect(readFileSync(logPath, "utf8")).toMatch(
      /^\d{4}-\d{2}-\d{2}T.* memory-db-open-failed .+$/m,
    );
  });
});

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

// Finding (operator live-test, 2026-07-12): openSessionMemoryDb(repoRoot) ignored its repoRoot
// parameter and opened loadConfig().dbPath (process.cwd()-relative) instead — under ZER0_MEMORY=1,
// ANY build-mode headless turn wrote memory state into whatever db a bare `loadConfig()` resolved
// to from the CALLING PROCESS's cwd, never the session's own project. Proven live: a Wave 11 E2E
// run left a 4.5MB mtime-matched write in this repo's OWN .zer0/evidence.db. The fix threads the
// caller's already-resolved config.dbPath through composePrompt's options (see the ComposePromptOptions
// dbPath doc). These two tests exercise the fix directly rather than against this repo's own live
// runtime db (which other concurrently-forked test files could also touch under ZER0_MEMORY=1,
// making a live-repo-db assertion racy) — a decoy process.cwd() that NO OTHER test can reach
// (mkdtemp-unique) stands in for "wherever loadConfig()'s cwd-relative default would have pointed,"
// which is the exact shape of the leak: the WRONG path is a cwd-relative default, not a fixed file.
describe("composePrompt — memory-briefing dbPath threading (2026-07-12 leak fix)", () => {
  it("opens the session's OWN dbPath, never the process-cwd-relative default — both directions: the wrong path is never created, the right path receives the real migration writes", () => {
    const originalCwd = process.cwd();
    const decoyCwd = mkdtempSync(join(tmpdir(), "zer0-memory-decoy-cwd-"));
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-correct-db-"));
    const correctDbPath = join(tempRoot, "evidence.db");
    // Where a bare loadConfig() (DEFAULT_DB_PATH = ".zer0/evidence.db", relative) resolves once cwd
    // is the decoy dir — config.ts:17,116 confirm no cache and no absolute resolution before use.
    const decoyDbPath = join(decoyCwd, ".zer0", "evidence.db");
    process.env.ZER0_MEMORY = "1";
    // ZER0_DB_PATH deliberately left unset (beforeEach already clears it) — this test proves the
    // explicit dbPath OPTION closes the leak, not the pre-existing env-var escape hatch.
    try {
      process.chdir(decoyCwd);
      composePrompt(sessionWith([msg("user", "user", "hello")], tempRoot), "hello", "codex", 1, {
        laneClass: "chat",
        dbPath: correctDbPath,
      });
    } finally {
      process.chdir(originalCwd);
    }
    expect(existsSync(decoyDbPath)).toBe(false);
    expect(existsSync(correctDbPath)).toBe(true);
    const db = openMemoryDb(correctDbPath);
    try {
      expect(tableExists(db, "chat_sessions")).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("regression: memory-off output is byte-identical whether or not dbPath is supplied, and the db is never opened", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-memory-off-regression-"));
    const session = sessionWith([msg("user", "user", "hello")], tempRoot);
    const unusedDbPath = join(tempRoot, "unused-evidence.db");
    const withoutDbPath = composePrompt(session, "hello", "codex", 1, "chat");
    const withDbPath = composePrompt(session, "hello", "codex", 1, {
      laneClass: "chat",
      dbPath: unusedDbPath,
    });
    expect(withDbPath).toBe(withoutDbPath);
    expect(existsSync(unusedDbPath)).toBe(false);
  });
});
