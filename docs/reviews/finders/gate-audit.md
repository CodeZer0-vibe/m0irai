# Finder report — lens: gate-audit

Reviewed: `D:\Zer0 Chat V2\.council\review-copy\standalone-v2-spec.md` (SPEC v2, Standalone V2).
Evidence tree: `D:\Zer0 Chat V2\sources\zer0-agent-ci` @ `106d5ea` on `codex/v2-room-layer`,
working tree clean (`git status --porcelain` empty). Everything marked CONFIRMED was executed
against that tree, or against a scratch tree built to match the spec's own §3 module map.

Headline: the spec's central proof step (S3b — "prove the file set, then filter") runs
`npm run gates`, and I can demonstrate that command fails on the tree the spec describes, for a
reason the spec never mentions. Separately, five of the gates that `npm run gates` runs report
PASS when they collect nothing at all — which is the exact state an extraction that deletes most
of the tree produces.

---

## FINDINGS

### 1. `standalone-v2-spec.md:166,194` vs `package.json:41` — the spec's root file set makes `npm run gates` crash · important · CONFIRMED

`npm run gates` runs `node scripts/gate-agent-files.mjs` (package.json:41). That gate calls
`generateAgentFiles({check:true})`, which renders THREE root files — `CLAUDE.md`, `AGENTS.md`,
`GEMINI.md` — from `docs/agents/core.md` + `docs/agents/appendix.{claude,codex,gemini}.md`, then
compares each byte-for-byte (`scripts/generate-agent-files.mjs:14-19,43-59`).

The spec's §3 module map (lines 166-167) lists at the root: `README.md · LICENSE · NOTICE ·
AGENTS.md · docs/{STATE.md, specs/, decisions/, MODULE-MAP.md, reviews/, plans/, provenance/}`.
No `CLAUDE.md`, no `GEMINI.md`, no `docs/agents/`. §3b (line 194) then says
"`AGENTS.md` (≤100 lines) carried and **rewritten**" — i.e. hand-authored.

All three readings fail. Trigger: run `npm run gates` in the tree §3 describes.

```
--- branch 1: module map as written (AGENTS.md hand-written, no docs/agents/, no CLAUDE/GEMINI) ---
Error: ENOENT: no such file or directory, open '...\newrepo\docs\agents\core.md'
    at readText (generate-agent-files.mjs:69:15)
EXIT=1

--- branch 2: docs/agents/ carried, AGENTS.md rewritten, no CLAUDE.md/GEMINI.md ---
Error: ENOENT: no such file or directory, open '...\newrepo\CLAUDE.md'
    at generateAgentFiles (generate-agent-files.mjs:53:28)
EXIT=1

--- branch 3a: CLAUDE.md + GEMINI.md + AGENTS.md + docs/agents/ all carried VERBATIM ---
GATE PASS: agent standing files match generated sources
EXIT=0

