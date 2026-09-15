/**
 * @file src/adapters/pty/agy-models-run.test.ts
 * @purpose Falsifiers for the `agy models` ConPTY runner (node-pty + node:fs mocked — never loads the native
 *   module): spawns agy with the `models` subcommand, resolves the captured stdout on agy's exit (and kills
 *   the child), and fails soft to "" when the spawn throws.
 * @exports (test suite — no runtime exports)
 * @depends vitest, node-pty (mocked), node:fs (mocked), ./agy-models-run
 */
import * as pty from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { runAgyModels } from "./agy-models-run.js";

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn(() => true) }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));

const SAVED_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
});

function fakeTerm() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: () => void = () => {};
  return {
    onData: vi.fn((cb: (d: string) => void) => {
      dataCb = cb;
    }),
    onExit: vi.fn((cb: () => void) => {
      exitCb = cb;
    }),
    kill: vi.fn(),
    fireData: (d: string) => dataCb(d),
    fireExit: () => exitCb(),
  };
}

it("spawns `agy models`, resolves the captured stdout on exit, and kills the child", async () => {
  process.env.LOCALAPPDATA = "C:/Local";
  const term = fakeTerm();
  vi.mocked(pty.spawn).mockReturnValue(term as never);

  const pending = runAgyModels();
  const [cmd, args] = vi.mocked(pty.spawn).mock.calls[0] as [string, string[], unknown];
  expect(cmd.replace(/\\/g, "/")).toBe("C:/Local/agy/bin/agy.exe");
  expect(args).toEqual(["models"]);

  term.fireData("Gemini 3.1 Pro (High)\r\n");
  term.fireExit();
  await expect(pending).resolves.toContain("Gemini 3.1 Pro (High)");
  expect(term.kill).toHaveBeenCalled();
});

it("resolves '' when agy cannot be spawned", async () => {
  process.env.LOCALAPPDATA = "C:/Local";
  vi.mocked(pty.spawn).mockImplementation(() => {
    throw new Error("agy not installed");
  });
  await expect(runAgyModels()).resolves.toBe("");
});
