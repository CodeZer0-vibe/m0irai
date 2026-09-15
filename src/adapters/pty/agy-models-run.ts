/**
 * @file src/adapters/pty/agy-models-run.ts
 * @purpose The REAL ConPTY runner of `agy models` (it needs a console — prints nothing without one) for the
 *   native /model picker. Spawns agy under a ConPTY, captures stdout, resolves the raw text on agy's exit (or
 *   a quiet/hard timeout so the picker fetch never hangs). Bounded + fail-soft (spawn failure → ""). Kept
 *   apart from the parser (agy-models) so the parser + its test never load node-pty.
 * @exports runAgyModels
 * @depends node:process, node-pty, ./agy-pty-spawn
 */
import process from "node:process";
import * as pty from "node-pty";
import { agyChildEnv, agyExePath } from "./agy-pty-spawn.js";

const COLS = 100;
const ROWS = 40;
const IDLE_MS = 2500; // resolve once output has been quiet this long (the spinner keeps it alive while fetching)
const HARD_CAP_MS = 30_000; // never let the picker fetch hang
const MAX_BYTES = 1_000_000; // bound the captured buffer (the braille spinner redraws a lot)

/**
 * Runs `agy models` under a ConPTY and resolves its raw stdout. Resolves on agy's exit (the common path), or
 * after an idle/hard timeout. Fail-soft: a spawn failure resolves "" so the picker shows "no models".
 *
 * @returns the raw captured stdout of `agy models` (parsed by agy-models.parseAgyModels)
 */
export function runAgyModels(): Promise<string> {
  return new Promise<string>((resolve) => {
    let term: pty.IPty;
    try {
      term = pty.spawn(agyExePath(), ["models"], {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: process.cwd(),
        env: agyChildEnv(),
      });
    } catch {
      resolve("");
      return;
    }
    let buf = "";
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      clearTimeout(hardTimer);
      try {
        term.kill();
      } catch {
        /* already exited */
      }
      resolve(buf);
    };
    const hardTimer = setTimeout(finish, HARD_CAP_MS);
    term.onData((data) => {
      if (buf.length < MAX_BYTES) {
        buf += data.slice(0, MAX_BYTES - buf.length); // hard cap even on a single oversized chunk
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(finish, IDLE_MS);
    });
    term.onExit(() => finish());
  });
}
