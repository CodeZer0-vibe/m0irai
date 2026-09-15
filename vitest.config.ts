import { defineConfig } from "vitest/config";
import { LIVE_TEST_FILES } from "./vitest.live-files.js";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Each runs ONCE in the main process before the fork pool, so the env each sets reaches every
    // worker by fork inheritance. SETUP runs in this order; TEARDOWN runs in the REVERSE of it, one after
    // another — vitest 3.2.4, node_modules/vitest/dist/chunks/cli-api.BkDphVBG.js:7090:
    //   for (const globalSetupFile of [...this._globalSetups].reverse()) await globalSetupFile.teardown?.()
    // which is why fixture-orphan-guard is registered FIRST and not last (round-4 item 3; round 3 put it
    // last under a comment claiming the opposite, so its teardown ran BEFORE the others and a throw in it
    // skipped the real-store fingerprint check and the worker-profile cleanup outright).
    //
    // Setup order still holds everything it has to. codex-home stays effectively FIRST and untouched,
    // because fixture-orphan-guard's setup does nothing at all — it only returns a teardown — so the
    // first file that ACTS is still codex-home (W4-R3a's per-worker HOME redirect deliberately does not
    // touch CODEX_HOME, which that file owns). worker-store-root still publishes its root before
    // vitest.setup.ts (a setupFile, per worker) reads it, and real-store-guard is still the last of the
    // three to set up, so its "before" fingerprint is still taken with the isolation already in place.
    globalSetup: [
      "./tests/setup/fixture-orphan-guard.ts",
      "./tests/setup/codex-home-global.ts",
      "./tests/setup/worker-store-root.ts",
      "./tests/setup/real-store-guard.ts",
    ],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "tests/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.mjs",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.zer0/**",
      "**/.agent-ci/**",
      "**/.council/**",
      "**/coverage/**",
      "tests/integration/**",
      // W11: registered ONLY in vitest.config.integration.ts's own include (serialized, 60s budget —
      // see that file's own comment) — excluded here so it never double-runs in this 30s/4-way-parallel
      // pool too. A scoped prefix glob, matching that file's own — the 5 pre-existing
      // src/**/*.integration.test.ts files stay exactly where they already run (this pool, unaffected;
      // none of their names start with diff-review-e2e).
      "src/chat/diff-review-e2e*.integration.test.ts",
      // The REAL-BINARY suites run serialized in vitest.config.live.ts (H1: live agent turns starve
      // nondeterministically in this 4-fork pool under temporal-compile contention). The list's
      // single home is vitest.live-files.ts — same import both sides, exactly-once by construction.
      ...LIVE_TEST_FILES,
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    silent: false,
    reporters: ["default"],
    // Several temporal tests each boot a Temporal dev server and run a ~1.5MB
    // webpack workflow-bundle compile (25s+ of CPU each). With vitest's default
    // ~(cores-1) threads, many of these stampede the 12-core host at once,
    // oversubscribing CPU so even trivial file-op tests starve past their 30s
    // wall-clock budget and time out nondeterministically. Cap the pool so heavy
    // compiles never oversubscribe; fast tests then complete within budget.
    // Keep the default fork pool: several CLI tests call process.chdir(), which
    // throws in worker threads but is supported in forked child processes.
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
