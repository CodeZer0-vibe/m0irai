/**
 * @file tests/setup/worker-store-root.ts
 * @purpose W4-R3a C1/RA-4: owns the lifecycle of the throwaway per-RUN store root that vitest.setup.ts
 *   points HOME/USERPROFILE/ZER0_DB_PATH at. Keyed by the MAIN vitest process's pid, not a fixed name:
 *   three builders can run suites in three checkouts at once on this machine and they share one tmpdir,
 *   so a fixed parent would let one run's teardown delete another's live worker dirs. Runs as
 *   globalSetup (before the fork pool), so the exported root reaches every worker by env inheritance —
 *   the same mechanism tests/setup/codex-home-global.ts uses for CODEX_HOME.
 * @exports SUITE_STORE_ROOT_ENV, workerStoreRoot, workerLocalAppData, default (vitest globalSetup)
 * @depends node:fs, node:os, node:path, node:process
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export const SUITE_STORE_ROOT_ENV: string = "ZER0_SUITE_STORE_ROOT";

const RM_RETRIES: number = 5;
const RM_RETRY_DELAY_MS: number = 300;

/**
 * The calling worker's own store dir, created on demand. Keyed by pid: setupFiles re-run for EVERY test
 * file, so a fresh mkdtemp per call would orphan one directory per test file (547 per run here); a fork
 * worker is one process, so its pid is stable across the files it runs and distinct across the pool.
 *
 * The `AppData/Local` subtree is created with it, and it is not decoration. This root becomes USERPROFILE
 * for every worker, and a Windows profile with no `AppData\\Local` in it makes
 * `[Environment]::GetFolderPath('LocalApplicationData')` return the EMPTY STRING — measured on this box
 * 2026-09-12, `[]` against `[C:\\Users\\...\\AppData\\Local]` from the same shell with the real profile.
 * Anything the suite spawns that resolves a per-user cache from that folder then gets a RELATIVE path and
 * writes it under its own cwd, which is the repo root: a `powershell -NoProfile` living 25 s created
 * `Microsoft/Windows/PowerShell/ModuleAnalysisCache` in a directory that was empty before, and that is
 * what left `?? Microsoft/` in a lane worktree for the ship gate's clean-tree check to fail on. With the
 * subtree present the same command resolved the real folder and wrote the cache inside the profile.
 */
export function workerStoreRoot(): string {
  const parent =
    process.env[SUITE_STORE_ROOT_ENV] ?? path.join(tmpdir(), "zer0-suite-store-orphan");
  const root = path.join(parent, String(process.pid));
  mkdirSync(workerLocalAppData(root), { recursive: true });
  return root;
}

/** The `AppData/Local` inside a worker's store root — what LOCALAPPDATA must point at. */
export function workerLocalAppData(root: string): string {
  return path.join(root, "AppData", "Local");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = path.join(tmpdir(), `zer0-suite-store-${String(process.pid)}`);
  mkdirSync(root, { recursive: true });
  process.env[SUITE_STORE_ROOT_ENV] = root;
  return async () => {
    await removeWithRetry(root);
  };
}

// Windows holds handles briefly after a worker process tree dies (the same reason codex-home-global.ts
// retries). A leftover temp dir is noise, never a failure — the guard that matters asserts the REAL
// store is untouched, and that runs independently of this cleanup.
async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < RM_RETRIES; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RM_RETRY_DELAY_MS));
    }
  }
  process.stderr.write(`[worker-store-root] leftover suite store not removed: ${dir}\n`);
}
