/**
 * @file src/chat/lane-carrier-briefing.test.ts
 * @purpose Pin the degradation primitive itself: what it returns, what it classifies, what it
 *   records, and what it raises when even the record cannot be written.
 * @exports (test suite)
 * @depends node:fs, node:os, node:path, vitest, ../shared/room-notice, ./lane-carrier, ./lane-carrier-briefing, ./memory-failure-log
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RoomNotice } from "../shared/room-notice.js";
import { type NoticePublisher, publishNotices, safely } from "./lane-carrier-briefing.js";
import type { TraceBus } from "./lane-carrier.js";
import { memoryFailureLogPath } from "./memory-failure-log.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(path.join(tmpdir(), "carrier-briefing-"));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const created of roots.splice(0)) {
    rmSync(created, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The narrow NoticeOrigin/NoticePublisher shapes are the whole point: a real carrier turn is not
// needed to exercise the degradation rule, so this suite asserts against behaviour, not a fixture.
function context(cwd: string, sink?: unknown[]): NoticePublisher {
  return {
    agent: "codex",
    turn: 7,
    binding: { cwd },
    ...(sink === undefined
      ? {}
      : { trace: { emit: (event: Parameters<TraceBus["emit"]>[0]) => sink.push(event) } }),
  };
}

it("returns the read's value and raises nothing when nothing throws", () => {
  const raised: RoomNotice[] = [];
  expect(safely(context(root()), raised, "memory-compose-failed", () => "value", "fallback")).toBe(
    "value",
  );
  expect(raised).toEqual([]);
});

it("returns the fallback and classifies by CALL SITE, not by the message text", () => {
  const raised: RoomNotice[] = [];
  const cwd = root();
  // The message says "cursor" but the call site is the compose site. The cause must follow the site.
  const value = safely(
    context(cwd),
    raised,
    "memory-compose-failed",
    () => {
      throw new Error("the lane cursor is what actually broke");
    },
    "fallback",
  );
  expect(value).toBe("fallback");
  expect(raised).toEqual([
    {
      cause: "memory-compose-failed",
      agent: "codex",
      detail: "the lane cursor is what actually broke",
    },
  ]);
});

it("writes the detail durably, so the repeats the room will not announce are still recorded", () => {
  const cwd = root();
  const raised: RoomNotice[] = [];
  for (let index = 0; index < 3; index += 1) {
    safely(
      context(cwd),
      raised,
      "memory-cursor-failed",
      () => {
        throw new Error(`cursor failure ${index}`);
      },
      undefined,
    );
  }
  const log = readFileSync(memoryFailureLogPath(cwd), "utf8");
  expect(log.split("\n").filter((line) => line.length > 0)).toHaveLength(3);
  expect(log).toContain("memory-cursor-failed cursor failure 2");
  expect(raised).toHaveLength(3);
});

it("raises a SECOND notice when the durable record itself cannot be written", () => {
  const cwd = root();
  // A directory standing where the log file must be makes every write path fail.
  mkdirSync(memoryFailureLogPath(cwd), { recursive: true });
  const raised: RoomNotice[] = [];
  safely(
    context(cwd),
    raised,
    "memory-db-open-failed",
    () => {
      throw new Error("cannot open evidence.db");
    },
    undefined,
  );
  expect(raised.map((notice) => notice.cause)).toEqual([
    "memory-db-open-failed",
    "memory-failure-log-unwritable",
  ]);
  // Both carry the SAME detail: the second notice is about the first one going unrecorded.
  expect(new Set(raised.map((notice) => notice.detail))).toEqual(
    new Set(["cannot open evidence.db"]),
  );
});

it("survives a thrown value that is not an Error at all", () => {
  const raised: RoomNotice[] = [];
  expect(() =>
    safely(
      context(root()),
      raised,
      "memory-compose-failed",
      () => {
        throw { nope: true };
      },
      undefined,
    ),
  ).not.toThrow();
  expect(raised[0]?.detail.length).toBeGreaterThan(0);
});

it("publishes each raised notice once, carrying the turn, and nothing when none were raised", () => {
  const sink: unknown[] = [];
  publishNotices(context(root(), sink), []);
  expect(sink).toEqual([]);

  publishNotices(context(root(), sink), [
    { cause: "memory-compose-failed", agent: "claude", detail: "one" },
    { cause: "memory-cursor-failed", detail: "two" },
  ]);
  expect(sink).toEqual([
    {
      kind: "room.notice",
      cause: "memory-compose-failed",
      turn: 7,
      agent: "claude",
      detail: "one",
    },
    { kind: "room.notice", cause: "memory-cursor-failed", turn: 7, detail: "two" },
  ]);
});

it("does nothing at all when the composition has no trace bus attached", () => {
  expect(() =>
    publishNotices(context(root()), [{ cause: "memory-compose-failed", detail: "unheard" }]),
  ).not.toThrow();
});