--- branch 3b: same, but AGENTS.md rewritten per §3b ---
GATE FAIL: generated agent files drifted: AGENTS.md
EXIT=1
```

The only configuration that passes is the one the spec rules out: carry `CLAUDE.md`, `GEMINI.md`,
`AGENTS.md` AND `docs/agents/*` unchanged. The gate passes on the baseline tree today
(`node scripts/gate-agent-files.mjs` → exit 0), so this is created by the extraction, not inherited.
Secondary inconsistency: §3 line 182 retains `gate-agent-files.mjs` and `generate-agent-files.mjs`
in `scripts/`, but P3 (line 92) omits both from its enumeration of what `npm run gates` runs — so
either the gate runs (and this crash bites) or it does not (and two retained scripts are dead files
that knip's `files: "error"` rule flags).

### 2. `standalone-v2-spec.md:99,183,242` — the allow-list gate, P4's only enforcement mechanism, is never wired into anything · important · CONFIRMED (grep)

P4 (lines 99-100): "Checked by a committed root allow-list + reject-list **and a gate that fails on
any tracked path outside the allow-list**." Line 183 places `allow-list.mjs (S3)` in `scripts/`.

I searched every occurrence of the enrollment language. The only slice that adds anything to the
gate chain is S7 (line 242): "G-E docs-truth + G-F reachability + banned-patterns test into
`npm run gates`." The allow-list gate is not in that list, not in P3's list (line 92), and no other
slice mentions enrolling it. It is written in S3 and then never runs.

Second problem, same finding: the gate is defined over TRACKED paths, and S3b (line 238) builds the
candidate as "`D:\<name>-candidate` (no git)". Nothing is tracked there, so the mechanism is
structurally inoperable in the one slice that claims to prove P4 ("P1, P3, P4 (as a tree), P10 on
the candidate"). P4 can first be enforced at S4 at the earliest, and as specified, never.

Third: the allow-list is generated once (S3) and never re-derived. S6 and S7 add files. Nothing
re-runs `allow-list.mjs` and compares against the committed list — the "ran the generator, forgot
to commit the output" class, applied to the file that defines what the repository is allowed to be.

### 3. `standalone-v2-spec.md:207` — "enrolled in `npm run gates` and CI" has no CI half · important · CONFIRMED

§4 line 207: "Project oracle — `scripts/oracle-standalone.mjs`, enrolled in `npm run gates` and CI
(not a one-time manual run)". Grep of the whole spec for `.github|workflow|CI\b|required check|
branch protection|merge queue` returns exactly one `.github` hit — S3 (line 237) listing
`.github/ workflows` as an INPUT to the allow-list closure. No slice edits a workflow, and §3's
module map (lines 165-188) contains no `.github/` entry at all.

That matters because the existing CI does NOT call `npm run gates`. `.github/workflows/gates.yml:
45-69` enumerates seven steps by hand: typecheck, biome, gate-clamps, dep-check, knip, `npm test`,
and (Linux only) `npm run test:integration`. Absent from CI today: `gate-l5-mandates`,
`gate-patches`, `gate-encoding`, `gate-no-claude-p`, `gate-scripts-scope`, `gate-agent-files`,
`npm run test:live`. Adding a step to the `gates` npm script therefore does not put it in CI. As
specified, the new repo's oracle, G-E, G-F, the banned-patterns test and the allow-list gate are
all green-looking and non-blocking in CI forever.

There is also no terminal fan-in job: `gates.yml:26-30` is a 2-leg matrix with `fail-fast: false`
and one conditionally-skipped step (`if: runner.os == 'Linux'`, line 68). Required-status-check
names are per-leg strings; renaming the job (the repo is being renamed) silently detaches them.

### 4. Five gates in the chain report PASS when they collect nothing · important · CONFIRMED

Run in a completely empty directory:

```
$ cd <empty dir>
$ node .../gate-clamps.mjs        -> GATE PASS: 0 files checked, 0 lines, no violations    exit 0
$ node .../gate-l5-mandates.mjs   -> (no output at all)                                    exit 0
$ node .../gate-scripts-scope.mjs -> GATE scripts-scope: PASS                              exit 0
$ node .../gate-encoding.mjs      -> GATE PASS: 0 files checked, no mojibake markers found exit 0
```

knip is the same, and knip is the gate G-F leans on ("knip entry = host", line 149):

```
$ npx knip --directory <dir with knip.config.js entry=src/room/zer0-v2-host.ts, no source files>
Configuration hints (2)
[src/room/zer0-v2-host.ts!]  knip.config.js  Refine entry pattern (no matches)
[src/**/*.ts!]               knip.config.js  Refine project pattern (no matches)
knip_exit=0
```

A missing entry pattern is a HINT, not an error. Inside `gate-l5-mandates.mjs` the same shape
recurs per sub-gate: `gateActivityRegistration` returns `true` when the barrel is missing
(lines 247-249) and `gateSchemaDiscipline` returns `true` when `src/evidence/schema.sql` is missing
(lines 419-422). `listSrcFiles` swallows a failed `readdir` and returns `[]` (lines 78-81), and the
files-checked counter is `_filesChecked` — assigned, never printed.

This is the defining risk of an allow-list extraction: each of these gates goes quiet exactly when
a path is dropped or moved, and quiet reads as green. No slice states a floor — minimum file count,
minimum test count, minimum package count — for any gate. S3b's "prove" step and P3's "Gates green"
are both satisfiable by a tree that lost half its inputs.

### 5. `standalone-v2-spec.md:211-212` — the oracle's write/read step asserts no value, and may not be implementable without an agent · important · READ

Step 3 of §4: "…→ one write and one read through the RPC surface → `zer0/room/shutdown` → exit 0
within the deadline. Assert the schema-version row-set = `{14}`."

Nothing says the read must return what the write wrote. As written, a host that accepts a write,
drops it, and answers the read with an empty page satisfies every clause. The only value assertions
in the entire oracle are the schema-version row set and (Rust half, step 6) `--version` printing the
version crate's string. The product's actual invariant — an operator message lands in the ledger and
comes back — is never checked, so the oracle certifies "running" while the room silently persists
nothing. That is the failure the digest work (S6) sits directly on top of.

Second half: the spec also says "The oracle spawns no agent." The RPC surface is `initialize`,
`session/list`, `session/new`, `session/load`, `zer0/room/{catalog,submit,control,models,resync,
shutdown}` (`src/room/zer0-v2-host.ts:243-252,334-371`). The only general-purpose write is
`zer0/room/submit`, which calls `host.submit(...)` and dispatches lanes to the three agents
(lines 336-341). So "one write and one read" either spawns agents (contradicting §4) or degenerates
into `session/new` + `session/list`, which step 3 already counts separately. The step needs naming
in ops and in asserted values before it means anything.

Related: the falsification pair (step 5) exercises exactly one of the oracle's ~6 assertions —
delete `schema.sql`, DB open fails. The write/read assertion, the shutdown assertion, the deadline
and the `{14}` row set have no falsifier, while §2.4's G-H row claims "the oracle could be fooled"
is guarded by that single falsifier.

### 6. `standalone-v2-spec.md` §5 — no test-file baseline, no floor, and one assertion edited inside a config list · important · CONFIRMED (counts)

The tree has 624 test files today:
```
$ find src tests scripts -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" -o -name "*.test.mjs" | wc -l
624
```
The spec's retention rule is "sibling `*.test.ts` for every retained production file + their
transitive test-only imports" (line 179). Of the 181 closure files, 164 have a sibling test and 17
do not. So the extraction deletes on the order of 400+ test files by design — and the plan records
no before/after inventory, no minimum, and no rule that a deleted or skipped test needs an on-record
justification. After S3b, `npm test` green is a statement about a different suite, and nothing
distinguishes "deleted because its source is gone" from "deleted because it was red".

Baseline for whoever does that diff: 14 `it.skip`/`test.skip`/`.todo`/`skipIf` occurrences exist
today across 7 files (`src/tower/controller-real-adapter.test.ts`,
`tests/e2e/ghost-composer-conpty.test.ts`, and five under `tests/integration/`).

Concrete instance of an assertion edit hidden in a config line — S3b (line 238) lists
"sidecar-test expectation" among fifteen comma-separated config edits. That is
`scripts/package-zer0-v2-sidecar.test.mjs:76-80`:
```js
  expect(stagedPatches).toEqual([
    "patches/@agentclientprotocol+claude-agent-acp+0.63.0.patch",
    "patches/@agentclientprotocol+sdk+1.3.0.patch",
    "patches/ink+5.2.1.patch",
  ]);
