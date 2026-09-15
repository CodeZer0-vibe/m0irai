/**
 * @file src/chat/lane-transport-resume-mode-adoption.test.ts
 * @purpose The RESUME mode-restore precedence. W4-R2f RA-2 REVERSED what wins: the OPERATOR's
 *   persisted choice is pushed live and, once the bridge accepts it, displayed; the session's own
 *   currentModeId is adopted only when there is no operator choice to honour or theirs was refused.
 *   W4-R FIX-1 B3-widened's invariant — never display a mode the session has not agreed to — is
 *   unchanged and is exactly why the new path PUSHES rather than merely claims. Split out of
 *   lane-transport.test.ts (already at 482/500 lines) rather than push it over the soft ceiling.
 *   The operator's own 2026-07-31 trace scenario lives in the sibling
 *   lane-transport-resume-mode-operator.test.ts.
 * @exports (none — test file)
 * @depends vitest, ../adapters/acp/acp-lane-session, ./lane-transport, ./native-mode-store, ./native-mode
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import { createCockpitLaneTransport } from "./lane-transport.js";
import { bootNativeModeState, persistNativeMode } from "./native-mode-store.js";
import { initialNativeModeState } from "./native-mode.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "lane-resume-adopt-"));
  tempRoots.push(root);
  return root;
}

// A minimal fake connection whose resumeSession answers with a CALLER-CHOSEN currentModeId — the
// ground-truth signal this whole suite is about. setMode calls are recorded so tests can assert the
// adoption path never pushes anything back to the bridge.
function fakeResumeConnection(currentModeId: string | undefined): {
  readonly conn: LaneConnection;
  readonly modeSets: { sessionId: string; modeId: string }[];
} {
  const modeSets: { sessionId: string; modeId: string }[] = [];
  const conn: LaneConnection = {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "unused" }),
    resumeSession: async () => (currentModeId !== undefined ? { currentModeId } : {}),
    prompt: async () => "end_turn",
    setMode: async (sessionId, modeId) => {
      modeSets.push({ sessionId, modeId });
    },
    close: () => undefined,
    waitForExit: async () => true,
    killTree: async () => undefined,
    isAlive: () => true,
    pid: () => 4242,
  };
  return { conn, modeSets };
}

// Shared setup: persists `persistedModeId`, resumes claude with a fake connection whose
// resumeSession answers `currentModeId`, and returns the outcome + recorded live setMode calls — the
// SAME 3-step shape every test below needs, hoisted so the describe block stays under the
// function-length clamp (gate-clamps.mjs, 50 lines).
async function resumeWithGroundTruth(
  root: string,
  persistedModeId: string,
  currentModeId: string | undefined,
) {
  persistNativeMode(root, {
    ...initialNativeModeState(),
    claude: { modeId: persistedModeId, status: "active" },
  });
  const { conn, modeSets } = fakeResumeConnection(currentModeId);
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: root,
    openConnection: async () => conn,
  });
  const result = await transport.start("s-1");
  return { result, modeSets };
}

describe("lane-transport: W4-R2f RA-2 — resume restores the OPERATOR's persisted mode", () => {
  // SUPERSEDED GOLDEN, rewritten from its OWN failing frame. It used to assert
  // `modeId: "plan", origin: "adopted"` (the session's value winning); the frame this fix produces is
  // `modeId: "bypassPermissions", origin: "confirmed"`. SAME STATE, DIFFERENT OWNER: the lane still
  // ends on a mode the session has genuinely agreed to — that is B3-widened's invariant and it is
  // untouched — but the value pushed is now the one the operator chose, not the one the bridge
  // happened to be holding. The operator's ruling (2026-07-31) is that their setting must survive a
  // restart; under the old order it could not, because the restore both ignored and then overwrote it.
  it("a MISMATCHED currentModeId ('plan') LOSES to the operator's persisted choice ('bypassPermissions')", async () => {
    const root = freshRoot();
    const { result, modeSets } = await resumeWithGroundTruth(root, "bypassPermissions", "plan");

    expect(result).toEqual({
      outcome: "resumed",
      sessionId: "s-1",
      // origin:"confirmed" — a REAL live setMode the bridge accepted, which is what use-cockpit-bus's
      // dispatch site keys on to route this through mode-active (never a display-only claim).
      modeApplied: { outcome: "applied", modeId: "bypassPermissions", origin: "confirmed" },
    });
    // The push is real and reached the session — the whole reason this is not a lie.
    expect(modeSets).toEqual([{ sessionId: "s-1", modeId: "bypassPermissions" }]);
    // Their file is left exactly as they wrote it; the restore is a reader of it, never a writer.
    expect(bootNativeModeState(root).state.claude.modeId).toBe("bypassPermissions");
  });

  it("a MATCHING currentModeId is a no-op — no redundant persist write, no live setMode call", async () => {
    const root = freshRoot();
    const { result, modeSets } = await resumeWithGroundTruth(root, "plan", "plan");

    expect(result).toMatchObject({
      modeApplied: { outcome: "applied", modeId: "plan", origin: "adopted" },
    });
    expect(modeSets).toEqual([]);
  });

  it("an ABSENT currentModeId (an older/non-advertising bridge) falls back to pushing the persisted preference — unchanged pre-fix behavior", async () => {
    const root = freshRoot();
    const { result, modeSets } = await resumeWithGroundTruth(root, "acceptEdits", undefined);

    // Falls back to applyRestoredMode's own push — origin:"confirmed", NOT "adopted": no currentModeId
    // was ever reported, so nothing was actually adopted from the session; this is a genuine live
    // setMode call whose confirmation SHOULD stay subject to mode-active's strict staleness guard.
    expect(result).toMatchObject({
      modeApplied: { outcome: "applied", modeId: "acceptEdits", origin: "confirmed" },
    });
    // Falls back to applyRestoredMode's own push behavior — a live setMode call for the persisted id.
    expect(modeSets).toEqual([{ sessionId: "s-1", modeId: "acceptEdits" }]);
  });
});
