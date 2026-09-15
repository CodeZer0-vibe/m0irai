/**
 * @file src/chat/lane-availability-store.test.ts
 * @purpose F1 (FIX-3) durable-store contract: the .zer0/lane-availability.json persistence + the gate
 *   read (evaluateSend). The load-bearing proof is DURABILITY — a lane marked exhausted in one process is
 *   RECONSTRUCTED after a restart (fresh store init from the same dir) so the very first send is gated
 *   before any child is spawned. Also asserts evaluateSend's allow/block/retry policy and availableLaneNames.
 * @exports (none — test file)
 * @depends vitest, node:fs, node:os, node:path, ./lane-availability-store
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  availableLaneNames,
  evaluateSend,
  getLaneAvailability,
  initLaneAvailabilityStore,
  noteLaneBlockedSend,
  noteLaneFailure,
  noteLaneResetWindow,
  noteLaneSuccess,
  resetLaneAvailabilityStore,
} from "./lane-availability-store.js";
import { FALLBACK_COOLDOWN_MS } from "./lane-availability.js";

const CREDIT =
  "Internal error: You're out of usage credits. Run /usage-credits to keep using Fable 5.";
const AUTH = "Authentication required";
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zer0-lane-avail-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetLaneAvailabilityStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F1 store: durability across a restart", () => {
  it("reconstructs an exhausted lane from disk on a fresh init (the restart-before-first-send guarantee)", () => {
    const dir = freshDir();
    initLaneAvailabilityStore(dir);
    noteLaneFailure("claude", CREDIT, 1000);
    expect(getLaneAvailability("claude").state).toBe("exhausted");

    // Simulate a TUI restart: wipe the process registry, re-init from the SAME project dir.
    resetLaneAvailabilityStore();
    expect(getLaneAvailability("claude").state).toBe("ready"); // registry cleared
    initLaneAvailabilityStore(dir);
    // Reconstructed BEFORE any send — the very first send will be gated.
    const reloaded = getLaneAvailability("claude");
    expect(reloaded.state).toBe("exhausted");
    expect(reloaded.cause).toBe("exhausted");
    expect(reloaded.reason).toBeTruthy();
  });

  it("writes a schema-versioned JSON file with the zer0 reason (never the raw child string)", () => {
    const dir = freshDir();
    initLaneAvailabilityStore(dir);
    noteLaneFailure("claude", CREDIT, 1000);
    const onDisk = readFileSync(join(dir, ".zer0", "lane-availability.json"), "utf8");
    expect(JSON.parse(onDisk).version).toBe(1);
    expect(onDisk).not.toContain("/usage-credits");
    expect(onDisk).not.toContain("Internal error");
  });
});

describe("F1 store: corrupt-file + recovery durability", () => {
  it("a malformed file degrades to ready (a corrupt state file never blocks a live lane)", () => {
    const dir = freshDir();
    initLaneAvailabilityStore(dir);
    noteLaneFailure("claude", CREDIT, 1000);
    // Corrupt the file, then re-init.
    const file = join(dir, ".zer0", "lane-availability.json");
    rmSync(file);
    writeFileSync(file, "not valid json at all", "utf8");
    resetLaneAvailabilityStore();
    initLaneAvailabilityStore(dir);
    expect(getLaneAvailability("claude").state).toBe("ready");
  });

  it("a real success clears the death and persists ready", () => {
    const dir = freshDir();
    initLaneAvailabilityStore(dir);
    noteLaneFailure("claude", AUTH, 1000);
    expect(getLaneAvailability("claude").state).toBe("needs_auth");
    noteLaneSuccess("claude", 2000);
    resetLaneAvailabilityStore();
    initLaneAvailabilityStore(dir);
    expect(getLaneAvailability("claude").state).toBe("ready");
  });
});

describe("F1 store: evaluateSend gate policy + available lanes", () => {
  it("a ready lane allows dispatch (not retrying)", () => {
    initLaneAvailabilityStore(freshDir());
    expect(evaluateSend("claude", 1000)).toMatchObject({ allow: true, retrying: false });
  });

  it("an exhausted lane BLOCKS a normal send (no explicit retry, no reset window)", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneFailure("claude", CREDIT, 1000);
    expect(evaluateSend("claude", 2000)).toMatchObject({ allow: false, retrying: false });
  });

  // FIX-3c BLOCK 2: the explicitRetry parameter is gone (production never supplied it). The ONE sanctioned
  // recovery path is now "a probe is due" — which this asserts through the liveness ceiling, so the removal
  // is covered by a real reachability test rather than by a parameter no caller could set.
  it("a probe becomes due after the liveness ceiling even with no reset window in sight", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneFailure("claude", CREDIT, 1000);
    expect(evaluateSend("claude", 2000)).toMatchObject({ allow: false, retrying: false });
    expect(evaluateSend("claude", 1000 + FALLBACK_COOLDOWN_MS + 1)).toMatchObject({
      allow: true,
      retrying: true,
    });
  });

  it("a passed reset window auto-allows a retry", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneFailure("claude", CREDIT, 1000, 5000); // resetsAtMs = 5000
    expect(evaluateSend("claude", 4000)).toMatchObject({ allow: false }); // window not yet reset
    expect(evaluateSend("claude", 5001)).toMatchObject({ allow: true, retrying: true });
  });

  it("availableLaneNames names the live lanes when claude is dead (@all skip source)", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneFailure("claude", CREDIT, 1000);
    noteLaneBlockedSend("claude", 1500);
    expect(availableLaneNames(["claude", "codex", "gemini"])).toEqual(["codex", "gemini"]);
  });
});

describe("F1 store: production recovery reachability (BLOCK 1)", () => {
  it("a 3-arg (production) death auto-allows a retry after the fallback cooldown — no explicit retry", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneFailure("claude", CREDIT, 1000); // EXACTLY the production call shape (lane-gate.ts)
    expect(evaluateSend("claude", 1000 + 60_000)).toMatchObject({ allow: false }); // still cooling
    expect(evaluateSend("claude", 1000 + FALLBACK_COOLDOWN_MS + 1)).toMatchObject({
      allow: true,
      retrying: true,
    });
  });

  it("a real reset window seen via noteLaneResetWindow WINS over the fallback on the next death", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneResetWindow("claude", 3000); // the usage stream reported the true 5h reset instant
    noteLaneFailure("claude", CREDIT, 1000); // 3-arg death; picks up the known window (3000, not +15min)
    expect(getLaneAvailability("claude").resetsAtMs).toBe(3000);
    expect(evaluateSend("claude", 2999)).toMatchObject({ allow: false });
    expect(evaluateSend("claude", 3001)).toMatchObject({ allow: true, retrying: true });
  });
});

/**
 * DELTA ITEM 2 — A REMEMBERED WINDOW IS NEITHER TIMELESS NOR CAUSE-FREE.
 *
 * `knownResetWindow` never expires and was offered to EVERY classified death, which broke twice:
 *
 *   - a window whose instant has already PASSED made a brand-new exhaustion probe-eligible on the spot,
 *     so every subsequent send burned a real dispatch instead of waiting out the fallback cooldown;
 *   - a QUOTA window rode onto a `needs_auth` death, where it means nothing — an expired sign-in does
 *     not come back when a rate window rolls over, and the terminal retires the painted state on that
 *     instant regardless of which death produced it.
 *
 * Both reproductions below are the review's own, at its own instants.
 */