```
Changing a `toEqual` on the packaging contract is the kind of edit the plan's own process rule
(line 229 — red quoted first, same test green after) exists for, and it is the one edit that rule is
not applied to. The new expected value is never stated in the spec.

### 7. `standalone-v2-spec.md:179-180,186` — retained tests that no runner will execute · important · CONFIRMED

`vitest.config.ts:45` excludes `...LIVE_TEST_FILES` from the default pool; `vitest.config.ts:30`
excludes `tests/integration/**`. Live output from a real run in the repo:
```
exclude: **/node_modules/**, **/dist/**, ..., tests/integration/**,
  src/chat/diff-review-e2e*.integration.test.ts, tests/e2e/loop/**,
  src/tower/adapter-codex.test.ts, ..., src/chat/structural-diff.live.test.ts,
  src/memory/digest-extractor.live.test.ts, tests/e2e/ghost-composer-conpty.test.ts
```
`src/memory/digest-extractor.live.test.ts` is a sibling of `src/memory/digest-extractor.ts`, which
IS in the closure — so the spec's sibling rule retains it. Its only runner is
`vitest.config.live.ts`, which is NOT in the §3 module map (line 186 lists `vitest.config.ts ·
vitest.live-files.ts` — no live config, no integration config). Same for `tests/integration/**`,
which line 180 retains ("integration/e2e tests that reach only retained code") with no
`vitest.config.integration.ts`. P3 (line 92) also drops `test:live` and `test:integration` from the
gate list, though `package.json:41` runs both today.

Result: retained test files excluded from the only suite that runs, with nothing reporting it.
S3b's edit is described only as "live-files rows", and the row that must go for the RIGHT reason
(`src/chat/structural-diff.live.test.ts`, whose production file is not in the closure) is not a
"tower/tui row" — so the edit as described (line 186, "tower/tui rows out") is incomplete.

### 8. `standalone-v2-spec.md:234,258` — the "two red `room-host.test.ts` cases" do not reproduce · important · CONFIRMED

S0's postcondition is built around them and the risk register (line 258) contemplates a `/fix` wave
for them. On the exact pinned input (branch `codex/v2-room-layer`, HEAD `106d5ea`,
`git status --porcelain` empty):

```
$ npx vitest run src/room/room-host.test.ts
 ✓ src/room/room-host.test.ts (10 tests) 15789ms
 Test Files  1 passed (1)      Tests  10 passed (10)

$ npx vitest run room-host          # all ten room-host* files
 Test Files  10 passed (10)    Tests  34 passed (34)
```

Caveat, stated precisely: I ran these files in isolation, not inside the full 4-fork suite. This
repo has a documented load-flake class (`vitest.config.live.ts:4-9`: "nondeterministically starve
under temporal-compile CPU contention … green standalone 88s — the filed load-flake class"). If
that is what the two reds were, the plan is recording a flake as a fixed property of the baseline,
which is worse than recording a bug: S0 "explains" them, the operator learns that two reds are
normal, and P1/P3 (`npm run gates` exit 0) quietly become unreachable-but-excused. Either way the S0
row has to be re-derived by running it, not carried forward.

### 9. `standalone-v2-spec.md:204-206` — the ship gate fails OPEN for the new repo, permanently · important · READ

§4: "**Harness generator: UNSUPPORTED** … `.zer0/oracle/UNSUPPORTED` recorded on day one. **No push
of the new repo before S1 lands.**"

From the operator's own gate, `C:\Users\mianc\.claude\hooks\ship-gate.sh:138-139`:
```
# --- no enrolled oracle => ungated repo. Deliberate, VISIBLE fail-open (/ship warns). ---
[ -f "$manifest" ] || allow "no oracle enrolled for this repo ($key) — push allowed. ..."
```
and `C:\Users\mianc\.claude\skills\ship\SKILL.md:20`: "**UNSUPPORTED** → stated as 'type
unsupported', proceed ungated with that on the record."

The gate runs the enrolled `verify_path` (default `.zer0/oracle/verify.sh`, ship-gate.sh:142). The
spec builds a genuinely runnable project oracle — `scripts/oracle-standalone.mjs` — and enrolls it
in `npm run gates`, but no slice enrolls it in the trust store, so the push gate never runs it. S4
and S8 both push/clone from GitHub. The compensating control ("no push before S1") is a sentence in
a document; the mechanism behind it is an explicit fail-open. The operator's stated invariant — a
`git push` is blocked unless the verify oracle proves the app runs — would not be in force for the
one repo the operator will be told is the clean one.

### 10. `standalone-v2-spec.md:152-153` — two of the seven declared guards are assigned to no slice · important · CONFIRMED (grep)

Grepping the spec for each guard id: `G-D` → §2.4 + S3b + S6; `G-H` → §2.4 + S3b; `G-E`/`G-F` →
§2.4 + P3 + S7 + risk register; **`G-G`** (mutation sweep on every moved file — the declared guard
for the `vi.doMock` string-path class) → line 152 only; **`G-B`** (MT3d TOCTOU reuse +
shutdown-during-dispose) → line 153 only, although S6 separately mentions reusing MT3d.

Ordering defect in the same family: P3 (line 92) states `npm run gates` includes G-E and G-F, but
S7 (line 242) is the slice that puts them there — and S3b (line 238), the slice that proves the
candidate, runs `npm run gates` several slices earlier. The gate set that certifies the tree is
strictly weaker than the gate set the contract describes, and nothing re-runs the S3b proof after
S7 strengthens the chain.

### 11. `standalone-v2-spec.md:180` — `tests/setup/` is absent from the module map, and one of those files is the real-store contamination guard · important · READ

Line 180 describes `tests/` as "integration/e2e tests that reach only retained code;
tests/fixtures/". `vitest.config.ts:13-17` names three globalSetup files:
`tests/setup/codex-home-global.ts`, `tests/setup/worker-store-root.ts`,
`tests/setup/real-store-guard.ts` (plus `real-store-fingerprint.ts`, which the last imports).

`tests/setup/real-store-guard.ts:4-11` records why it exists:
> "at base commit c1cbdb1 one `npm test` inserted 109 rows into the operator's dogfood
> `.zer0/evidence.db`, which had accumulated 14,434 junk `chat_sessions` rows this way — every one
> from a test whose OWN db was correctly isolated, defeated by product code that re-derived the DB
> target from ambient cwd-relative config"

S6 adds a detached child process that writes to a DB path resolved at runtime — the same defect
class this guard was built to detect — and I2 puts the proof's own state under `D:\<name>\.zer0\`,
the store this guard fingerprints. If the file is carried, it is carried by accident (reachable only
through a config array the S3 closure would have to walk); if it is dropped, the suite silently
regains the ability to write into the operator's real evidence DB. Related: its escape hatch is an
environment variable (`ZER0_ALLOW_REAL_STORE_WRITES=1`, line 23) in a project whose own decision 3
says every `ZER0_*` switch is shell-inherited today.

### 12. `standalone-v2-spec.md:241` vs `closure-181-repo.txt` — S6 edits a file that is not in the allow-list · important · CONFIRMED

S6(b)-(c): "`digest-runner.ts` spawns `process.execPath` on it, keeping `digestSpawnArgs`' contract
… it fires `spawnDetachedDigest(DigestRequest)`; `bootCatchUp` runs after `initialize`".

Those four symbols all live in one file:
```
$ grep -c "digest-runner" .council/v2-map/phase2/closure-181-repo.txt
0
$ grep -rn "spawnDetachedDigest|digestSpawnArgs|bootCatchUp" src --include="*.ts" | grep -v test
src/memory/digest-runner.ts:41:  export function spawnDetachedDigest(
src/memory/digest-runner.ts:95:  export function digestSpawnArgs(request: DigestRequest): DigestSpawnPlan {
src/memory/digest-runner.ts:138: export async function bootCatchUp(
```
`src/memory/digest-runner.ts` is not in the 181-file closure (nothing retained imports it — it is
precisely the "built and buried" class F the spec names) and it is not among §3's additions, which
list only `src/memory/digest-entry.ts`. So S6 has no file to edit, or the file arrives outside the
S3 allow-list — the state P4's gate is supposed to fail on.

### 13. `standalone-v2-spec.md:183,189` — the entire new gate surface lands in the one directory nothing checks · important · CONFIRMED

The five new files are `scripts/{release,oracle-standalone,allow-list,docs-truth,reachability}.mjs`
(line 189). That directory is outside every existing quality mechanism:

- **tsc**: `tsconfig.json:40` include is `["src/**/*", "tests/**/*"]`. Confirmed empirically —
  `npx tsc --noEmit --listFiles | grep -c "zer0-agent-ci/scripts/"` → **0**.
  (`gate-scripts-scope.mjs:2` says so in its own header: "the tsc-BLIND entry-point folder
  `scripts/`".)
- **gate-clamps**: `INCLUDE_DIRS = ["src", "tests"]` (line 9) and `walk()` collects only `.ts`/`.tsx`
  (line 92). The 500/600-line ceiling, the 50-line function cap, the 5-parameter cap, the slop-token
  scan and the file-header contract do not apply to any of the new scripts. §3 line 190 cites "the
  repo's enforced gate (gate-clamps: 500 soft / 600 hard, functions 50)" as the ceiling for the
  result; it does not reach the new code.
- **gate-l5 G1** (sibling-test coverage — the one mechanism that stops "keep the source, drop the
  test") scans `src/` only (`SRC_DIR = "src"`, line 34).
- Of the existing `scripts/*.mjs`, only six have tests at all (`gate-encoding`, `gate-patches`,
  `patch-lifecycle`, `copy-evidence-schema`, `adr-index-build`, `package-zer0-v2-sidecar`);
  `gate-clamps`, `gate-l5-mandates`, `gate-no-claude-p`, `gate-scripts-scope` and `gate-agent-files`
  have none — and S3b edits two of those untested gates ("`gate-l5` barrel constant ·
  `gate-no-claude-p` per decision 6").

The oracle, the allow-list gate and the two new drift gates are the most load-bearing new code in
the project, and by placement they are unclamped, untypechecked and untested.

### 14. `standalone-v2-spec.md:148-153` — only one of the new guards has a falsifier · important · READ

The oracle gets an explicit falsification pair (§4 step 5, run and quoted before enrollment).
G-E (docs-truth), G-F (reachability), the allow-list gate and the banned-patterns test get none — no
"green here, red there" pair, no planted-violation run. Given finding 4 (every collector gate in
this repo passes at zero inputs) and that G-E/G-F are brand-new scripts scanning paths this very
change is moving, a silent no-op is the most likely first state for both. S7's row does say "planted
orphan/wrong-path each fail their guard" for the release smoke — that treatment is exactly what the
other three need and do not have.

---

## NITS

- **`scripts/gate-encoding.mjs:9-16`** · CONFIRMED — the non-git fallback (`walkedShippedFiles`,
  used whenever `git ls-files` fails, e.g. in S3b's deliberately git-free candidate) scans only
  `src/`, `docs/`, `scripts/` plus five hardcoded root names — `AGENTS.md, CLAUDE.md, GEMINI.md,
  README.md, ROUND_TABLE.md`. In the new repo three of those five will not exist, and `tests/`,
  `protocol/`, `rust/` and `patches/` are never encoding-checked at all. Observed degradation in a
  non-git dir: `fatal: not a git repository ... GATE PASS: 0 files checked`.
- **`.github/workflows/gates.yml:22`** · READ — job name is `6-gate sweep` while the file runs seven
  gates. G-E's declared scope (README, AGENTS.md, STATE.md, the spec) would not catch it.
- **`scripts/gate-l5-mandates.mjs:424-431`** · READ — G7 pins `src/evidence/schema.sql` line 9 to
  the exact string `INSERT OR IGNORE INTO _schema_version(version) VALUES (5);`. S4 adds
  licence/NOTICE work across the repo; any header inserted into `schema.sql` shifts line 9 and turns
  G7 red. Loud rather than silent, but a foreseeable collision the plan does not mention.
- **`standalone-v2-spec.md:98-99`** · READ — P4's numeric postconditions have uneven mechanisms.
  "`patches/` holds 2" is enforced (`patch-contracts.mjs:112-131` checks set equality in both
  directions between `package.json` `zer0Patches` and `patches/*.patch`). "`package.json` declares
  12 dependencies" and "`rust/` = the 19 local packages" have no stated gate: the allow-list gate
  checks paths, not counts, and G-E checks documents, not the manifest.
- **`standalone-v2-spec.md:242`** · READ — `scripts/release.mjs` is specified as "one idempotent
  command" that stages into a directory beside the Rust exe. Idempotent staging means deleting prior
  output; the spec states no name guard or refusal rule for that target. The existing packager has
  one by construction — it only ever removes `<arg>/zer0-v2-node`
  (`package-zer0-v2-sidecar.mjs:44-45`) — and that property is worth stating for the new script
  rather than inheriting by luck. I1's cwd refusal is the only destructive guard the spec names.
- **`standalone-v2-spec.md:243`** · READ — S8 is the evidence source for the native-module
  prerequisite matrix that S7 writes into the README, but its clean-machine leg is "and, if
  available, a clean Windows VM". The operator's own machine has the toolchain and a warm npm cache
  — precisely the environment that hides a missing `better-sqlite3` prebuild. An optional clean-room
  step cannot be the source of a prerequisite claim.

## PREEXISTING

- **`scripts/gate-scripts-scope.mjs:33-38`** — the gate's entire rule set is one retired token
  (`chatMode`). P3 lists it among the gates proving the extraction; for V2 it is close to a no-op.
- **`scripts/gate-no-claude-p.mjs:20-23`** — `QUARANTINE` exempts `src/adapters/claude.ts`, which IS
  in the retained closure, so the billing-guard scan keeps a permanent blind spot in V2. Decision 6
  correctly identifies that the `src/chat/agent-bins.ts` tripwire (lines 43-47) must go; it does not
  mention that the tower quarantine pattern (line 22) will then point at a path that no longer
  exists.

---

## CHECKS THAT CAME BACK CLEAN

- **Baseline is genuinely green.** `npx tsc --noEmit` → exit 0. All six mechanical gates on the real
  tree → exit 0 each (`gate-l5-mandates`, `gate-clamps`, `gate-encoding`, `gate-no-claude-p`,
  `gate-scripts-scope`, `gate-agent-files`). Working tree clean at `106d5ea`.
- **vitest has a real floor.** `npx vitest run "src/room/room-host-*.test.ts"` (a glob vitest treats
  as a substring filter, matching nothing) → `No test files found, exiting with code 1`.
  `passWithNoTests` is not set anywhere, so an empty collection fails — unlike the five gates in
  finding 4.
- **gate-l5 G1 will hold on the extracted tree.** All 17 closure files without a sibling test match
  G1's exemption list (`types.ts` x4, `event-schemas.ts` via `-schemas?.ts`, `pty-binding`,
  `pty-binding-reader`, `pty-session-errors`, `pty-session-registry`, `pty-transcripts`,
  `turn-usage`, and the seven `src/shared/types/*`). The two non-exempt observability files the spec
  retains, `inspect.ts` and `with-meta.ts`, both have sibling tests today.
- **The three-file drop is import-coherent.** `lessons-reader` is imported only by
  `temporal/activities/memory-compiler.ts:14`; `memory-compiler` only by `chat/prompt-builder.ts:27`
  and `temporal/activities/prepare-context.ts:29` (both out of the retained set); and the retained
  importers of `prompt-builder.js` are exactly four `estimateTokens` call sites —
  `chat/commands.ts:11`, `chat/evidence-strict.ts:19`, `chat/evidence.ts:17`,
  `chat/headless-turn.ts:38`. Matches §1's claim exactly.
- **The spec's `prompt-budgeter` citation is accurate.** `src/chat/prompt-budgeter.ts:33` is
  `export function estimatePromptTokens(text: string): number`.
- **No `vi.doMock` string paths target the three moved seams.** Grep of every `*.test.ts` under
  `src` for `doMock|vi.mock` intersected with `render-escape|status-mode-language|tower/types` →
  zero hits. The G-G exposure for the specific S1/S2/S3 seams looks empty (G-G still has no slice —
  finding 10).
- **Lockfile staleness is covered.** `cargo metadata/test/build --locked` appears in S0, S3b and S8,
  and `npm ci` fails on a `package.json`/`package-lock.json` mismatch, so "regenerated the lock,
  forgot to commit it" is closed for both halves.
- **Patch-set drift is covered in both directions.** `patch-contracts.mjs:124-130` fails on a
  registered-but-missing patch and on an unregistered file in `patches/`; version drift is caught by
  filename-vs-installed comparison (`patchVersionMismatches`). That is a real mechanism behind I4.
- **Merge-result execution.** `gates.yml:14-18` triggers on `pull_request` to main. I did not verify
  GitHub's checkout semantics against vendor documentation in this session, so I make no claim
  either way — and since the new repo has no workflow in the module map (finding 3), the axis is
  undefined there rather than wrong.

---

### Method note

Executed: five gate scripts in an empty scratch tree; three reconstructions of the spec's root
layout against `gate-agent-files.mjs`; `npx knip` against two synthetic configs; `npx tsc --noEmit`
and `--listFiles`; `npx vitest run` on `room-host.test.ts` and on the ten-file `room-host` family;
file and `skip` counts across `src`, `tests`, `scripts`. Nothing under `D:\Zer0 Chat V2` was
modified — every scratch tree was built under the session scratchpad, and no
`git checkout/restore/stash/clean/reset` was run anywhere.
