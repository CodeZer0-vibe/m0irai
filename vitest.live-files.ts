// THE single source of truth for the REAL-BINARY test suites (hygiene H1; sol NIT closed the
// hand-mirroring: two lists drift — a file added to one but not the other runs twice or zero times).
// vitest.config.live.ts INCLUDES this list; vitest.config.ts EXCLUDES it. Exactly-once by construction.
export const LIVE_TEST_FILES: readonly string[] = [
  // W4-R3a C1 (audit F13): the MT3g live-codex digest call — real binary, 250s budget. It was the last
  // real-CLI spawn still sitting in the 30s/4-fork unit pool; see that file's own header.
  "src/memory/digest-extractor.live.test.ts",
  // Any future real-binary suite registers here for the same reason: a real app boot plus its settle
  // windows blows the unit pool's 30s budget — and registering here is also what EXCLUDES it from
  // that pool, so a file merely dropped under tests/e2e/ does not run twice.
];
