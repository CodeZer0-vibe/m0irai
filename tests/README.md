# <!--

# tests/README.md — read by knights when dispatched to write tests

-->

# tests/ — vitest test files

<status>
unit tests are colocated as `src/foo/bar.ts` + `src/foo/bar.test.ts`. this `tests/` directory is for cross-module integration tests + the phase 1 end-to-end test.
</status>

---

## TOP-OF-MIND RULES

1. **UNTESTED CODE = UNFINISHED CODE.** audit §6: "~510 lines of completely untested command code" was a documented failure mode.
2. **HIT REAL DEPENDENCIES IN E2E TESTS.** mock-only suites prove the mocks work, not the features.
3. **EVERY ACCEPTANCE CRITERION GETS A TEST.** if a spec criterion has no test, it's a coverage gap.

---

<phase_1_mandatory_tests source="docs/SPEC.md §17 success criteria">

these are the gating tests for phase 1 done. all must exist + pass.

| test file                           | criterion                                                                | spec ref     |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `tests/e2e-health-endpoint.test.ts` | full pipeline on hardcoded "/health endpoint returns `{status:ok}`" task | criterion #1 |
| `tests/gate-bypass-blocked.test.ts` | unit: attempt to advance workflow without evidence → blocked             | criterion #2 |
| `tests/p0-blocks-workflow.test.ts`  | integration: inject P0 finding → workflow halts                          | criterion #3 |
| `tests/crash-recovery.test.ts`      | kill mid-build → resume works                                            | criterion #4 |
| `tests/all-three-clis.test.ts`      | each cli (claude/codex/gemini) dispatches and returns                    | criterion #5 |
| `tests/secrets-never-leak.test.ts`  | `.env` content NEVER appears in any blob                                 | criterion #8 |

</phase_1_mandatory_tests>

---

<test_writing_constraints>

- **vitest, not jest.** no `jest.fn()`, no `jest.mock()`. use `vi.fn()`, `vi.mock()`.
- **colocate unit tests.** `src/evidence/blob-store.ts` → `src/evidence/blob-store.test.ts`.
- **tests in this directory** are integration + e2e only.
- **no console.log in tests.** use vitest's `expect()` assertions for everything.
- **deterministic.** no `Date.now()` without mocking. no random without seeding. flaky tests are P0.

</test_writing_constraints>

---

<banned_patterns enforcement="grep on test files">

```
TODO            FIXME            XXX
"placeholder"   "skeleton"       "mock implementation"
.skip(          .only(           xit(             xdescribe(
expect(true).toBe(true)          // empty test theater
```

if a test is `.skip()`'d, it's not a test. either delete it or fix it.

</banned_patterns>

---

## BEFORE COMMITTING ANY TEST — VERIFY

1. does the test ACTUALLY assert behavior (not just that the code ran)?
2. is the test deterministic (no clock, no random, no network without mock)?
3. for e2e tests: are real dependencies (sqlite, temporal dev server, cli subprocess) used — not mocks?
4. does the test name describe behavior, not implementation? ("blocks on P0 finding" not "calls evaluateReviewGate twice")
5. is the test colocated correctly (unit → next to source, integration → here)?
