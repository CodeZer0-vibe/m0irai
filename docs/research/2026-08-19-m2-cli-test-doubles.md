<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T7 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it.
     No code change before checkpoint 2. -->

# T7 — cli-test-doubles (FL-056; touches FL-053)

## 1. The problem as it exists in this repo

Every automated test of the digest's call to the codex program avoids actually asking the operating system to find and run codex. There are only two paths today: a full replacement with a canned string, or a swap of the launch function itself inside the test file. Neither ever exercises "find codex on this machine and start it."

`src/memory/digest-entry.ts:37-40` — when `ZER0_DIGEST_FAKE` is set (true for every hermetic/oracle proof), the function returns a canned string instead of calling `createCodexDispatch()` at all: `return fake !== undefined && fake.length > 0 ? async () => fake : createCodexDispatch();`

The real dispatch (`src/memory/digest-extractor.ts:164-208`) spawns `codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=low -` with the prompt on stdin, `cwd: tmpdir()`, `env: childEnv()` (lines 178-198). The one hermetic unit test that exercises this function, `digest-extractor.test.ts:179-204`, injects a fake `CodexExec` function in place of the real `execa()` call — so even it never asks the OS to resolve codex. The only test that does is `digest-extractor.live.test.ts:34-48`: it needs a real, authenticated codex install, is budgeted at 250 seconds, and runs once, serialized, outside the fast pool.

`docs/FINDINGS.md` (FL-056): "every digest proof bypasses the production dispatch through `ZER0_DIGEST_FAKE` (executable resolution, argv, env, prompt delivery unproven by the oracle) ... A hermetic fake `codex` executable = M2 candidate." FL-053 is the adjacent, distinct gap: the child's four positional arguments (session, repo, db, project) have no check binding them to one project — a recording test double would make a future regression test for that easier to write, but does not fix it.

## 2. Prior art

Every item below is primary source code of an actively-maintained, widely-deployed tool fetched and read directly (not commentary about it) — stronger than a practitioner essay, short of a formal measured study. All labeled verified.

**git's test suite** (git/git, `t/test-lib-functions.sh:628-634`): `write_script()` writes a shebang plus a body to a real file and chmod +x's it. Tests prepend a directory of these ahead of PATH so the git under test spawns a real, separate OS process standing in for ssh or an editor. A real executable, not an in-process swap.

**GitHub CLI's internal/run** (cli/cli, trunk, `internal/run/stub.go` + `run.go`): `PrepareCmd` is a package-level function variable wrapping every `exec.Cmd` (`run.go:24-26`); `Stub()` replaces it with a matcher its own comment calls "a catch-all for all external commands invoked from gh," which panics on an unmatched command and fails the test if a registered stub goes unused. Limit: it never spawns an OS process — it swaps `PrepareCmd` before the real command would run, so it proves argv shape (regex-matched) but nothing about PATH lookup or Windows extension resolution. Same category of seam as m0irai's existing `CodexExec` injection, same blind spot.

**npm's cmd-shim** (npm/cmd-shim, main, `lib/index.js`): the mechanism letting a Node script run as a bare command on Windows — it reads the target's shebang and writes a `.cmd` file that resolves the interpreter and calls it. Confirmed by execa's own docs (sindresorhus/execa, main, `docs/windows.md`): "executables have a file extension, such as `.exe`, `.cmd`, `.bat` or `.com`... Execa resolves [an extensionless command] using the `PATHEXT` [variable]... Runs `npm.cmd`." Execa 9.6.1 here delegates that resolution to cross-spawn 7.0.6, whose `resolveCommand.js` calls `which.sync` with a PATHEXT-aware fallback (`node_modules/cross-spawn/lib/util/resolveCommand.js`, read on disk). Neither `ZER0_DIGEST_FAKE` nor the injected `CodexExec` ever reaches this function — which is why a fake codex without a matching `.cmd` companion would be invisible on Windows even while sitting on PATH.

**Go's standard library** (golang/go, master, `src/os/exec/exec_test.go:150-158`): `helperCommandContext` runs the TEST BINARY ITSELF as the child process, re-invoked with a name a small dispatch table turns into scripted behavior (echo argv, echo env, hang, exit with a code). This goes through the real OS spawn/pipe/exit-code path — the category of fake that actually answers what FL-056 asks, unlike gh's in-process stub.

