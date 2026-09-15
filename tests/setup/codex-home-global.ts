/**
 * @file tests/setup/codex-home-global.ts
 * @purpose vitest globalSetup: point CODEX_HOME at an ISOLATED throwaway home for the whole run, so
 *   live codex spawns (the live suites in vitest.live-files.ts and any integration cell that spawns codex)
 *   write their per-cwd project-trust entries into the throwaway instead of the operator's real
 *   ~/.codex/config.toml — the measured bloat class (12→22 entries in one day of sweeps, 2026-07-10;
 *   the June incident reached 877). Runs ONCE in the vitest main process BEFORE the fork pool spawns,
 *   so the env reaches every worker by fork inheritance and every spawned CLI via childEnv's
 *   CODEX_HOME passthrough. auth.json + config.toml are COPIED in (subscription auth + model pins
 *   preserved); sessions/skills are not (tests own their session state). An ALREADY-SET CODEX_HOME
 *   wins (outer harness / operator override — pointing it at the real home is then an explicit
 *   choice). Teardown removes the throwaway (EBUSY retry) and WARNS LOUDLY if the real config.toml
 *   changed during the run — the recurrence tripwire for any writer this isolation misses.
 * @exports default (vitest globalSetup)
 * @depends node:fs, node:os, node:path
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const COPIED_FILES: readonly string[] = ["auth.json", "config.toml"];
const RM_RETRIES = 5;
const RM_RETRY_DELAY_MS = 300;

interface ConfigSnapshot {
  readonly size: number;
  readonly mtimeMs: number;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.CODEX_HOME !== undefined && process.env.CODEX_HOME !== "") {
    return async () => undefined; // explicit outer override wins; nothing to tear down
  }
  const realHome = join(homedir(), ".codex");
  const realConfig = join(realHome, "config.toml");
  const before = snapshot(realConfig);
  const isolated = mkdtempSync(join(tmpdir(), "zer0-codex-home-"));
  for (const file of COPIED_FILES) {
    const source = join(realHome, file);
    if (existsSync(source)) copyFileSync(source, join(isolated, file));
  }
  process.env.CODEX_HOME = isolated;
  return async () => {
    await removeWithRetry(isolated);
    const after = snapshot(realConfig);
    if (before !== undefined && after !== undefined && !sameSnapshot(before, after)) {
      // Not a test failure (teardown cannot fail the run) — a loud recurrence alarm: some codex
      // spawn escaped the isolated home and wrote the operator's REAL config during this run.
      process.stderr.write(
        `\n[codex-home-global] WARNING: ${realConfig} CHANGED during the test run (size ${String(before.size)}→${String(after.size)}). A codex spawn escaped CODEX_HOME isolation — find it before trust entries bloat again.\n`,
      );
    }
  };
}

function snapshot(path: string): ConfigSnapshot | undefined {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined; // no real config (fresh machine / CI) — nothing to tripwire
  }
}

function sameSnapshot(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// Windows holds child cwd/file locks briefly after a process tree dies; retry like the live tests do.
async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < RM_RETRIES; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RM_RETRY_DELAY_MS));
    }
  }
  process.stderr.write(`[codex-home-global] leftover isolated home not removed: ${dir}\n`);
}
