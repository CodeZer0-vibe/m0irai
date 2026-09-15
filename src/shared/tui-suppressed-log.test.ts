/**
 * @file src/shared/tui-suppressed-log.test.ts
 * @purpose Contract for the fail-soft suppressed-output sink: verbatim append (no added framing),
 *   successive appends concatenate, missing parent dirs are created, and ANY write failure is swallowed
 *   (never throws — a sink failure must not crash a render or a log call). Also covers bridgeSuppressedFallback
 *   (sol BLOCK 1 DECISION): a session that registers after the cwd fallback already carries boot-window
 *   bytes gets a one-line pointer to it; absent or empty fallback stays silent.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./debug-mode, ./tui-suppressed-log
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateDebugSession, resetDebugSession } from "./debug-mode.js";
import {
  TUI_SUPPRESSED_LOG_PATH,
  appendTuiSuppressed,
  bridgeSuppressedFallback,
} from "./tui-suppressed-log.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("appendTuiSuppressed", () => {
  it("creates missing parent directories and appends the text verbatim", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-tui-sink-"));
    const path = join(tempRoot, "nested", "tui-suppressed.log");

    appendTuiSuppressed("first line\n", path);

    expect(readFileSync(path, "utf8")).toBe("first line\n");
  });

  it("concatenates successive appends without inserting framing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-tui-sink-"));
    const path = join(tempRoot, "tui-suppressed.log");

    appendTuiSuppressed("a", path);
    appendTuiSuppressed("b\n", path);

    expect(readFileSync(path, "utf8")).toBe("ab\n");
  });

  it("swallows a write failure (parent path is a file) and never throws", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "zer0-tui-sink-"));
    const fileAsDir = join(tempRoot, "not-a-dir");
    writeFileSync(fileAsDir, "");
    const path = join(fileAsDir, "tui-suppressed.log");

    expect(() => appendTuiSuppressed("x", path)).not.toThrow();
  });

  it("defaults to the .zer0/tui-suppressed.log cwd-relative path", () => {
    expect(TUI_SUPPRESSED_LOG_PATH).toBe(".zer0/tui-suppressed.log");
  });
});

// When ZER0_DEBUG activates a session, the default sink path MOVES into the session folder so every suppressed
// diagnostic is gathered with the other debug artifacts; when no session is active it stays at the cwd default
// (acceptance 2: byte-identical when off). Callers passing an explicit path still win (the first describe).
describe("appendTuiSuppressed — debug-session routing", () => {
  const OLD_DEBUG = process.env.ZER0_DEBUG;
  let originalCwd: string;
  let routeRoot: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    routeRoot = mkdtempSync(join(tmpdir(), "zer0-tui-route-"));
    process.chdir(routeRoot);
    process.env.ZER0_DEBUG = "1";
  });

  afterEach(() => {
    resetDebugSession();
    process.chdir(originalCwd);
    if (OLD_DEBUG === undefined) {
      Reflect.deleteProperty(process.env, "ZER0_DEBUG");
    } else {
      process.env.ZER0_DEBUG = OLD_DEBUG;
    }
    rmSync(routeRoot, { recursive: true, force: true });
  });

  it("a default-path append lands in the active session's suppressed.log, not the cwd default", () => {
    const session = activateDebugSession("chat-route");
    expect(session).toBeDefined();
    if (session === undefined) return;

    appendTuiSuppressed("routed diagnostic\n");

    expect(readFileSync(session.suppressedPath, "utf8")).toContain("routed diagnostic");
    expect(existsSync(join(routeRoot, TUI_SUPPRESSED_LOG_PATH))).toBe(false);
  });
});

// Shared cwd+ZER0_DEBUG fixture for the breadcrumb describe below — pulled out of the describe body so
// that body stays under the 50-line function ceiling (repo mechanical gate) alongside its 3 tests.
function useBridgeFixture(): { bridgeRoot: string } {
  const OLD_DEBUG = process.env.ZER0_DEBUG;
  let originalCwd: string;
  const fixture = { bridgeRoot: "" };
  beforeEach(() => {
    originalCwd = process.cwd();
    fixture.bridgeRoot = mkdtempSync(join(tmpdir(), "zer0-tui-bridge-"));
    process.chdir(fixture.bridgeRoot);
    process.env.ZER0_DEBUG = "1";
  });
  afterEach(() => {
    resetDebugSession();
    process.chdir(originalCwd);
    if (OLD_DEBUG === undefined) {
      Reflect.deleteProperty(process.env, "ZER0_DEBUG");
    } else {
      process.env.ZER0_DEBUG = OLD_DEBUG;
    }
    rmSync(fixture.bridgeRoot, { recursive: true, force: true });
  });
  return fixture;
}

// sol audit BLOCK 1 DECISION (RFIX fix round): boot-window suppressed lines land in the cwd fallback
// (nothing has registered a debug session yet at write time); a session that registers AFTER that
// window would otherwise strand the operator with no trail back to those earlier lines from inside the
// session folder. bridgeSuppressedFallback closes that gap with a plain pointer line — never a copy or
// move of the fallback's own bytes, which must stay exactly where they landed. Split into two describe
// blocks (repo convention — a single block here exceeds the 50-line function cap) so each still fits.
describe("bridgeSuppressedFallback — pointer present/absent", () => {
  const fixture = useBridgeFixture();

  it("a non-empty cwd fallback present at registration gets a pointer line in the session's own suppressed.log", () => {
    // Simulates the boot window: a Logger line landed in the default (fallback) sink BEFORE any debug
    // session existed — the exact shape of prepareBoot's db-open lines ahead of activateDebugSession.
    appendTuiSuppressed("[DEBUG] database opened {}\n");

    const session = activateDebugSession("chat-bridge-present");
    expect(session).toBeDefined();
    if (session === undefined) return;
    bridgeSuppressedFallback(session);

    const sessionLog = readFileSync(session.suppressedPath, "utf8");
    // FALSIFYING (verified against the real layout): the session dir is .zer0/debug/<id>/, the fallback
    // is .zer0/tui-suppressed.log — exactly two levels up reaches it.
    expect(sessionLog).toContain("earlier boot-window lines: see ../../tui-suppressed.log");
    // FALSIFYING (pointer only, never a migration): the fallback file itself is untouched.
    expect(readFileSync(join(fixture.bridgeRoot, TUI_SUPPRESSED_LOG_PATH), "utf8")).toBe(
      "[DEBUG] database opened {}\n",
    );
  });

  it("no cwd fallback file present at registration — no pointer, no session suppressed.log created", () => {
    const session = activateDebugSession("chat-bridge-absent");
    expect(session).toBeDefined();
    if (session === undefined) return;

    bridgeSuppressedFallback(session);

    expect(existsSync(session.suppressedPath)).toBe(false);
  });
});

describe("bridgeSuppressedFallback — empty vs. unreadable fallback (sol r2 BLOCK 2)", () => {
  const fixture = useBridgeFixture();

  it("an EMPTY cwd fallback file present at registration — still no pointer (exists but nothing to point at)", () => {
    appendTuiSuppressed(""); // creates the fallback file at 0 bytes, mirroring appendFileSync's own semantics

    const session = activateDebugSession("chat-bridge-empty");
    expect(session).toBeDefined();
    if (session === undefined) return;
    bridgeSuppressedFallback(session);

    expect(existsSync(session.suppressedPath)).toBe(false);
  });

  it("a fallback that EXISTS but can't be read (EISDIR) gets a classified line, never a silent swallow", () => {
    // A directory sitting at the fallback path (not ENOENT — the path IS occupied) makes readFileSync
    // throw EISDIR: a real failure to read something that might carry boot-window bytes, distinct from
    // the ordinary "no fallback this run" case above.
    mkdirSync(join(fixture.bridgeRoot, TUI_SUPPRESSED_LOG_PATH), { recursive: true });

    const session = activateDebugSession("chat-bridge-unreadable");
    expect(session).toBeDefined();
    if (session === undefined) return;

    expect(() => bridgeSuppressedFallback(session)).not.toThrow();

    // FALSIFYING (no-silent-swallow): a real read failure is CLASSIFIED, not dropped — the whole point
    // of this module is that a suppressed diagnostic must never vanish without a trace.
    const sessionLog = readFileSync(session.suppressedPath, "utf8");
    expect(sessionLog).toContain("EISDIR");
    expect(sessionLog).toContain(TUI_SUPPRESSED_LOG_PATH);
  });
});
