/**
 * @file src/chat/lane-hold-mode.test.ts
 * @purpose The two mode-decision functions an ACP lane runs on every genuine open or resume, proven at
 *   their own seam. THE OPERATOR-VISIBLE FAILURE THESE CATCH is the one W4-R2f RA-2 was raised on:
 *   their chosen mode did not survive a restart, twice over — a resume applied `default` to a lane
 *   whose live catalog advertised the `auto` they had picked, and then persisted the vendor's value
 *   over theirs so the next boot re-offered it as if they had chosen it.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./lane-hold-mode
 *
 * The real `.zer0/native-mode.json` on real disk (a temp repo root per test) and the real
 * `bootNativeModeState` that reads it. The one injected seam is the connection, which is where a
 * bridge process would be — recorded so "was a live setMode actually pushed?" is answered by what the
 * bridge received, never by the returned `origin` alone.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptOrApplyResumedMode, applyRestoredMode } from "./lane-hold-mode.js";

const dirs: string[] = [];
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lane-hold-mode-"));
  dirs.push(repoRoot);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistOperatorChoice(modes: Readonly<Record<string, string>>): string {
  const filePath = join(repoRoot, ".zer0", "native-mode.json");
  mkdirSync(join(repoRoot, ".zer0"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, modes }), "utf8");
  return filePath;
}

interface ModeCalls {
  readonly pushed: string[];
}

/** A connection that records every mode the bridge was actually asked for, and can refuse. */
function modeConnection(calls: ModeCalls, refusal?: string) {
  return {
    initialize: async () => undefined,
    newSession: async () => ({ sessionId: "s1" }),
    resumeSession: async (sessionId: string) => ({ sessionId }),
    prompt: async () => "end_turn",
    setMode: async (_sessionId: string, modeId: string) => {
      calls.pushed.push(modeId);
      if (refusal !== undefined) throw new Error(refusal);
    },
    close: () => undefined,
    waitForExit: async () => true,
    killTree: async () => undefined,
    isAlive: () => true,
    pid: () => 4242,
  } as never;
}

describe("applyRestoredMode: a fresh create takes the operator's persisted choice", () => {
  it("pushes the persisted mode to the bridge and reports it confirmed", async () => {
    persistOperatorChoice({ claude: "auto", codex: "auto", gemini: "default" });
    const calls: ModeCalls = { pushed: [] };

    const outcome = await applyRestoredMode(modeConnection(calls), "s1", "claude", repoRoot);

    expect(outcome).toEqual({ outcome: "applied", modeId: "auto", origin: "confirmed" });
    expect(calls.pushed, "confirmed must mean the bridge really was asked").toEqual(["auto"]);
  });

  it("carries a bridge refusal out instead of claiming the mode applied", async () => {
    persistOperatorChoice({ claude: "auto", codex: "auto", gemini: "default" });
    const calls: ModeCalls = { pushed: [] };

    const outcome = await applyRestoredMode(
      modeConnection(calls, "unknown mode"),
      "s1",
      "claude",
      repoRoot,
    );

    expect(outcome).toEqual({ outcome: "failed", modeId: "auto", reason: "unknown mode" });
  });
});

describe("adoptOrApplyResumedMode: the operator's choice outranks the session's memory", () => {
  it("pushes their choice when the resumed session disagrees with it", async () => {
    persistOperatorChoice({ claude: "auto", codex: "auto", gemini: "default" });
    const calls: ModeCalls = { pushed: [] };

    // The operator's own trace: a resume whose live session reports `default` for a lane they set to
    // `auto`. The old precedence displayed `default`; this must MAKE `auto` true instead.
    const outcome = await adoptOrApplyResumedMode(
      modeConnection(calls),
      "s1",
      "claude",
      repoRoot,
      "default",
    );

    expect(outcome).toEqual({ outcome: "applied", modeId: "auto", origin: "confirmed" });
    expect(calls.pushed).toEqual(["auto"]);
  });
});

describe("adoptOrApplyResumedMode: an adoption is the session's own truth", () => {
  it("adopts with no live call when there is no operator choice to honour", async () => {
    const calls: ModeCalls = { pushed: [] };

    const outcome = await adoptOrApplyResumedMode(
      modeConnection(calls),
      "s1",
      "claude",
      repoRoot,
      "plan",
    );

    expect(outcome).toEqual({ outcome: "applied", modeId: "plan", origin: "adopted" });
    expect(calls.pushed, "an adoption is the session's real state — nothing to push").toEqual([]);
  });

  it("adopts without a live call when the session is already on their choice", async () => {
    persistOperatorChoice({ claude: "auto", codex: "auto", gemini: "default" });
    const calls: ModeCalls = { pushed: [] };

    const outcome = await adoptOrApplyResumedMode(
      modeConnection(calls),
      "s1",
      "claude",
      repoRoot,
      "auto",
    );

    expect(outcome).toEqual({ outcome: "applied", modeId: "auto", origin: "adopted" });
    expect(calls.pushed).toEqual([]);
  });
});

describe("adoptOrApplyResumedMode: a refusal is reported, never written back", () => {
  it("displays the mode the lane is really in and never overwrites their file", async () => {
    const filePath = persistOperatorChoice({
      claude: "auto",
      codex: "auto",
      gemini: "default",
    });
    const calls: ModeCalls = { pushed: [] };

    const outcome = await adoptOrApplyResumedMode(
      modeConnection(calls, "mode not available"),
      "s1",
      "claude",
      repoRoot,
      "default",
    );

    expect(outcome).toEqual({
      outcome: "applied",
      modeId: "default",
      origin: "adopted",
      rejected: "mode not available",
    });
    // The refusal of ONE session is not the operator changing their mind: their file must still say
    // `auto`, so their choice gets its next chance at the next boot. A vendor value written back here
    // is exactly what destroyed the evidence of their real choice in the original trace.
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      modes: { claude: "auto", codex: "auto", gemini: "default" },
    });
  });

  it("falls back to a push when the bridge advertises no current mode at all", async () => {
    persistOperatorChoice({ claude: "auto", codex: "auto", gemini: "default" });
    const calls: ModeCalls = { pushed: [] };

    const outcome = await adoptOrApplyResumedMode(
      modeConnection(calls),
      "s1",
      "claude",
      repoRoot,
      undefined,
    );

    expect(outcome).toEqual({ outcome: "applied", modeId: "auto", origin: "confirmed" });
    expect(calls.pushed, "there is nothing to adopt, so the choice is pushed").toEqual(["auto"]);
  });
});
