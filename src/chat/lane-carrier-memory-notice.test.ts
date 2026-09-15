/**
 * @file src/chat/lane-carrier-memory-notice.test.ts
 * @purpose Prove every briefing-path failure DEGRADES the carrier turn and is CLASSIFIED, never
 *   crashes the turn and never passes in silence.
 * @exports (test suite)
 * @depends vitest, ./lane-carrier, ./lane-carrier.fixtures
 */
import { expect, it, vi } from "vitest";
import type { RoomNoticeCause } from "../shared/room-notice.js";
import {
  BINDING,
  NOW,
  PROJECT,
  readBody,
  registerLaneCarrierHooks,
  root,
  seeded,
} from "./lane-carrier.fixtures.js";

const cursorFails = { value: false };
const requestFilesFails = { value: false };
const ledgerFails = { value: false };

vi.mock("../memory/lane-cursor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/lane-cursor.js")>();
  return {
    ...actual,
    getLaneCursor: (...args: Parameters<typeof actual.getLaneCursor>) => {
      if (cursorFails.value) throw new Error("SQLITE_CORRUPT: lane_cursors is malformed");
      return actual.getLaneCursor(...args);
    },
  };
});

vi.mock("../memory/request-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/request-files.js")>();
  return {
    ...actual,
    extractRequestFiles: (...args: Parameters<typeof actual.extractRequestFiles>) => {
      if (requestFilesFails.value) throw new Error("request file extraction exploded");
      return actual.extractRequestFiles(...args);
    },
  };
});

// MN fix round 2 (I-1): the delta step (ledgerAfter, reading journal/ledger tables) is the UNWRAPPED
// step of composeCarrierPrompt — nothing catches it. Mocked so a test can throw from it AFTER an
// earlier step already classified a notice, reproducing the corrupt-database shape the review found:
// two doors of the same composition break, one wrapped and one not.
vi.mock("../memory/ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/ledger.js")>();
  return {
    ...actual,
    ledgerAfter: (...args: Parameters<typeof actual.ledgerAfter>) => {
      if (ledgerFails.value) throw new Error("SQLITE_CORRUPT: journal_entries is malformed");
      return actual.ledgerAfter(...args);
    },
  };
});

const { composeCarrierPrompt } = await import("./lane-carrier.js");

registerLaneCarrierHooks();

function fixtureRoot(): string {
  if (root === undefined) throw new Error("seeded() must run before the fixture root is read");
  return root;
}

function raised(): { emit: (event: { kind: string }) => void; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  return { emit: (event) => seen.push(event as Record<string, unknown>), seen };
}

function compose(bus: ReturnType<typeof raised>) {
  const { db, bodies } = seeded();
  // The failure log is written under `binding.cwd`; point it at this test's own temp root so a
  // classified failure can never append into the repository being tested.
  const cwd = fixtureRoot();
  return composeCarrierPrompt({
    agent: "claude",
    turn: 3,
    binding: { ...BINDING, cwd },
    db,
    projectId: PROJECT,
    readBody: readBody(bodies),
    setup: "SETUP",
    operatorMessage: "look at src/room/room-engine.ts please",
    now: () => NOW,
    trace: bus,
  });
}

function causes(bus: ReturnType<typeof raised>): RoomNoticeCause[] {
  return bus.seen
    .filter((event) => event.kind === "room.notice")
    .map((event) => event.cause as RoomNoticeCause);
}

it("degrades instead of crashing when the lane cursor cannot be read", () => {
  cursorFails.value = true;
  const bus = raised();
  try {
    const prompt = compose(bus);
    expect(prompt.text).toContain("SETUP");
    expect(prompt.text).toContain("look at src/room/room-engine.ts please");
    expect(causes(bus)).toContain("memory-cursor-failed");
    expect(prompt.notices.map((notice) => notice.cause)).toContain("memory-cursor-failed");
  } finally {
    cursorFails.value = false;
  }
});

it("degrades instead of crashing when request-file extraction throws", () => {
  requestFilesFails.value = true;
  const bus = raised();
  try {
    const prompt = compose(bus);
    expect(prompt.text).toContain("look at src/room/room-engine.ts please");
    expect(causes(bus)).toContain("memory-request-files-failed");
  } finally {
    requestFilesFails.value = false;
  }
});

it("carries the classified failure on the prompt, agent and all, without a throw", () => {
  cursorFails.value = true;
  const bus = raised();
  try {
    const prompt = compose(bus);
    const notice = prompt.notices.find((entry) => entry.cause === "memory-cursor-failed");
    expect(notice?.agent).toBe("claude");
    expect(notice?.detail).toBe("SQLITE_CORRUPT: lane_cursors is malformed");
    const emitted = bus.seen.find((event) => event.kind === "room.notice");
    expect(emitted).toMatchObject({ turn: 3, agent: "claude", cause: "memory-cursor-failed" });
  } finally {
    cursorFails.value = false;
  }
});

it("raises nothing at all on the ordinary path", () => {
  const bus = raised();
  const prompt = compose(bus);
  expect(prompt.notices).toEqual([]);
  expect(causes(bus)).toEqual([]);
});

// MN fix round 2, I-1: a classified failure earlier in this SAME composition (the lane cursor) must
// survive a LATER, unrelated step of the same composition throwing (the delta read) — the exact shape
// of one corrupt evidence database failing both `lane_cursors` and `journal_entries` reads. Before the
// fix, publishNotices ran once at the end of composeCarrierPrompt, AFTER the delta step — a throw there
// skipped it entirely and the room never learned the cursor had already failed.
it("a notice classified before a LATER throw in the same composition survives on the trace bus", () => {
  cursorFails.value = true;
  ledgerFails.value = true;
  const bus = raised();
  try {
    expect(() => compose(bus)).toThrow("journal_entries is malformed");
    expect(causes(bus)).toContain("memory-cursor-failed");
  } finally {
    cursorFails.value = false;
    ledgerFails.value = false;
  }
});
