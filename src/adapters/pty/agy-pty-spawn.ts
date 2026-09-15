/**
 * @file src/adapters/pty/agy-pty-spawn.ts
 * @purpose The REAL node-pty ConPTY spawn for agy + its exe-path resolver + the child env whitelist.
 *   agy WEDGES without a console (proven 2026-06-15), so it must run under a ConPTY. Subscription-only
 *   env (no provider API keys, INV-4). Kept apart from agy-runner so unit tests of the run loop never
 *   load node-pty.
 * @exports agyExePath, agyChildEnv, spawnAgyPty
 * @depends node:fs, node:path, node-pty, ./agy-runner, ../../shared/hermetic
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as pty from "node-pty";
import { childEnv } from "../../shared/child-env.js";
import { assertNotHermetic } from "../../shared/hermetic.js";
import type { PtyLike, SpawnAgy } from "./agy-runner.js";

/** Resolves the installed agy.exe (Antigravity CLI), or throws if it is not installed. */
export function agyExePath(): string {
  // Provider acquisition for gemini starts here (before any spawn) — the hermetic seam refuses first.
  assertNotHermetic("agy-pty-spawn.agyExePath");
  const local = process.env.LOCALAPPDATA;
  if (local === undefined || local === "") {
    throw new Error("agy-pty-spawn: LOCALAPPDATA unset; cannot locate agy.exe");
  }
  const exe = join(local, "agy", "bin", "agy.exe");
  if (!existsSync(exe)) {
    throw new Error(`agy-pty-spawn: agy.exe not found at "${exe}" (Antigravity CLI not installed)`);
  }
  return exe;
}

/** Subscription-first (INV-4): the SHARED allowlist (shared/child-env.ts) — kept as the public agy seam. */
export function agyChildEnv(): Record<string, string> {
  return childEnv();
}

/** Real ConPTY spawn of `agy <args>` in `cwd` (the seam injected into runAgyOnce in production). */
export const spawnAgyPty: SpawnAgy = (cmd, args, cwd): PtyLike => {
  assertNotHermetic("agy-pty-spawn.spawnAgyPty");
  const term = pty.spawn(cmd, [...args], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: agyChildEnv(),
  });
  return {
    pid: term.pid,
    write: (data) => term.write(data),
    kill: () => term.kill(),
    onData: (cb) => {
      term.onData(cb);
    },
    onExit: (cb) => {
      term.onExit((event) => cb({ exitCode: event.exitCode }));
    },
  };
};
