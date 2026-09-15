/**
 * @file src/adapters/pty/agy-version.ts
 * @purpose Live agy version probe for the carrier binding (hygiene H3). The binding previously pinned
 *   a CONSTANT floor, so an agy upgrade never fired F-2 lane invalidation — live-hit 2026-07-10: the
 *   floor said 1.0.8 while the installed agy answered 1.1.1. Probes `agy --version` ONCE per process
 *   (success AND failure both cached — no per-turn 5s stalls on a broken binary; a heal is picked up
 *   by the next process) and validates the semver shape (the real output is a bare "1.1.1" line).
 * @exports probeAgyVersion, resetAgyVersionCache
 * @depends execa, ../../shared/child-env, ./agy-pty-spawn, ../../shared/hermetic
 */
import { execa } from "execa";
import { childEnv } from "../../shared/child-env.js";
import { assertNotHermetic } from "../../shared/hermetic.js";
import { createLogger } from "../../shared/logger.js";
import { agyExePath } from "./agy-pty-spawn.js";

const logger = createLogger();
const PROBE_TIMEOUT_MS = 5_000;
// Verified live 2026-07-10: `agy --version` prints a bare semver line ("1.1.1"). Anchored prefix —
// a suffix (build tag) is tolerated, but the match itself must start with major.minor.patch.
const SEMVER_PREFIX = /^(\d+\.\d+\.\d+)/;

type ProbeRunner = () => Promise<string>;

let cached: { readonly version: string | undefined } | undefined;

async function runRealProbe(): Promise<string> {
  assertNotHermetic("agy-version.runRealProbe");
  const result = await execa(agyExePath(), ["--version"], {
    env: childEnv(),
    extendEnv: false,
    reject: false,
    shell: false,
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`agy --version exited ${String(result.exitCode)}`);
  }
  return result.stdout;
}

/**
 * The installed agy version, probed once per process. Returns undefined when agy is absent, the spawn
 * fails, or the output is not semver-shaped — callers fall back to their documented floor (and the
 * failure is warned ONCE here, not per turn).
 */
export async function probeAgyVersion(
  run: ProbeRunner = runRealProbe,
): Promise<string | undefined> {
  if (cached !== undefined) {
    return cached.version;
  }
  try {
    const raw = (await run()).trim();
    const match = SEMVER_PREFIX.exec(raw);
    if (match?.[1] === undefined) {
      logger.warn({ phase: "agy-version" }, "agy --version output not semver-shaped", {
        raw: raw.slice(0, 80),
      });
      cached = { version: undefined };
      return undefined;
    }
    cached = { version: match[1] };
    return match[1];
  } catch (error) {
    logger.warn({ phase: "agy-version" }, "agy version probe failed; using the documented floor", {
      reason: error instanceof Error ? error.message : String(error),
    });
    cached = { version: undefined };
    return undefined;
  }
}

/** Test seam: clears the process cache so each test drives its own probe outcome. */
export function resetAgyVersionCache(): void {
  cached = undefined;
}
