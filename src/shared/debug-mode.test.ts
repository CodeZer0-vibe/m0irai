/**
 * @file src/shared/debug-mode.test.ts
 * @purpose Contract for the ZER0_DEBUG resolution seam: the truthiness predicate (falsy sentinels OFF),
 *   activation creating `.zer0/debug/<sessionId>/` + its three sink paths ONLY when enabled (a no-op returning
 *   undefined when off — byte-identical), the singleton read/reset, and resolveTraceSink's override matrix
 *   (explicit env wins → session default → undefined).
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, node:process, vitest, ./debug-mode
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateDebugSession,
  debugEnabled,
  debugSession,
  resetDebugSession,
  resolveTraceSink,
} from "./debug-mode.js";
import { createLogger } from "./logger.js";
import { claimScreen, releaseScreen } from "./screen-claim.js";
import { appendTuiSuppressed } from "./tui-suppressed-log.js";

const OLD_DEBUG = process.env.ZER0_DEBUG;
let tempRoot: string | undefined;
let originalCwd: string | undefined;

function setDebug(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "ZER0_DEBUG");
  } else {
    process.env.ZER0_DEBUG = value;
  }
}

beforeEach(() => {
  resetDebugSession();
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(path.join(tmpdir(), "zer0-debug-mode-"));
  process.chdir(tempRoot);
});

afterEach(() => {
  resetDebugSession();
  setDebug(OLD_DEBUG);
  if (originalCwd !== undefined) {
    process.chdir(originalCwd);
  }
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("debugEnabled — the canonical ZER0_DEBUG truthiness gate", () => {
  it("is TRUE for a meaningfully-truthy value and FALSE for the falsy sentinels", () => {
    setDebug("1");
    expect(debugEnabled()).toBe(true);
    setDebug("yes");
    expect(debugEnabled()).toBe(true);
    // NB: unset is NOT a falsy sentinel — it now reads ON (opt-out default, its own test below).
    setDebug("");
    expect(debugEnabled()).toBe(false);
    setDebug("0");
    expect(debugEnabled()).toBe(false);
    setDebug("false");
    expect(debugEnabled()).toBe(false);
  });

  it("defaults ON when unset — opt-OUT semantics (B2a-1: ZER0_DEBUG flipped on-by-default)", () => {
    setDebug(undefined);
    expect(debugEnabled()).toBe(true);
  });

  it("normalizes case + whitespace before matching the off-sentinels (no operator surprise)", () => {
    const evaluate = (value: string): boolean => {
      setDebug(value);
      return debugEnabled();
    };
    // A falsy-LOOKING value must read OFF regardless of case/whitespace — `ZER0_DEBUG=False` must not ENABLE.
    const off = [
      "",
      "  ",
      "0",
      " 0 ",
      "false",
      "False",
      "FALSE",
      " false ",
      "no",
      "No",
      "off",
      "OFF",
    ];
    const on = ["1", " 1 ", "true", "TRUE", "yes", "on", "enabled"];
    expect(off.map(evaluate)).toEqual(off.map(() => false));
    expect(on.map(evaluate)).toEqual(on.map(() => true));
  });
});

describe("activateDebugSession — the per-session folder", () => {
  it("with debug OFF (explicit =0): a no-op — returns undefined and creates NO folder (byte-identical)", () => {
    setDebug("0"); // B2a-1: debug is on-by-default now, so the OFF path needs an explicit opt-out
    expect(activateDebugSession("chat-1700000000000")).toBeUndefined();
    expect(debugSession()).toBeUndefined();
    expect(existsSync(path.join(tempRoot ?? "", ".zer0", "debug"))).toBe(false);
  });

  it("with debug UNSET (default ON, B2a-1): a fresh first-run boot WRITES artifacts — the folder is created", () => {
    setDebug(undefined); // no env at all — the on-by-default first-run shape
    const session = activateDebugSession("chat-1700000000000");
    expect(session).toBeDefined();
    expect(existsSync(path.join(tempRoot ?? "", ".zer0", "debug", "chat-1700000000000"))).toBe(
      true,
    );
  });

  it("with debug ON: creates .zer0/debug/<id>/ (absolute) with trace/flicker/suppressed paths under it", () => {
    setDebug("1");
    const session = activateDebugSession("chat-1700000000000");
    expect(session).toBeDefined();
    if (session === undefined) return;
    const expectedDir = path.resolve(".zer0", "debug", "chat-1700000000000");
    expect(session.dir).toBe(expectedDir);
    expect(path.isAbsolute(session.dir)).toBe(true);
    expect(existsSync(session.dir)).toBe(true);
    expect(session.tracePath).toBe(path.join(expectedDir, "trace.ndjson"));
    expect(session.flickerPath).toBe(path.join(expectedDir, "flicker.log"));
    expect(session.suppressedPath).toBe(path.join(expectedDir, "suppressed.log"));
    expect(debugSession()).toEqual(session);
  });

  it("strips path separators from the session id so the folder can never escape .zer0/debug/", () => {
    setDebug("1");
    const session = activateDebugSession("../../etc/evil");
    expect(session).toBeDefined();
    if (session === undefined) return;
    const debugRoot = path.resolve(".zer0", "debug");
    expect(session.dir.startsWith(debugRoot)).toBe(true);
  });

  it("resetDebugSession clears the singleton (no leak into the next test)", () => {
    setDebug("1");
    activateDebugSession("chat-1700000000000");
    expect(debugSession()).toBeDefined();
    resetDebugSession();
    expect(debugSession()).toBeUndefined();
  });
});

describe("activateDebugSession — explicit baseDir (MT3e detached-child hold fix)", () => {
  it("roots the debug folder under the given baseDir, not cwd", () => {
    setDebug("1");
    const base = mkdtempSync(path.join(tmpdir(), "zer0-base-")); // a dir DIFFERENT from cwd (tempRoot)
    try {
      const session = activateDebugSession("chat-1700000000000", base);
      expect(session).toBeDefined();
      if (session === undefined) return;
      expect(session.dir).toBe(path.resolve(base, ".zer0", "debug", "chat-1700000000000"));
      expect(session.tracePath).toBe(path.join(session.dir, "trace.ndjson"));
      expect(session.dir.startsWith(tempRoot ?? "\x00")).toBe(false); // NOT under cwd — the override took
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("resolveTraceSink — the explicit-env-wins override matrix (acceptance 3)", () => {
  it("an explicit ZER0_CHAT_TRACE destination WINS over the session default", () => {
    setDebug("1");
    activateDebugSession("chat-1700000000000");
    expect(resolveTraceSink("/tmp/explicit.ndjson")).toBe("/tmp/explicit.ndjson");
  });

  it("falls back to the active session's trace.ndjson when no explicit env is set", () => {
    setDebug("1");
    const session = activateDebugSession("chat-1700000000000");
    expect(resolveTraceSink(undefined)).toBe(session?.tracePath);
    expect(resolveTraceSink("")).toBe(session?.tracePath);
  });

  it("is undefined when neither an explicit env nor an ACTIVE debug session exists (no sink to route to)", () => {
    // Debug is on-by-default (B2a-1), but this test's contract is "no active session" — beforeEach's
    // resetDebugSession left `active` undefined and nothing activated one, so there is no sink regardless.
    setDebug("0");
    expect(resolveTraceSink(undefined)).toBeUndefined();
  });
});

// Acceptance 1 (integration): ONE switch gathers the sinks. A debug-level log line — emitted BECAUSE the
// floor is active, teed to the suppressed sink BECAUSE the screen is claimed — plus a direct suppressed
// append and the resolved trace path all land under the same .zer0/debug/<session>/ folder.
describe("ZER0_DEBUG gathers the sinks into one session folder (cross-module)", () => {
  it("a claimed-screen debug log + a suppressed append + the trace path all resolve to the session folder", () => {
    setDebug("1");
    const session = activateDebugSession("chat-integration");
    expect(session).toBeDefined();
    if (session === undefined) return;

    claimScreen();
    try {
      createLogger().debug({ phase: "audit" }, "integration-debug-line");
      appendTuiSuppressed("integration-suppressed-line\n");
    } finally {
      releaseScreen();
    }

    const gathered = readFileSync(session.suppressedPath, "utf8");
    expect(gathered).toContain("integration-debug-line"); // DEBUG survived the info→debug floor + routed here
    expect(gathered).toContain("integration-suppressed-line");
    expect(resolveTraceSink(undefined)).toBe(session.tracePath);
    expect(session.dir).toBe(path.resolve(".zer0", "debug", "chat-integration"));
  });
});
