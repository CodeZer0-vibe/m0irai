/**
 * @file src/adapters/agy-transcript.test.ts
 * @purpose Falsifiers for readAgyCleanReply: extracts the LAST MODEL PLANNER_RESPONSE (drops the "I will …"
 *   narration + tool steps + mid-turn status), matches the turn by USER_INPUT signature + spawn-time floor,
 *   picks newest on a basename collision, and returns undefined for no-match / future-floor / absent dir /
 *   answerless transcripts. Uses real OS-temp brain dirs (brainDir is injectable) — no fs mocking.
 * @exports (test suite — no runtime exports)
 * @depends vitest, node:fs, node:os, node:path, ./agy-transcript
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readAgyCleanReply, readAgyConversationId } from "./agy-transcript.js";

type Step = Record<string, unknown>;
const brains: string[] = [];

afterEach(() => {
  for (const b of brains.splice(0)) {
    rmSync(b, { recursive: true, force: true });
  }
});

function makeBrain(): string {
  const b = mkdtempSync(join(tmpdir(), "agy-brain-test-"));
  brains.push(b);
  return b;
}

function writeTranscript(brain: string, id: string, steps: Step[]): string {
  const dir = join(brain, id, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "transcript.jsonl");
  writeFileSync(file, steps.map((s) => JSON.stringify(s)).join("\n"));
  return file;
}

const NARRATED_TURN: Step[] = [
  {
    type: "USER_INPUT",
    source: "USER_EXPLICIT",
    content:
      "<USER_REQUEST>\nRead the file turn-0002-gemini.md in your workspace...\n</USER_REQUEST>",
  },
  {
    type: "PLANNER_RESPONSE",
    source: "MODEL",
    content: "I will list the workspace to find turn-0002-gemini.md.",
    tool_calls: [{ name: "list_dir" }],
  },
  { type: "LIST_DIRECTORY", source: "MODEL", content: "entries..." },
  {
    type: "PLANNER_RESPONSE",
    source: "MODEL",
    content: "I will search the web for current data.",
    tool_calls: [{ name: "search_web" }],
  },
  { type: "SEARCH_WEB", source: "MODEL", content: "results..." },
  { type: "PLANNER_RESPONSE", source: "MODEL", content: "The answer is 42." },
];

it("returns the LAST model PLANNER_RESPONSE, dropping I-will narration + tool steps", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-1", NARRATED_TURN);
  expect(readAgyCleanReply("turn-0002-gemini.md", 0, brain)).toBe("The answer is 42.");
});

it("returns undefined when no USER_INPUT matches the signature", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-1", NARRATED_TURN);
  expect(readAgyCleanReply("turn-9999-gemini.md", 0, brain)).toBeUndefined();
});

it("ignores transcripts older than the spawn-time floor", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-1", NARRATED_TURN);
  // sinceMs far in the future → floor is in the future → the just-written transcript is excluded.
  expect(readAgyCleanReply("turn-0002-gemini.md", Date.now() + 3_600_000, brain)).toBeUndefined();
});

it("returns undefined when the brain dir does not exist", () => {
  expect(readAgyCleanReply("sig", 0, join(tmpdir(), "agy-brain-absent-xyz-zzz"))).toBeUndefined();
});

it("returns undefined when the matched transcript has no model answer", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-1", [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Read the file sig-only.md" },
    { type: "LIST_DIRECTORY", source: "MODEL", content: "entries" },
  ]);
  expect(readAgyCleanReply("sig-only.md", 0, brain)).toBeUndefined();
});

it("picks the NEWEST transcript when the signature basename collides across sessions", () => {
  const brain = makeBrain();
  const oldFile = writeTranscript(brain, "conv-old", [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Read the file turn-0002-gemini.md" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "OLD answer" },
  ]);
  writeTranscript(brain, "conv-new", [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Read the file turn-0002-gemini.md" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "NEW answer" },
  ]);
  const old = Date.now() / 1000 - 600; // make conv-old 10 min older so newest-wins is deterministic
  utimesSync(oldFile, old, old);
  expect(readAgyCleanReply("turn-0002-gemini.md", 0, brain)).toBe("NEW answer");
});

it("matches a build-mode raw Windows path against the JSON-escaped transcript path", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-b", [
    {
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "Read the file C:\\Users\\x\\brief.md in your workspace",
    },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "BUILD DONE" },
  ]);
  expect(readAgyCleanReply("C:\\Users\\x\\brief.md", 0, brain)).toBe("BUILD DONE");
});

it("readAgyConversationId returns the brain/<id> dir of the turn matching the signature", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-uuid-7", NARRATED_TURN);
  // The dir id IS agy's conversation id — reused as --conversation <id> to resume THIS session's turn.
  expect(readAgyConversationId("turn-0002-gemini.md", 0, brain)).toBe("conv-uuid-7");
});

it("readAgyConversationId picks the NEWEST conversation on a signature collision", () => {
  const brain = makeBrain();
  const oldFile = writeTranscript(brain, "conv-old", [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Read the file dup.md" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "old" },
  ]);
  writeTranscript(brain, "conv-new", [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Read the file dup.md" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "new" },
  ]);
  const old = Date.now() / 1000 - 600; // make conv-old 10 min older so newest-wins is deterministic
  utimesSync(oldFile, old, old);
  expect(readAgyConversationId("dup.md", 0, brain)).toBe("conv-new");
});

it("readAgyConversationId returns undefined when nothing matches the signature", () => {
  const brain = makeBrain();
  writeTranscript(brain, "conv-1", NARRATED_TURN);
  expect(readAgyConversationId("no-such-sig.md", 0, brain)).toBeUndefined();
});
