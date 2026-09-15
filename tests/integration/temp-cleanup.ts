/**
 * @file tests/integration/temp-cleanup.ts
 * @purpose Windows-safe temp-dir removal for the Temporal integration tests. The embedded Temporal
 *   dev-server (TestWorkflowEnvironment) keeps `temporal.db` open; even after stopTemporalServer() awaits
 *   the child's teardown, Windows can take a few ms to release the file handle, so a bare rmSync races
 *   EBUSY/EPERM. CONTRACT: call this AFTER stopTemporalServer() — it retries the removal with backoff so a
 *   transient handle-release lag does not fail the test, while a genuine persistent lock still surfaces.
 * @exports rmDirWithRetry
 * @depends node:fs, node:timers/promises
 */
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Backoff schedule (ms) for the post-teardown handle-release lag. The final attempt (after the loop)
// runs unguarded so a real, persistent lock throws rather than being silently swallowed.
const RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 800];

/**
 * Removes `dir` recursively, retrying on the Windows post-process-exit handle-release race (EBUSY/EPERM/
 * ENOTEMPTY). Any other error throws immediately. Must be called AFTER the owning Temporal server is
 * stopped — this only tolerates the brief OS lag, not a still-running server holding the db.
 */
export async function rmDirWithRetry(dir: string): Promise<void> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      rmSync(dir, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }
      await sleep(delay);
    }
  }
  rmSync(dir, { force: true, recursive: true }); // final attempt — surface a persistent lock
}
