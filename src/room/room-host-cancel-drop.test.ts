/**
 * @file src/room/room-host-cancel-drop.test.ts
 * @purpose FL-146 — whether a cancel actually stopped an ACP lane is a fact the room host used to
 *   discard. THE OPERATOR-VISIBLE FAILURE THIS CATCHES: they press Esc, the lane reports `cancelling`,
 *   the drop releases NOTHING because the bridge was still opening — and the room says nothing, so the
 *   agent answering seconds later looks like a mystery instead of a reported no-op.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ../adapters/acp/acp-lane-session, ../chat/lane-transport,
 *   ../evidence/db, ./room-host-support
 *
 * Lives beside room-host-support.test.ts rather than inside it, deliberately: that file's journal test
 * contains an unbalanced `{` inside a template literal, and gate-clamps counts raw braces, so anything
 * appended after it is counted as part of that test's body. See the report for the gate finding.
 *
 * The REAL carrier registry and the REAL transport — `openConnection` is the one injected seam, since
 * `dropLaneHold`'s answer is only meaningful if the hold it consults is a real one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import {
  getOrCreateLaneTransport,
  initCarrierRuntime,
  resetCarrierRuntime,
} from "../chat/lane-transport.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { dropCancelledLaneHold } from "./room-host-support.js";

const roots: string[] = [];

afterEach(() => {
  resetCarrierRuntime();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function liveConnection(): LaneConnection {
  let alive = true;
  return {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "s-1" }),
    resumeSession: async () => ({}),
    prompt: async () => "end_turn",
    setMode: async () => undefined,
    close: () => {
      alive = false;
    },
    waitForExit: async () => !alive,
    killTree: async () => {
      alive = false;
    },
    isAlive: () => alive,
    pid: () => 4242,
  };
}

/** A carrier runtime whose lanes open the fake connection above — the real registry, real transports. */
function carrierRuntimeWithLanes(): void {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-cancel-drop-"));
  roots.push(root);
  const dbPath = path.join(root, "evidence.db");
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", "C:/repo", "C:/repo/.git", "2026-07-10T00:00:00Z");
  closeDb(db);
  initCarrierRuntime({
    projectId: "p1",
    dbPath,
    repoRoot: root,
    cwd: "C:/repo",
    openConnection: async () => liveConnection(),
  });
}

it("reports a cancel that found no live ACP connection to stop", async () => {
  const reported: string[] = [];

  await dropCancelledLaneHold({
    agent: "claude",
    isShuttingDown: () => false,
    report: (message) => reported.push(message),
  });

  expect(reported, "a cancel that released nothing must not pass for one that worked").toEqual([
    "cancel reached claude with no live bridge connection to stop",
  ]);
});

it("stays quiet when the cancel really did release a held connection", async () => {
  carrierRuntimeWithLanes();
  await getOrCreateLaneTransport("claude").start(undefined);
  const reported: string[] = [];

  await dropCancelledLaneHold({
    agent: "claude",
    isShuttingDown: () => false,
    report: (message) => reported.push(message),
  });

  expect(reported).toEqual([]);
});

it("stays quiet during shutdown, where every lane is being dropped anyway", async () => {
  const reported: string[] = [];

  await dropCancelledLaneHold({
    agent: "claude",
    isShuttingDown: () => true,
    report: (message) => reported.push(message),
  });

  expect(reported).toEqual([]);
});

it("has nothing to drop or report for gemini, which holds no cross-turn connection", async () => {
  const reported: string[] = [];

  await dropCancelledLaneHold({
    agent: "gemini",
    isShuttingDown: () => false,
    report: (message) => reported.push(message),
  });

  expect(reported).toEqual([]);
});
