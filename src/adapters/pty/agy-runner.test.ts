/**
 * @file src/adapters/pty/agy-runner.test.ts
 * @purpose RED-first falsifiers for runAgyOnce (the ConPTY one-shot transport for agy): F1 collects
 *   stdout across chunks then resolves on clean exit · F2 a never-exiting child is killed + rejects
 *   typed at the turn cap (124) · F3 abort kills + rejects typed (130) · F4 conpty-teardown
 *   (non-clean exit + stdout present) recovers as success · F5 non-zero exit with empty stdout
 *   rejects · F6 a timeout is never masked as success even with partial stdout. Fake pty + fake
 *   timers; this module imports no node-pty.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agy-runner
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type PtyLike, type SpawnAgy, runAgyOnce } from "./agy-runner.js";

class FakePty implements PtyLike {
  public readonly pid = 4242;
  public killed = false;
  private dataCb: ((d: string) => void) | undefined;
  private exitCb: ((e: { exitCode: number }) => void) | undefined;
  public write(): void {}
  public kill(): void {
    this.killed = true;
  }
  public onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  public onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  public emit(d: string): void {
    this.dataCb?.(d);
  }
  public exit(code: number): void {
    this.exitCb?.({ exitCode: code });
  }
}

let fake: FakePty;
const spawn: SpawnAgy = () => {
  fake = new FakePty();
  return fake;
};
const base = (
  signal: AbortSignal,
): {
  cmd: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  spawn: SpawnAgy;
} => ({
  cmd: "agy.exe",
  args: ["--print", "x"],
  cwd: "C:/w",
  signal,
  timeoutMs: 1000,
  spawn,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("F1: collects stdout across chunks and resolves on clean exit 0", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  fake.emit("Hel");
  fake.emit("lo");
  fake.exit(0);
  await expect(p).resolves.toMatchObject({ stdout: "Hello", exitCode: 0 });
});

it("F2: a child that never exits is killed and rejects typed at the cap (124)", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  const assertion = expect(p).rejects.toMatchObject({ name: "DispatchError", exitCode: 124 });
  await vi.advanceTimersByTimeAsync(1001);
  await assertion;
  expect(fake.killed).toBe(true); // FALSIFYING: an unbounded runner hangs here
});

it("F3: abort kills the child and rejects typed (130)", async () => {
  const ac = new AbortController();
  const p = runAgyOnce(base(ac.signal));
  const assertion = expect(p).rejects.toMatchObject({ name: "DispatchError", exitCode: 130 });
  ac.abort();
  await assertion;
  expect(fake.killed).toBe(true);
});

it("F4: a non-zero exit rejects EVEN with stdout — an agy error is never masked as success (F3)", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  fake.emit("ERROR: auth failed");
  fake.exit(1); // FALSIFYING: a runner that recovers any stdout hands this error back as a clean reply
  await expect(p).rejects.toMatchObject({ name: "DispatchError", exitCode: 1 });
});

it("F4b: a synchronous spawn failure rejects as a typed DispatchError (not a raw throw)", async () => {
  const boomSpawn: SpawnAgy = () => {
    throw new Error("ConPTY boom");
  };
  await expect(
    runAgyOnce({
      cmd: "agy.exe",
      args: [],
      cwd: "C:/w",
      signal: new AbortController().signal,
      timeoutMs: 1000,
      spawn: boomSpawn,
    }),
  ).rejects.toMatchObject({ name: "DispatchError" });
});

it("normalizes terminal controls out of user-visible failure diagnostics", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  fake.emit("\x1b]0;agy title\x07\x1b[31mAvailable model\x1b[0m\r\n");
  fake.exit(1);
  const error = await p.catch((cause: unknown) => cause);
  expect(error).toMatchObject({ name: "DispatchError", exitCode: 1 });
  expect((error as Error).message).toContain("Available model");
  expect((error as Error).message).not.toContain("\x1b");
  expect((error as Error).message).not.toContain("agy title");
});

it("F5: non-zero exit with empty stdout rejects typed", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  fake.exit(1);
  await expect(p).rejects.toMatchObject({ name: "DispatchError" });
});

it("F6: a timeout is never masked as success even with partial stdout", async () => {
  const p = runAgyOnce(base(new AbortController().signal));
  fake.emit("partial"); // FALSIFYING: a runner that resolves on stdout-at-cap returns success here
  const assertion = expect(p).rejects.toMatchObject({ name: "DispatchError", exitCode: 124 });
  await vi.advanceTimersByTimeAsync(1001);
  await assertion;
});
