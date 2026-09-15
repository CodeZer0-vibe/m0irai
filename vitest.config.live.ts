import { defineConfig } from "vitest/config";
import { LIVE_TEST_FILES } from "./vitest.live-files.js";

// The REAL-BINARY pool (hygiene wave H1): these suites drive live agent CLIs (real codex app-server /
// real claude turns — 60-250s each). In the 4-fork unit pool they nondeterministically starve under
// temporal-compile CPU contention (chain-5 live-hit 2026-07-10: adapter-codex "expected [] to include
// 'allow.txt'" under load, green standalone 88s — the filed load-flake class). They run HERE,
// serialized, with the same CODEX_HOME isolation; the list's single home is vitest.live-files.ts
// (vitest.config.ts excludes the SAME import — exactly-once by construction, sol NIT).
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/setup/codex-home-global.ts"],
    include: [...LIVE_TEST_FILES],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
    silent: false,
    reporters: ["default"],
  },
});
