import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Same CODEX_HOME isolation as the unit config — the live e2e cells spawn real codex too.
    globalSetup: ["./tests/setup/codex-home-global.ts"],
    // W11: diff-review-e2e is co-located with its module (src/chat/), not under tests/integration/ —
    // a SCOPED prefix glob (diff-review-e2e*), not the 5 PRE-EXISTING src/**/*.integration.test.ts
    // files' own broader pattern (those stay covered by vitest.config.ts's own
    // src/**/*.{test,spec}.{ts,tsx} include, unaffected — this prefix never matches their names). The
    // E2E's own scale required splitting into companion files (diff-review-e2e-*.integration.test.ts,
    // gate-clamps.mjs's 600-line hard ceiling — one scenario per file, same fixture-per-file
    // convention every file in this family already uses), so a prefix glob (not one literal per file)
    // means adding a new leg file never requires touching this config again. Excluded from
    // vitest.config.ts's own run — see that file's own comment — so each runs exactly once, here:
    // serialized (fileParallelism:false) with this pool's 60s budget, not the main pool's
    // 30s/4-way-parallel one, given the real multi-leg git/sqlite scope.
    include: ["tests/integration/**/*.test.ts", "src/chat/diff-review-e2e*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    silent: false,
    reporters: ["default"],
  },
});