describe("DELTA 2: a remembered reset window is quota-scoped and freshness-scoped", () => {
  it("a window already in the PAST is dropped, and the fallback cooldown applies instead", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneResetWindow("claude", 9_999); // remembered from a window that has since rolled over
    const spent = noteLaneFailure("claude", CREDIT, 10_000);

    expect(
      spent.resetsAtMs,
      "a reset instant older than the death itself was published as this death's window - the terminal retires the red word the moment it paints it",
    ).toBeUndefined();
    expect(spent.probeAtMs).toBe(10_000 + FALLBACK_COOLDOWN_MS);
    expect(
      evaluateSend("claude", 10_001),
      "a fresh exhaustion was probe-eligible one millisecond later - every send burns a real dispatch",
    ).toMatchObject({ allow: false, retrying: false });
    expect(evaluateSend("claude", 10_000 + FALLBACK_COOLDOWN_MS + 1)).toMatchObject({
      allow: true,
      retrying: true,
    });
  });

  it("a quota window is never attached to a needs_auth death", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneResetWindow("claude", 15_000); // a real, still-future QUOTA window
    const auth = noteLaneFailure("claude", AUTH, 10_000);

    expect(auth.state).toBe("needs_auth");
    expect(
      auth.resetsAtMs,
      "a rate window was attached to an expired sign-in - nothing about that instant says the lane can log in again",
    ).toBeUndefined();
    expect(
      auth.probeAtMs,
      "the needs_auth reconnect probe was scheduled off a quota window instead of its own cooldown",
    ).toBe(10_000 + FALLBACK_COOLDOWN_MS);
  });

  it("a still-future quota window is still honoured on a quota death (the fix does not close the door)", () => {
    initLaneAvailabilityStore(freshDir());
    noteLaneResetWindow("claude", 900_000);
    const spent = noteLaneFailure("claude", CREDIT, 10_000);
    expect(spent.resetsAtMs).toBe(900_000);
    expect(spent.probeAtMs).toBe(900_000);
  });
});
