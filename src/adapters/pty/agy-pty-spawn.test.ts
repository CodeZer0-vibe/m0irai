/**
 * @file src/adapters/pty/agy-pty-spawn.test.ts
 * @purpose Falsifiers for the agy spawn helpers' PURE logic (node-pty + node:fs are mocked so the suite
 *   never loads the native module): agyChildEnv forwards only whitelisted vars and NEVER provider API
 *   keys (INV-4 subscription-only), and agyExePath resolves LOCALAPPDATA/agy/bin/agy.exe — throwing a
 *   clear error when LOCALAPPDATA is unset or the CLI is not installed.
 * @exports (test suite — no runtime exports)
 * @depends vitest, node-pty (mocked), node:fs (mocked), ./agy-pty-spawn
 */
import { afterEach, expect, it, vi } from "vitest";
import { HermeticSpawnRefused } from "../../shared/hermetic.js";
import { agyChildEnv, agyExePath } from "./agy-pty-spawn.js";

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => true) }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));

const SAVED_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED_ENV };
  existsSyncMock.mockReturnValue(true);
});

it("agyChildEnv NEVER forwards provider API keys (INV-4 subscription-only)", () => {
  process.env.ANTHROPIC_API_KEY = "sk-secret";
  process.env.GEMINI_API_KEY = "g-secret";
  process.env.GOOGLE_API_KEY = "goog-secret";
  process.env.OPENAI_API_KEY = "oai-secret";

  const env = agyChildEnv();

  expect(Object.keys(env).some((key) => /API_KEY/i.test(key))).toBe(false);
  expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(env).not.toHaveProperty("GEMINI_API_KEY");
});

it("agyChildEnv forwards whitelisted process vars when present", () => {
  process.env.LOCALAPPDATA = "C:/Users/x/AppData/Local";
  const env = agyChildEnv();
  expect(env.LOCALAPPDATA).toBe("C:/Users/x/AppData/Local");
  // PATH or Path (Windows casing) — at least one is forwarded in a real shell environment.
  expect("PATH" in env || "Path" in env).toBe(true);
});

it("agyExePath throws a clear error when LOCALAPPDATA is unset", () => {
  process.env.LOCALAPPDATA = "";
  expect(() => agyExePath()).toThrow(/LOCALAPPDATA unset/);
});

it("agyExePath builds the agy.exe path under LOCALAPPDATA when installed", () => {
  process.env.LOCALAPPDATA = "C:/Local";
  existsSyncMock.mockReturnValue(true);
  expect(agyExePath().replace(/\\/g, "/")).toBe("C:/Local/agy/bin/agy.exe");
});

it("agyExePath throws when agy.exe is absent (Antigravity CLI not installed)", () => {
  process.env.LOCALAPPDATA = "C:/Local";
  existsSyncMock.mockReturnValue(false);
  expect(() => agyExePath()).toThrow(/not found/);
});

// H2 round 2 / I6: the gate-hermetic-seams.mjs EXEMPT reasons for agy-mode-probe.ts, agy.ts and
// agy-models-run.ts cite this exact fact (agyExePath.ts:20's assertNotHermetic runs as the FIRST
// statement) instead of an untracked .verify-logs script — this test is the checkable evidence. Setting
// LOCALAPPDATA to an unset-triggering value too proves the hermetic throw wins even when a LATER
// statement in the same function would ALSO have thrown for an unrelated reason.
it("agyExePath refuses under ZER0_HERMETIC=1 before it ever reaches LOCALAPPDATA/existsSync (its first statement is assertNotHermetic)", () => {
  process.env.ZER0_HERMETIC = "1";
  process.env.LOCALAPPDATA = "";
  existsSyncMock.mockClear(); // earlier tests in this file already called it; only THIS call matters
  existsSyncMock.mockReturnValue(false);

  let caught: unknown;
  try {
    agyExePath();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HermeticSpawnRefused);
  expect((caught as HermeticSpawnRefused).message).toMatch(
    /hermetic mode \(ZER0_HERMETIC=1\): refusing to spawn an agent process at agy-pty-spawn\.agyExePath/,
  );
  expect(existsSyncMock).not.toHaveBeenCalled();
});
