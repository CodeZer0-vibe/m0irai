import { expect, it } from "vitest";

import { executedCount } from "./verify-rust.mjs";

/**
 * Cargo's real output for the feature-less `--test host_lifecycle`, captured on
 * 2026-09-12 in `D:/m0irai-work-fl143/rust` at `9d2065e` before
 * `required-features` was added to that target:
 *
 *   cargo test --locked -p zer0-v2-bin --test host_lifecycle   ->   exit 0
 *
 * Kept verbatim, trailing spaces and all. A hand-written approximation of this
 * text is exactly the fixture that would keep passing while the real thing
 * drifted (READ-WHAT-IS: fixtures come from captured output, never from memory).
 */
const ZERO_TESTS = `   Compiling zer0-v2-bin v0.1.0 (D:\\m0irai-work-fl143\\rust\\crates\\zer0-v2-bin)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 42.71s
     Running tests\\host_lifecycle.rs (target\\debug\\deps\\host_lifecycle-4983eb160ee552ab.exe)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

/** The same target with `--features test-support`, captured in the same session. */
const TEN_TESTS = `     Running tests\\host_lifecycle.rs (target\\debug\\deps\\host_lifecycle-720b64c4b907734c.exe)

running 10 tests
test clients_do_not_own_the_child_but_owner_drop_reaps_it ... ok
test stdout_eof_is_a_transport_failure_but_monitor_retains_exit_seven ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 22.49s
`;

it("counts the tests a healthy step executed", () => {
  expect(executedCount(TEN_TESTS)).toEqual({ ok: true, count: 10 });
});

it("fails a step that compiled, exited 0 and ran nothing, quoting cargo's own line", () => {
  const result = executedCount(ZERO_TESTS);
  expect(result.ok).toBe(false);
  expect(result.quote).toBe(
    "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  );
});

it("fails on a zero hiding behind a healthy target in the same step", () => {
  const result = executedCount(`${TEN_TESTS}\n${ZERO_TESTS}`);
  expect(result.ok).toBe(false);
  expect(result.quote).toContain("0 passed");
});

it("fails when cargo printed no test run at all", () => {
  expect(
    executedCount("error: target `host_lifecycle` requires the features: `test-support`\n"),
  ).toEqual({ ok: false, quote: "no `running N tests` line in cargo's output" });
});

it("reports the singular `running 1 test` line cargo prints for one test", () => {
  expect(
    executedCount("running 1 test\ntest only ... ok\n\ntest result: ok. 1 passed; 0 failed;\n"),
  ).toEqual({ ok: true, count: 1 });
});
