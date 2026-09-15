/**
 * @file src/chat/lane-transport-resume-mode-operator.test.ts
 * @purpose W4-R2f RA-2 falsifier: on RESUME the OPERATOR's persisted lane mode wins over the resumed
 *   session's own currentModeId — the exact shape of the operator's 2026-07-31 trace, where a boot
 *   restore applied `default` to a lane whose live catalog advertised `auto`, and then OVERWROTE the
 *   operator's choice on disk. Kept in its own file rather than folded into
 *   lane-transport-resume-mode-adoption.test.ts so the operator-reported scenario stays findable by
 *   name; that sibling holds the general precedence contract.
 * @exports (none — test file)
 * @depends vitest, ../adapters/acp/acp-lane-session, ./lane-transport, ./native-mode-store, ./native-mode
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import { createCockpitLaneTransport } from "./lane-transport.js";
import { bootNativeModeState, persistNativeMode } from "./native-mode-store.js";
import { initialNativeModeState } from "./native-mode.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "lane-resume-operator-"));
  tempRoots.push(root);
  return root;
}

// The operator's own boot, reduced to its two moving parts: what THEY last chose (on disk) and what
// the resumed bridge session reports as its current mode. `rejectMode` reproduces a bridge that
// refuses the operator's choice, the one case where adopting the session's value is correct.
function resumeAs(currentModeId: string | undefined, rejectMode?: Error) {
  const modeSets: { sessionId: string; modeId: string }[] = [];
  const conn: LaneConnection = {
    initialize: async () => ({}),
    newSession: async () => ({ sessionId: "unused" }),
    resumeSession: async () => (currentModeId !== undefined ? { currentModeId } : {}),
    prompt: async () => "end_turn",
    setMode: async (sessionId, modeId) => {
      modeSets.push({ sessionId, modeId });
      if (rejectMode !== undefined) throw rejectMode;
    },
    close: () => undefined,
    waitForExit: async () => true,
    killTree: async () => undefined,
    isAlive: () => true,
    pid: () => 4242,
  };
  return { conn, modeSets };
}

async function bootRestore(root: string, currentModeId: string | undefined, rejectMode?: Error) {
  const { conn, modeSets } = resumeAs(currentModeId, rejectMode);
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: "C:/repo",
    repoRoot: root,
    openConnection: async () => conn,
  });
  const result = await transport.start("s-resumed");
  return { result, modeSets };
}

// THE OPERATOR'S TRACE, 2026-07-31 (TeamWork/.zer0/debug/chat-1785511159817-.../trace.ndjson:6):
//   {"kind":"mode.session","agent":"claude","turn":0,"outcome":"applied","modeId":"default",
//    "availableModeIds":["auto","default","acceptEdits","plan","dontAsk","bypassPermissions"]}
// A resume applied `default` to a session whose live catalog advertises `auto`. The operator had
// chosen `auto`; the restore silently replaced it AND persisted the replacement, which is why their
// choice cannot be read back off disk today.
it("the operator's persisted `auto` survives a resumed session that reports `default`", async () => {
  const root = freshRoot();
  persistNativeMode(root, {
    ...initialNativeModeState(),
    claude: { modeId: "auto", status: "active" },
  });

  const { result, modeSets } = await bootRestore(root, "default");

  // The lane ends up on the operator's mode, applied by a REAL live call (never a display-only claim).
  expect(result).toMatchObject({
    outcome: "resumed",
    modeApplied: { outcome: "applied", modeId: "auto", origin: "confirmed" },
  });
  expect(modeSets).toEqual([{ sessionId: "s-resumed", modeId: "auto" }]);
  // And their choice is still on disk afterwards — the restore never writes the vendor's value over it.
  expect(bootNativeModeState(root).state.claude.modeId).toBe("auto");
});

// The narrow case where the session's value legitimately wins: the bridge REFUSED the operator's mode.
// Adopting is then the only honest display (the lane really is on `default`), and the refusal itself
// must reach the operator rather than vanish — never a silent downgrade.
it("a REJECTED persisted mode adopts the session's real mode and carries the refusal", async () => {
  const root = freshRoot();
  persistNativeMode(root, {
    ...initialNativeModeState(),
    claude: { modeId: "auto", status: "active" },
  });

  const { result, modeSets } = await bootRestore(root, "default", new Error("mode not supported"));

  expect(modeSets).toEqual([{ sessionId: "s-resumed", modeId: "auto" }]);
  expect(result).toMatchObject({
    modeApplied: {
      outcome: "applied",
      modeId: "default",
      origin: "adopted",
      rejected: "mode not supported",
    },
  });
  // The operator's choice STAYS on disk: one session's refusal is not them changing their mind.
  expect(bootNativeModeState(root).state.claude.modeId).toBe("auto");
});

// No persisted file at all (a fresh project): there is no operator choice to honour, so the session's
// own current mode is the only truth available — adopted, with no live call and no disk write.
it("with NO persisted choice, the session's current mode is adopted and nothing is written", async () => {
  const root = freshRoot();

  const { result, modeSets } = await bootRestore(root, "plan");

  expect(result).toMatchObject({
    modeApplied: { outcome: "applied", modeId: "plan", origin: "adopted" },
  });
  expect(modeSets).toEqual([]);
  // native-mode.json is the OPERATOR's file. A vendor value must never appear in it behind their back.
  expect(bootNativeModeState(root).persisted).toBe(false);
});