**execa's own docs** (verified-absent): the full docs directory (21 files) contains no testing/mocking guide. Execa ships no first-party test-double story; that seam is left to the caller.

No off-the-shelf npm package combines a PATH/PATHEXT-resolvable real executable with recording of argv/env/stdin (search in section 5). The recommendation below synthesizes the items above; it does not adopt one library.

## 3. Options for M2

**A — a real fake codex on PATH.** A small Node script (Unix: shebang + chmod +x) plus a Windows `.cmd` companion built the way cmd-shim builds one, checked into a test-fixtures folder. It writes its received argv, filtered env, and stdin to a file the test reads back, then prints canned JSON. The test prepends the fixture folder to PATH and calls the real, uninjected `createCodexDispatch()`. Dependency cost: zero at runtime, optionally a dev-only dependency on cmd-shim to generate the `.cmd` instead of hand-maintaining one. Windows behaviour: the only option that actually exercises `which.sync`/PATHEXT. Test strategy: fast, no network/auth, fits the hermetic pool. Blast radius: new fixture files only.

**B — same fake, invoked by absolute path**, skipping PATH/PATHEXT lookup entirely. Cheaper to build, no per-OS shim needed, but leaves the FL-056 gap half-open: proves argv/env/stdin marshaling and output parsing, not that codex resolves.

**C — formalize the existing CodexExec injection**, gh-CLI style (pattern-matched stub, fail-on-unmatched). Better test ergonomics and coverage accounting, zero new dependency — but structurally identical to what exists today; does not touch PATH resolution and would not close FL-056.

**D — golden-file replay**: layer a one-time hand-captured real-codex response on top of A or B instead of a synthetic canned string. Closer to real output shape, at the cost of a staleness risk (the recording can silently rot if codex's output format changes) needing a dated re-capture step.

## 4. Recommendation

Option A, informed by D: build the fixture-directory fake codex (with its `.cmd` companion) and route the hermetic test through the real `createCodexDispatch()` with PATH overridden to the fixture folder, recording argv/env/stdin for assertion against the contract already documented in `digest-extractor.ts:178-198` (the sandbox/skip-git-repo-check/reasoning-effort flags, the trailing `-`, stdin delivery). Falsifier: before trusting the new test, break it on purpose — remove or misname the `.cmd` companion on a Windows run and confirm the test fails with a not-found-class error, mirroring what a broken real install would look like — then restore it and confirm it passes. A test that cannot be made to fail this way is not proving what FL-056 asks for.

## 5. What could not be verified

- No canonical npm package for "fake PATH-resolvable executable + argv/env/stdin recorder": `curl -sL "https://registry.npmjs.org/-/v1/search?text=fake+executable+PATH+test+cli+bin&size=10"` returned is-ci, npm-run-path, which-command, @electron/rebuild, @vercel/cli-exec, resolve-bin, npm-which, babel-cli, grunt-cli, executable — none match. Labeled "not found by this search," not "does not exist."
- Whether xai-org/grok-build (D:\grok-ref) has its own precedent — out of scope for T7's named prior-art list, not searched.
- Python's pytest-subprocess plausibly supports stdin recording, but a grep of its fetched README for stdin/record/argv/register terms returned no output — dropped rather than guessed, and it is a different language ecosystem than this repo.

## 6. Sources

https://raw.githubusercontent.com/git/git/master/t/test-lib-functions.sh · https://raw.githubusercontent.com/cli/cli/trunk/internal/run/stub.go · https://raw.githubusercontent.com/cli/cli/trunk/internal/run/run.go · https://raw.githubusercontent.com/npm/cmd-shim/main/lib/index.js · https://raw.githubusercontent.com/sindresorhus/execa/main/docs/windows.md · https://api.github.com/repos/sindresorhus/execa/contents/docs · https://raw.githubusercontent.com/golang/go/master/src/os/exec/exec_test.go · https://registry.npmjs.org/-/v1/search?text=fake+executable+PATH+test+cli+bin · https://raw.githubusercontent.com/aklajnert/pytest-subprocess/master/README.md (fetched, claim not found) · In-repo: src/memory/digest-extractor.ts, src/memory/digest-entry.ts, src/memory/digest-extractor.test.ts, src/memory/digest-extractor.live.test.ts, src/shared/child-env.ts, docs/FINDINGS.md, node_modules/execa (package.json, readme), node_modules/cross-spawn/lib/util/resolveCommand.js
