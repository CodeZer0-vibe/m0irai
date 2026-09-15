# JUDGE — consolidated verdict on SPEC v2 "Standalone V2"

**Judged:** `D:\Zer0 Chat V2\.council\review-copy\standalone-v2-spec.md` (blind copy) against
`D:\Zer0 Chat V2\sources\zer0-agent-ci\docs\specs\2026-08-16-standalone-v2-spec.md` (record copy, +§7).
**Inputs:** 5 Claude finder reports (`docs-truth`, `reachability`, `gate-audit`, `test-integrity`, `plan-logic`) + 1 codex sol-ultra blind report.
**Trees measured:** `sources/zer0-agent-ci` @ `106d5ea775d4eaa2e617fcc0207a213e0798e824` (`codex/v2-room-layer`, `git status --porcelain` = 0 lines) · `sources/grok-build-b13-candidate` · workspace root `D:\Zer0 Chat V2`.
**Judge's own commands:** every adjudication in §1 was executed by me in this session, read-only; scratch files under the session scratchpad only. No `checkout/restore/stash/clean/reset` anywhere.

Reviewer shorthand: **DT** docs-truth · **RE** reachability · **GA** gate-audit · **TI** test-integrity · **PL** plan-logic · **CX** codex-blind.

---

## 1. ADJUDICATIONS — contested facts, settled by measurement

### A1 · Protocol corpus file count — **39**, not 38. CX is wrong.

```
$ cd "D:/Zer0 Chat V2" && find protocol -type f | wc -l
39
$ git ls-files protocol | wc -l
39
$ find protocol -type f | sed 's|/[^/]*$||' | sort | uniq -c
      1 protocol
     38 protocol/conformance/v1
```
CX #17 reports `{"PhysicalFileCount":38,"GitTrackedCount":38}` — that is the count of `protocol/conformance/v1/**` and omits `protocol/zer0-room-v1.schema.json` at the top level. The spec's sentence is *"The `protocol/` conformance corpus … 39 files"*, and P10 imports `protocol/`, so 39 is the count the spec means and the count that must travel. **CX #17 first half: FALSE.** The residual defect is real and small: the spec never says which glob "39" counts, so a future G-E can disagree with a reviewer forever. v3 must state the glob beside the number.

### A2 · `_schema_version` after a real `session/new` — **{14,15,16,20}**, and `journal_entries` DOES exist.

I opened each mode on a fresh temp DB, then reproduced the room's own two-step sequence on one file:

```
$ node --import tsx probe-schema.mts       (openers imported from src/evidence/db.ts)
openDb (global)          _schema_version = {14}           journal_entries=false  tables=54
openMemoryDb (memory)    _schema_version = {14,15}        journal_entries=true   tables=56
openLaneStateDb (lane)   _schema_version = {14,15,16,20}  journal_entries=true   tables=60
ROOM step 1 openDb        _schema_version = {14}           journal_entries=false
ROOM step 2 openLaneState _schema_version = {14,15,16,20}  journal_entries=true   tables=60
```

The chain that makes step 2 unavoidable, read at the line:
`src/room/room-host.ts:117 openDb` → `:127 initializeRoomSession` → `src/room/room-host-support.ts:35 initCarrierRuntime(…)` → `src/chat/lane-transport.ts:127 db: openLaneStateDb(config.dbPath)`.

**A fact no reviewer stated, and it decides the mitigation:** `room-host-support.ts:35` calls `initCarrierRuntime` **unconditionally**. The Ink boot gates the identical call (`src/cli/commands/chat-tui-boot.ts:53 — if (!carrierEnabled() || …) return {}`); the room does not. So `ZER0_MEMORY=0` does **not** hold the row-set at `{14}` — it only stops eager agent warm-up (`src/room/room-eager-sessions.ts:28`). CX #5's suggested mitigation is half right for the wrong assertion.

Scoreboard: **RE R4 correct** (drove the real host, observed both opens and read back `[14,15,16,20]`). **CX #1 correct** (read, via `migrations-v16.test.ts`). **DT F3, TI F5, PL F21 wrong** — each stopped at `openDb`/`openMemoryDb` and concluded `{14}` or `{14,15}`. Their shared conclusion *"P6 (a journal row per close) is impossible on the database the room opens"* is **FALSE**: the room's DB has `journal_entries` from `session/new` onward. What survives from those three reports is the narrower true thing: **I5 (`terminal key {14}` survives) and §4 step 3 are both false as written.**

### A3 · The "two red `room-host.test.ts` cases" — **do not exist.**

```
$ cd "D:/Zer0 Chat V2/sources/zer0-agent-ci" && npx vitest run src/room/room-host.test.ts
 ✓ src/room/room-host.test.ts (10 tests) 9997ms
   ✓ falsifier: operator grants, hop grants, canonical provenance, and the one-hop ceiling stay exact 1283ms
   … (10 named cases, all ✓)
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  14.75s
```
Third independent green run on the pinned baseline (DT F2 10/10, GA #8 10/10 and 34/34 across the ten `room-host*` files, mine 10/10). The spec asserts two reds in S0 **and** escalates them in §5b into a possible `/fix` wave. Both statements are unsourced and contradicted. GA's caveat is the right one to carry: if they were ever real they were a load-flake, and the plan would be recording a flake as a fixed baseline property.

### A4 · `estimateTokens` wrapper location — spec citation is **correct but ambiguous**; CX overstates.

```
$ grep -n "export function estimateTokens" src/chat/prompt-builder.ts       →  83:
$ grep -n "export function estimatePromptTokens" src/chat/prompt-budgeter.ts →  33:
src/chat/prompt-builder.ts:83-85   export function estimateTokens(text: string): number { return estimatePromptTokens(text); }
```
The spec writes *"`estimateTokens`, a one-line wrapper around `estimatePromptTokens` (`src/chat/prompt-budgeter.ts:33`, in closure)"*. The citation is attached to the **wrapped** function and resolves exactly. The **wrapper** is at `prompt-builder.ts:83-85` and is uncited. **CX #17 second half: OVERSTATED** — not a wrong fact, an under-cited one. v3 cites both sides of the wrap.

### A5 · Tracked `.zer0/` files — **exactly 1.** Spec correct.

```
$ git ls-files .zer0
.zer0/workflows/adversarial-locked-override.md
$ git ls-files .zer0 | wc -l
1
```
The negation structure that produces it is `.gitignore:16-21` (`.zer0/*` + four `!` re-includes). §3's four-pattern replacement drops that structure — that is DT F8/PL F12's real point, and it stands.

### A6 · The Rust "19 packages and no other crate" — **direct extras 20, transitive local closure 80 of 83.** All four reviewers were measuring different things; none stated the number that decides the work.

```
$ cd sources/grok-build-b13-candidate && cargo metadata --no-deps --offline --format-version 1 > grokmeta.json ; echo exit=$?
exit=0
$ node closure.mjs        (path-dep closure from the spec's 19 seeds, over cargo's own dependency records)
workspace-local packages total: 83
seeds found: 19  missing: []
closure over NORMAL path deps (incl. optional-but-disabled): 75
closure over NORMAL+BUILD: 76
closure over NORMAL+BUILD+DEV: 80
```
The 20 **direct** edges that leave the 19:
```
zer0-v2-bin        --[dev]--> ptyctl
xai-grok-pager     --[normal,optional]--> xai-acp-lib, xai-crash-handler, xai-fast-worktree, xai-file-utils,
                                          xai-grok-agent, xai-grok-announcements, xai-grok-plugin-marketplace,
                                          xai-grok-sandbox, xai-grok-shell, xai-grok-telemetry, xai-grok-tools,
                                          xai-grok-update, xai-grok-voice, xai-grok-workspace,
                                          xai-hooks-plugins-types, xai-token-estimation          (16)
xai-grok-pager     --[dev]--> xai-grok-pager-pty-harness, xai-grok-test-support (+agent,+shell already listed)
xai-grok-pager-render --[normal,optional]--> xai-grok-shared, xai-grok-telemetry, xai-grok-workspace
```
One of them — `xai-grok-shell` — pulls 30 more transitively, which is how 19 becomes 80.

And the failure mode, reproduced from scratch (workspace member with **one optional, feature-OFF** path dep whose directory is absent):
```
$ cargo metadata --offline --format-version 1   → exit=101  "failed to load manifest for dependency `ghostdep`"
$ cargo metadata --no-deps --offline            → exit=101  (same)
$ cargo build --offline                         → exit=101  (same)
```
**This corrects RE R6**, which reported `--no-deps` succeeding. It does not: an absent path-dep directory is fatal to *every* cargo invocation in the workspace, `--no-deps` included. PL F4's "20 further local packages" is the correct **direct** count; RE R6's "30" and DT F5's "78 from `cargo tree`" are each a different slice of the same graph.

**The operative form of this fact:** the enabling edit is **24 dependency declarations across 3 manifests**. Until they are gone, all 80 crate directories must exist on disk. After they are gone, the other 64 can be deleted. There is no ordering in which "delete unused crates" comes first.

### A7 · `session/new` requires a git repository **that is its own toplevel**.

`src/memory/project-scope.ts:149-166` (read at the line): `rev-parse --show-toplevel` null → `{kind:"unscopable", reason:"… is not inside a git work tree or does not exist"}`; and a second guard — *"G2 OWN-TOPLEVEL GUARD … refuse a toplevel that is not `cwd`'s own"* → `unscopable` when the temp dir sits under an unrelated ancestor repo. `src/room/room-host.ts:121-123` then throws `room host requires an exclusive scoped project liveness lock`. PL F20 executed the probe and got `unscopable`; CX #2 found the matching precedent — the Rust lifecycle test runs `git init -q` (`crates/zer0-v2-bin/tests/host_lifecycle.rs:356-368`). Both correct; the **own-toplevel** half is PL's alone and matters, because a temp dir created under any repo still fails after `git init` is forgotten.

### A8 · Two more measurements the merged list rests on.

```
$ node distscan.mjs dist          (the 3 regexes at scripts/package-zer0-v2-sidecar.mjs:124-130)
scanned JS files: 182
would FAIL assertProductionJavaScript: 30
  dist/src/adapters/acp/acp-permission.js:25  * … permission-ask.ts's operator …
$ node -e "console.log(require('./package.json').scripts.gates)"
npm run typecheck && npx biome check . && node scripts/gate-agent-files.mjs && node scripts/gate-clamps.mjs
 && node scripts/gate-encoding.mjs && node scripts/gate-no-claude-p.mjs && node scripts/gate-patches.mjs
 && node scripts/gate-scripts-scope.mjs && node scripts/gate-l5-mandates.mjs && npm run dep-check
 && npm run dead-code && npm test && npm run test:live && npm run test:integration
$ node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).length, Object.keys(p.devDependencies).length, JSON.stringify(p.bin))"
21 12 {"zer0":"./bin/zer0.mjs"}
```
And the shape of the tree Approach B operates on:
```
tracked files (Node repo):                 1872
tracked files under src/{tui,temporal,loop,cli,tower}:  481
production .ts/.tsx under src (non-test):   509      closure: 181      → 328 outside the closure
test files (src+tests):                     625
closure-181 files living inside the doomed dirs:  4
closure-181 files IMPORTING into the doomed dirs: 7   (8 import lines)
```
The 8 seam lines, exactly:
```
src/chat/headless-turn.ts:29        import { escapeUntrusted } from "../tower/render-escape.js";
src/chat/permission-ask.ts:19       import { escapeUntrusted } from "../tower/render-escape.js";
src/room/room-engine-primitives.ts:8  import { escapeUntrusted } from "../tower/render-escape.js";
src/room/room-host-support.ts:20    import { escapeUntrusted } from "../tower/render-escape.js";
src/room/room-mode.ts:30            import { escapeUntrusted } from "../tower/render-escape.js";
src/room/room-mode.ts:31            import { type ModeWord, modeWord } from "../tui/status-mode-language.js";
src/chat/tower-bridge-lane.ts:12    import type { AdapterEvent, NativeAgentAdapter } from "../tower/types.js";
src/chat/prompt-builder.ts:27       import { compileMemory } from "../temporal/activities/memory-compiler.js";   (file itself dropped)
```

---

## 2. MERGED FINDINGS

Sorted by severity, then by how many independent reviewers found it. Every duplicate collapsed into one block. `APPLIES-UNDER-B` judges the operator's copy-and-delete approach, not the spec's allow-list build.

---

### P0 — the folder would not build/run, or the operator could not detect it broken

**J1 · The oracle's `_schema_version = {14}` assertion, and invariant I5, are false against a correct room.**
Reviewers: RE (correct), CX (correct); DT, TI, PL raised the same family with wrong values — **5 of 6 touched it**.
Evidence: CONFIRMED-BY-EXECUTION (§A2 — mine and RE's, independently).
Category: spec-fact-wrong / oracle-or-gate.
APPLIES-UNDER-B: **yes** — the row-set is a property of the product, not of the build method.
v3 must: assert the row-set a real `session/new` actually produces and say which opener produced it, rather than asserting the narrow `openDb` value as the room's.

**J2 · The oracle's positive path cannot run: its "fresh temp project root" is not a git repo that is its own toplevel, so `session/new` throws before any assertion.**
Reviewers: PL, CX — **2**. Evidence: CONFIRMED-BY-EXECUTION (PL's `resolveProjectId` probe; §A7 source chain).
Category: plan-sequence / oracle-or-gate.
APPLIES-UNDER-B: **yes** — and the wider fact is worse: `git` is an undeclared **runtime** prerequisite of the product, not just of the oracle (`xai-grok-pager/build.rs:7` also shells to git at build time), while decision 8 names only Node.
v3 must: make the oracle construct its project root the way the product requires, and add git to the stated prerequisite matrix beside Node.

**J3 · "rust/ = the 19 local packages and no other crate" cannot coexist with any cargo command until 24 path-dep declarations in 3 manifests are removed.**
Reviewers: PL, RE, DT, CX — **4** (with three different numbers; see §A6).
Evidence: CONFIRMED-BY-EXECUTION (§A6: closure 80/83; missing dir → exit 101 on `metadata`, `metadata --no-deps` and `build`).
Category: spec-fact-wrong / allow-list-miss.
APPLIES-UNDER-B: **yes, and it is B's single largest mechanical step** — deleting any grok crate directory before the manifest edit breaks the whole workspace. It breaks loudly, which is the good news.
v3 must: state that the 19 is a *post-pruning* property, name the pruning of the optional and dev path-dependencies as the enabling step, and order it before any deletion or copy.

**J4 · The oracle asserts no value: "one write and one read through the RPC surface" names no method and compares nothing, so a canned stub passes every clause.**
Reviewers: TI (built the passing stub argument), GA, PL, CX — **4**. Evidence: READ, converging (`src/room/zer0-v2-host.ts:327-373` — the only general write is `zer0/room/submit`, which dispatches all three agents, contradicting "the oracle spawns no agent").
Category: oracle-or-gate.
APPLIES-UNDER-B: **yes** — B needs a proof more than A does, because B has no compile-time falsifier for what it removed.
v3 must: name the exact operation, the exact value written and the exact value read back, so that a room which persists nothing fails.

**J5 · The protocol corpus lives in neither source tree; both halves reach up out of their own repository into `D:\Zer0 Chat V2\` to find it.**
Reviewers: DT, TI, PL (+CX clean-check) — **3**. Evidence: CONFIRMED-BY-EXECUTION (§A1 and the path arithmetic below).
`crates/zer0-room-protocol/tests/conformance.rs:23` — `include_str!("../../../../../protocol/conformance/v1/manifest.json")` resolves to `D:\Zer0 Chat V2\protocol\…`; `crates/zer0-v2-bin/tests/transport_protocol.rs:11-24` the same; `src/room/room-protocol.test.ts:23` — `new URL("../../../../protocol/conformance/v1/", import.meta.url)` likewise. `ls sources/*/protocol` fails in both repos.
Category: spec-fact-wrong / allow-list-miss.
APPLIES-UNDER-B: **yes, P0 under B specifically** — a copy of either source tree contains no `protocol/`, and the Rust tests then fail to **compile** (`include_str!` is compile-time), while the TS test throws at module load.
v3 must: treat the corpus as an input that must be imported with its provenance, and state that the Rust references are compile-time and can only be re-anchored manifest-relative, not by a runtime marker.

**J6 · `npm run gates` — the command every proof slice runs — crashes on the root file set the module map specifies.**
Reviewers: GA (executed 4 layout branches), CX; DT, TI, PL independently found the narrower "P3 misstates the chain" — **5 across the cluster**.
Evidence: CONFIRMED-BY-EXECUTION (GA: branch 1 `ENOENT docs/agents/core.md`; branch 2 `ENOENT CLAUDE.md`; branch 3a PASS; branch 3b `GATE FAIL: generated agent files drifted: AGENTS.md`). Verified by me: `scripts/generate-agent-files.mjs:14-19` renders `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` from `docs/agents/core.md` + 3 appendices; all four inputs and all three targets exist today; `scripts.gates` runs the gate third (§A8).
Category: allow-list-miss / oracle-or-gate.
APPLIES-UNDER-B: **partly** — copying the tree brings `docs/agents/` and all three root files, so the ENOENT half evaporates. The half that survives: the moment anyone hand-edits `AGENTS.md` the gate goes red, because it is generated. P2 under B.
v3 must: either carry the generator's whole input/output set unedited or retire the generator and its gate in the same slice — and P3 must enumerate the gate chain that `package.json` actually runs.

---

### P1 — a slice would be redone

**J7 · S0's postcondition and §5b's risk are built on two red `room-host.test.ts` cases that do not exist.**
Reviewers: DT, GA — **2**, plus my own run. Evidence: CONFIRMED-BY-EXECUTION ×3 (§A3).
Category: spec-fact-wrong. APPLIES-UNDER-B: **yes** — the same false baseline would open day 0 of B.
v3 must: delete the claim, or replace it with quoted output from a run that produced it and the environment it produced it in.

**J8 · S6 is built on `src/memory/digest-runner.ts`, which appears in neither the closure nor the module map; `src/chat/chat-trace.ts` (the digest child's only `ZER0_DEBUG` tracing) appears nowhere in the spec.**
Reviewers: DT, RE, GA, PL, CX — **5**. Evidence: CONFIRMED (`grep -c digest-runner closure-181-repo.txt` → 0; the four symbols S6 names all live in that one file at `:41,:95,:138`; its only production importers are the two deleted `src/cli/commands/chat-tui-*.ts`).
Category: allow-list-miss. APPLIES-UNDER-B: **no** — both files are already in a copied tree. Residual under B: after `src/cli` is deleted they have no importer until S6 wires them, so knip will flag them.
v3 must: list every file the digest slice edits in the map that the file set is derived from.

**J9 · Oracle step 1 ("`assertProductionJavaScript` passes over **every** staged production JS file") is red on the baseline: 30 of 182 compiled files fail, all of them retained.**
Reviewers: PL, TI — **2**, plus my reproduction. Evidence: CONFIRMED-BY-EXECUTION (§A8). All 30 are preserved comments containing `.ts's` matching `/\.ts["']/i`. Today the assertion runs on exactly 2 files (`package-zer0-v2-sidecar.mjs:42,:61`).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes**.
v3 must: state the scope the assertion is actually applied at, and fix the check or the comments before widening it — widening it as written turns the first gate red for a reason unrelated to TypeScript.

**J10 · The falsifier cannot be executed as described, and the gate it leans on is blind to the mutation it uses.**
Reviewers: TI — **1**, executed. Evidence: CONFIRMED-BY-EXECUTION (`stageZer0V2Sidecar` re-runs `build:production` and rm+cp's `dist`, so a deletion inside the staged sidecar has no window; deleting at source fails at step 1 in `copy-evidence-schema.mjs:23-32`, not at step 3. Separately `gate-l5-mandates.mjs:420-424` opens `gateSchemaDiscipline` with `if (!existsSync(schemaPath)) return true` — EXIT 1 on a corrupted schema, EXIT 0 on a deleted one).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes** — the falsifier is the only thing that makes the oracle more than decoration.
v3 must: specify the falsifier as a sequence that can actually be run against the artifact under test, and check that each gate it relies on fails on absence, not only on corruption.

**J11 · P7 (PTY drain) is satisfied by the empty set, and the one PTY a real turn opens is outside the registry it drains.**
Reviewers: RE, TI, PL — **3**. Evidence: CONFIRMED (`dispatch-headless.ts:85-92` — ACP is default-on (`dispatch-acp.ts:40`), so claude and codex never reach `dispatchPty`; gemini falls to `agy.ts:330 → agy-pty-spawn.ts:35` which spawns a ConPTY child never registered with `pty-session-registry.ts:76`).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes**.
v3 must: say which configuration makes P7 non-vacuous, and either bring agy's PTY into the drained registry or scope the postcondition to what the registry owns.

**J12 · `bootCatchUp` needs a `projectId` that does not exist where S6 places it, and `session/load` attaches a room S6 never covers.**
Reviewers: RE, PL, CX — **3**. Evidence: READ, converging (`digest-runner.ts:138` signature; `zer0-v2-host.ts:242-247` — `initialize` sets a flag and returns; the id is resolved inside `AliveRoomHost.create` at `room-host.ts:120` behind an exclusive lock; `zer0-v2-host.ts:306-314` is the second attach path).
Category: plan-sequence. APPLIES-UNDER-B: **yes** — identical wiring work.
v3 must: name one owner of attached-session identity that covers `session/new`, `session/load` and boot catch-up, instead of placing catch-up where identity does not yet exist.

**J13 · "No retained file grows; two shrink" is false, and two of the growing files are 10 and 4 lines under a hard ceiling with no escape hatch.**
Reviewers: DT, PL, CX — **3**. Evidence: CONFIRMED (`wc -l`: `src/room/zer0-v2-host.ts` **590**, `src/room/room-host.ts` **596**, `src/chat/types.ts` 205 receiving `src/tower/types.ts` 122; ceiling `gate-clamps.mjs:12,13` 500 soft/600 hard, `:120-122` "no escape hatch above hard ceiling — split the file"). S6 adds attached-session state + an idempotent close owner to the 590; S7 adds the PTY drain to the 596.
Category: plan-sequence / oracle-or-gate. APPLIES-UNDER-B: **yes** — same two files, same edits, same ceiling.
v3 must: schedule the extraction those two files need as part of the slice that grows them, not as a follow-up.

**J14 · Slice postconditions claim evidence that does not exist yet: S5 declares P11 (digest watermark + content) before S6 wires the digest, and S7 writes a prerequisite matrix "from S8's real output" before S8 runs.**
Reviewers: PL, CX, GA (the P3-vs-S7 gate-ordering variant) — **3**. Evidence: READ, quoted from the plan's own rows.
Category: plan-sequence. APPLIES-UNDER-B: **yes** — the ordering discipline transfers whole.
v3 must: make every slice's declared evidence producible at the moment the slice closes.

**J15 · The five most load-bearing new files land in `scripts/`, the one directory outside typecheck, size/header clamps and sibling-test coverage.**
Reviewers: GA, TI, CX — **3**. Evidence: CONFIRMED-BY-EXECUTION (`npx tsc --noEmit --listFiles | grep -c "zer0-agent-ci/scripts/"` → **0**; `gate-clamps.mjs:9` `INCLUDE_DIRS=["src","tests"]`, `:92` only `.ts/.tsx`; `gate-l5` G1 `SRC_DIR="src"`; `gate-scripts-scope.mjs:33-38` is one retired token that appears nowhere).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes** — any new proof script inherits the same placement.
v3 must: bring the new gate/oracle code inside the same quality mechanisms it is meant to enforce.

**J16 · Enrolling something in `npm run gates` does not put it in CI — CI never calls that script.**
Reviewers: GA, CX — **2**. Evidence: CONFIRMED (`.github/workflows/gates.yml:45-69` runs seven named steps: typecheck, biome, gate-clamps, dep-check, knip, `npm test`, and Linux-only `test:integration`; absent: `gate-l5-mandates`, `gate-patches`, `gate-encoding`, `gate-no-claude-p`, `gate-scripts-scope`, `gate-agent-files`, `test:live`. Job name is `6-gate sweep` while running seven).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes** — a new repo needs a workflow either way, and none is in the map.
v3 must: name the CI job that must run the same chain, and make renaming it a detectable event.

**J17 · The gates are not hermetic: a `session/new` writes the operator's global agy settings, and after S6 every gate run fires a real codex call whose failures are logged to a file nobody reads.**
Reviewers: PL, CX (the agent-warm-up half) — **2**. Evidence: READ (`zer0-v2-host.ts:405-407 ensureAgyStatusline()` → `agy-statusline-config.ts:76-106` writes under `defaultAgySettingsPath()`; `scripts/digest-run.ts:33-36 createCodexDispatch()` unless `ZER0_DIGEST_FAKE`; failures → `.zer0/journal/digest-failures.log` via `recordDigestCatastrophe`, never stdout; the packager's `npm ci --omit=dev` needs the registry and a toolchain on every run).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes**.
v3 must: state what the proof is allowed to touch outside its own temp root, and name the deterministic switch (`ZER0_DIGEST_FAKE`) the gate path uses instead of a live model call.

**J18 · Five gates in the chain report PASS when they collect nothing, and no slice sets a floor for any of them.**
Reviewers: GA, TI, CX — **3**. Evidence: CONFIRMED-BY-EXECUTION (GA, in an empty directory: `gate-clamps` → "0 files checked … PASS", `gate-l5-mandates` → no output, exit 0, `gate-scripts-scope` → PASS, `gate-encoding` → "0 files checked", `npx knip` with a non-matching entry → a *hint*, exit 0. TI: G5/G6/G7 become permanent no-ops on a V2 tree).
Category: oracle-or-gate. APPLIES-UNDER-B: **partly** — B keeps the files, so the collectors are not empty; but `gate-l5` G5 goes permanently inert the moment `src/temporal` is deleted, and G7 returns true if `schema.sql` ever goes missing.
v3 must: give every collector gate a minimum it must collect, so that "quiet" cannot read as "green".

**J19 · Only the oracle gets a falsifier; the four brand-new guards get none, and two declared guards are scheduled nowhere.**
Reviewers: GA, TI — **2**. Evidence: CONFIRMED (grep: `G-G` and `G-B` each appear once, in the §2.4 table only; G-E, G-F, the allow-list gate and the banned-patterns test have no planted-violation run anywhere in the plan).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes**.
v3 must: require a green-here/red-there pair for every new guard before it counts as enrolled, and assign the two orphan guards to a slice or delete them from the table.

**J20 · The extraction deletes on the order of 400+ test files with no before/after record and no rule that a dropped test needs a reason.**
Reviewers: GA, CX — **2**. Evidence: CONFIRMED (`find … -name "*.test.*"` → 624; 164 of the 181 closure files have a sibling; 14 existing `skip`/`todo` occurrences across 7 files. My own count: 625 test files tracked). After the cut, "`npm test` green" is a statement about a different suite.
Category: process / oracle-or-gate. APPLIES-UNDER-B: **yes** — deleting the five directories deletes their tests just as thoroughly.
v3 must: require a counted before/after test inventory with a one-line reason per deleted suite.

**J21 · The operator's own push gate fails open for a repository with no enrolled oracle — so the one repo they will be told is "the clean one" is the one their `git push` invariant is not protecting.**
Reviewers: GA — **1**. Evidence: READ, quoted from the operator's own hook (`~/.claude/hooks/ship-gate.sh:138-139` — "no enrolled oracle => ungated repo. Deliberate, VISIBLE fail-open"; the gate runs the enrolled `verify_path`, default `.zer0/oracle/verify.sh`). The spec builds a real oracle and enrols it in `npm run gates`, but no slice enrols it in the trust store; the compensating control is a sentence ("no push before S1").
Category: oracle-or-gate. APPLIES-UNDER-B: **yes**.
v3 must: make oracle enrolment in the push gate a postcondition of the slice that creates the oracle.

**J22 · Rewriting `.cargo/config.toml` for a private target dir silently drops the Windows rustflags the shipped binary is built with.**
Reviewers: PL — **1**. Evidence: CONFIRMED (`[target.x86_64-pc-windows-msvc] rustflags = ["-C","force-unwind-tables=yes","-C","target-feature=+crt-static"]`, referenced by the profile comment at `Cargo.toml:358`; the outer workspace config also supplies a relative `PROTOC`).
Category: allow-list-miss. APPLIES-UNDER-B: **yes, and sharper** — a folder copy that misses `.cargo/` changes the binary's linking with no error at all. This is the "hidden dependency on the old workspace" class in its quietest form.
v3 must: treat the workspace cargo config as a retained input whose contents are carried deliberately, not rewritten from scratch.

**J23 · The one Rust test that drives the real Node host is behind a non-default feature and hardcodes the old sibling checkout's directory name.**
Reviewers: CX — **1**. Evidence: READ (`crates/zer0-v2-bin/tests/host_lifecycle.rs:1` is `cfg(feature = "test-support")`, excluded from `zer0-v2-bin`'s defaults; when enabled, `:411-439` appends `zer0-agent-ci` to reach the Node side).
Category: oracle-or-gate. APPLIES-UNDER-B: **yes** — the layout changes under B too.
v3 must: state which Rust tests are in the shipped `cargo test` and repoint the one that reaches the Node half at the new layout.

**J24 · `tests/setup/*` is absent from the module map, and one of those files is the guard that exists because a test run once wrote 109 rows into the operator's real evidence database.**
Reviewers: GA, PL — **2**. Evidence: CONFIRMED (`vitest.config.ts:13-17` globalSetup names `tests/setup/{codex-home-global,worker-store-root,real-store-guard}.ts`; `real-store-guard.ts:4-11` records the 14,434-junk-row incident). S6 adds a detached child that resolves its DB path at runtime — the same defect class.
Category: allow-list-miss. APPLIES-UNDER-B: **no** — a copied tree keeps them. This is one of B's genuine wins.
v3 must: list the test harness's own setup files as retained inputs.

**J25 · Retained tests that no runner will execute, and one live model call inside `npm run gates`.**
Reviewers: GA, PL, TI, DT — **4**. Evidence: CONFIRMED (`vitest.config.ts:45` excludes `LIVE_TEST_FILES` from the default pool and `:30` excludes `tests/integration/**`; the map lists neither `vitest.config.live.ts` nor `vitest.config.integration.ts`; after the tower/tui rows go, the surviving live row is `src/memory/digest-extractor.live.test.ts` — a real codex call of roughly 250s — and `test:live` is inside `scripts.gates` today, §A8).
Category: allow-list-miss / oracle-or-gate. APPLIES-UNDER-B: **partly** — the configs travel, but the live call in the gate chain remains, and it is worth the operator knowing that a full gate run today costs a model call.
v3 must: name every runner config as retained, and decide explicitly whether a live model call belongs in the gate chain.

**J26 · Pruning Rust dev-dependencies removes the ConPTY test suite, after which `cargo test --locked` exits 0 with nothing to run.**
Reviewers: DT, RE, PL, CX — **4**. Evidence: CONFIRMED (`crates/zer0-v2-bin/Cargo.toml [dev-dependencies] ptyctl = { path = "../codegen/ptyctl" }`, consumed only by `tests/conpty_ui.rs`; `xai-grok-pager`'s dev-dep on `xai-grok-pager-pty-harness` backs 16-21 test files).
Category: plan-sequence / oracle-or-gate. APPLIES-UNDER-B: **partly** — under B nothing forces the prune, so the answer can simply be "keep `ptyctl`, `xai-grok-pager-pty-harness`, `xai-grok-test-support` and delete the product crates". That is a real advantage of B and should be taken deliberately.
v3 must: decide, in writing, which Rust test targets survive, and treat a `cargo test` that compiles zero test targets as a failure.

**J27 · The Rust half becomes a permanent fork, and the plan frames it as an inventory exercise.**
Reviewers: PL — **1**. Evidence: READ (`xai-grok-pager`'s `default = ["grok-runtime","jemalloc","sandbox-enforce"]`; 720 of the 1,012 `.rs` files in the 19 retained crates never compile in the release graph, 659 of them in `xai-grok-pager` behind `grok-runtime`, which `zer0-v2-bin` disables at `Cargo.toml:37`).
Category: decision-needed. APPLIES-UNDER-B: **yes, more so** — delete-in-place forks by construction, with no upstream path back.
v3 must: record forking the vendored Rust surface as an accepted, named consequence with no upstream updates, rather than as pruning.

**J28 · Dropping the three named files leaves nine retained modules with no importer — including the entire secret-filter.**
Reviewers: RE, CX (the `agent-prompt-stack` half) — **2**. Evidence: CONFIRMED (recomputed closure after the subtraction: 169 reachable vs 178 retained; the 9 are `chat/agent-prompt-stack.ts`, `evidence/memory-queries.ts`, `memory/{persistence,redaction,scoped-query,snapshot-builder}.ts`, `security/{denylist,entropy,filter}.ts`. `prefilter`'s only production importers are `prompt-builder.ts:23` — deleted — and two `src/temporal/` files — not retained).
Category: decision-needed. APPLIES-UNDER-B: **partly** — B need not delete `prompt-builder.ts`, in which case the security module keeps a caller. Either way the operator should know that secret prefiltering has no V2 caller today, because §2.3 describes the trust boundary "as it IS" without saying so.
v3 must: say plainly that secret prefiltering is not on any V2 path today and decide whether it is wired or dropped.

**J29 · P4's only enforcement mechanism — the allow-list gate — is never enrolled anywhere and cannot run in the slice that claims to prove P4.**
Reviewers: GA — **1**. Evidence: CONFIRMED (grep: the gate appears in the `scripts/` list and in P4's prose, never in P3's chain nor in S7's enrolment sentence; it is defined over *tracked* paths while S3b's candidate is explicitly git-free).
Category: oracle-or-gate. APPLIES-UNDER-B: **no** — B has no allow-list. The transferable half: nothing in B re-derives what is supposed to be in the folder after later slices add files.
v3 must: enrol every gate it invents in a named command, and prove it can run in the slice that depends on it.

**J30 · The digest child's entry is resolved by ancestor count and spawned detached with `stdio: "ignore"`, so a wrong path after packaging produces no error — only a missing journal row.**
Reviewers: RE, PL — **2**. Evidence: READ (`digest-runner.ts:30` `REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..","..","..")`, `:31` ENTRY, `:32` TSX_LOADER, `:62` `TSX_TSCONFIG_PATH`, `:115` `{detached:true, stdio:"ignore", windowsHide:true}`). S6(a)'s phrasing — "relative to `import.meta.url`" — is satisfied by the very expression that is wrong.
Category: plan-sequence. APPLIES-UNDER-B: **yes**.
v3 must: state the property (the entry sits beside its runner in the same compiled tree) rather than the mechanism, and name the packaged integration test as the guard that can catch it failing silently.

---

### P2 — an argument later

**J31 · G-F's "every table has a reader" is unsatisfiable while the schema is retained untouched.** RE, CX — 2. CONFIRMED (RE: 23 of 45 created tables have no `FROM`/`JOIN` in the 178 retained files; a live room DB has **60** tables including all seven `tower_*` — my §A2 measurement independently shows 60). Under B: **yes**, same schema. v3 must state the condition the guard can actually meet today, or defer the guard with the schema-trimming spec.

**J32 · knip cannot detect the orphans, because every `*.test.ts` is an entry and the map keeps a sibling test for every retained file.** RE, TI, GA — 3. CONFIRMED (`knip.config.js:48` entry `src/**/*.test.{ts,tsx}!`, `:66` `files: "error"`; all nine orphans have a sibling test). "entry = host" breaks in the other direction. Under B: **partly**. v3 must say which of the two failure modes it accepts.

**J33 · P10's "resolve from a repo-root marker, never by ancestor count" is unachievable for the Rust half.** DT, TI, PL — 3. CONFIRMED (`include_str!`/`include_bytes!` are compile-time, relative to the source file; the nearest mechanism is `CARGO_MANIFEST_DIR`-anchored, which is still an ancestor walk — and the correct count differs between `rust/crates/<c>/tests` and `rust/crates/codegen/<c>/tests`). Under B: **yes**. v3 must state one rule per half.

**J34 · P4 measures directory names, so it passes with 720 non-compiling `.rs` files and a second, quarantined room UI inside the retained crates.** PL, RE — 2. CONFIRMED / READ (`crates/zer0-v2-bin/src/lib.rs:13` `#[cfg(feature="quarantined-local-ui")] pub mod ui;` — nine files carrying plausible `zer0/room/submit` call sites, none in the `.d`). Under B: **yes**, identical. v3 must say that "no other crate" is a package statement, not a file statement, and name what it does about the dead files inside the kept crates.

**J35 · The `.gitignore` in the map is a strict narrowing of what the room writes into the project root.** RE, PL, DT — 3. CONFIRMED (a live session wrote `.council/runs/<id>/{room-events.jsonl,transcript.json,zer0-v2-room.json}`, `.zer0/evidence.db{,-shm,-wal}`, `.zer0/leases/*.lock`; today's `.gitignore:16-29` covers them, the proposed four patterns do not; `.zer0/blobs/`, `.zer0/journal/digest-failures.log`, `.zer0/debug/<id>/` also unlisted). Under B: **no** — the existing `.gitignore` travels. v3 must derive the ignore list from what the product writes, not from a shortlist.

**J36 · "12 dependencies" has no derivation and "no bin/dev" is ambiguous in the one place a wrong reading breaks every gate.** DT, PL, CX — 3. CONFIRMED (today: **21** deps, **12** devDeps, `bin: {"zer0":"./bin/zer0.mjs"}` — §A8; the closure yields 10 external packages + `patch-package` + `@openai/codex` = 12; L6 separately says devDeps 12 → 8, a number the spec never states). Under B: **partly**. v3 must show the arithmetic beside every count, and say "drop the `bin` field" rather than "no bin/dev".

**J37 · P8 ("the D: tree is unmodified") is not provable by `git status` + tree ID.** CX, PL — 2. READ (ignored and untracked bytes are in neither; `git worktree add` in S0 also writes `.git/worktrees/<name>/` inside the protected tree, which I1 bans by name). Under B: **yes** — B's copy source needs the same proof. v3 must define the protection artifact over the bytes it claims to protect.

**J38 · Shipping the open-source milestone before the trust-boundary hardening.** CX — 1, framed as a violated non-negotiable. READ. My judgement: this is a **legitimate scope call, not a defect** — §2.3 states it explicitly, an extraction that changes validation is no longer an extraction, and S11 is named. What is missing is the consequence, stated once, where a reader will see it. Under B: **yes**. v3 must state in the README-facing text that the JSON-RPC, env, argv and JSON-file boundaries are unvalidated in this release.

**J39 · The public workspace manifest carries a `[patch.crates-io]` pointing at a private-looking fork URL.** PL — 1. CONFIRMED (`Cargo.toml:3-4` `async-openai = { git = "https://github.com/our-forks/async-openai.git", rev = … }`, unused by the retained binary). Under B: **yes**. v3 must add a public-repo scan for private URLs and internal identifiers to the pre-publish audit.

**J40 · The release command's idempotent staging has no output-ownership guard.** CX, GA — 2. READ (the existing packager is safe only by construction — it removes exactly `<arg>/zer0-v2-node`, `package-zer0-v2-sidecar.mjs:44-45`). Under B: **yes**. v3 must state the refusal rule for the release target rather than inheriting safety by luck.

**J41 · `gate-l5`'s G7 pins `src/evidence/schema.sql` line 9 positionally, and S4 adds licence headers across the repo.** DT, GA — 2. CONFIRMED (`gate-l5-mandates.mjs:428-434 baselineVersionLineNumber = 9`). Loud, but foreseeable. Under B: **yes**. v3 must note the collision where the licence work is scheduled.

**J42 · An assertion edit is hidden inside a fifteen-item config list.** GA — 1. CONFIRMED (`package-zer0-v2-sidecar.test.mjs:76-80` `expect(stagedPatches).toEqual([… ,"patches/ink+5.2.1.patch"])`; S3b lists it as "sidecar-test expectation"; the new expected value appears nowhere). Under B: **yes** if the ink patch is dropped. v3 must state the new expected value where the edit is listed.

**J43 · `disposeAllPtySessions` loses its only executing test, and keeps a coverage exemption pointing at a test that mocks it.** TI — 1. CONFIRMED (`src/cli/commands/chat-tui.test.ts:49-60` is dropped; `dispatch-pty.test.ts:18-20` does `vi.mock("./pty-session-registry.js")`; `gate-l5-mandates.mjs:60-64` cites it as the consumer test). Under B: **yes**. v3 must name a test that executes the function P7 depends on.

**J44 · G-E as scoped would resolve absolute `D:\Zer0 Chat V2\…` paths that exist on one machine.** CX — 1. OBSERVED. Severity reduced from CX's P0: the gate does not exist yet and the fix is to scope it to repo-relative paths. Under B: **yes** if a docs-truth gate is kept. v3 must scope the gate to paths inside the repository.

**J45 · G-E's stated scope excludes the documents the seam moves actually falsify — the `@file`/`@exports` headers — and no gate validates them.** DT — 1. CONFIRMED (`grep "@file\|fileTag\|headerPath" scripts/gate-l5-mandates.mjs` → only its own header; the three moved seams all carry stale `@file`, and `render-escape.ts:8` names five exports where two survive). Under B: **yes** — the same three files move. v3 must include source-file headers in whatever docs-truth check it defines.

---

### P3 — cosmetic, or already correct with a wrong pointer

- **Citation off by one:** `gate-no-claude-p.mjs` `agent-bins.ts` entry is at **44-48**, not 43-47 (DT, PL — 2, CONFIRMED). Substance right. Not covered by decision 6: the same file's `QUARANTINE` at `:20-23` also names `src/tower/adapter-claude*.ts`, a tree that will not exist — verified by me at `scripts/gate-no-claude-p.mjs:20-23`.
- **`host_process.rs:1065` is the non-Windows arm** — the Windows arm is `:1063 "node.exe"`, and P1/P4/S8 all target Windows (DT, PL — 2, CONFIRMED). Substance right.
- **`prepare-context.ts:29` is the import, not the call** — the call is at `:264` (DT — 1, CONFIRMED).
- **A fourth `.tmTheme` exists on disk**; only three are `include_bytes!`'d (`xai-grok-pager-render/src/syntax.rs:152-156`). "3" is right if read as embedded, wrong against a `find` (DT — 1, CONFIRMED).
- **`gate-l5-mandates.mjs` docstring lists G1-G5,G7 and omits G6**, which it implements at `:348` (DT — 1, CONFIRMED). A counted comment that undercounts, in a file carried unchanged.
- **`AGENTS.md (≤100 lines)`** is 135 today and the limit has no mechanism, in the section whose contract is to label rules ENFORCED-with-mechanism or ADVISED (DT — 1, CONFIRMED).
- **`.zer0/oracle/UNSUPPORTED` is both a committed file and gitignored** (DT, PL — 2). Pick one.
- **The round-1 referee report exists at two paths under two dates**, byte-identical, and the spec cites only the copy outside the repository (DT — 1, CONFIRMED).
- **`rust-toolchain.toml` lists two Linux targets** V2 never builds, triggering rustup downloads on a fresh machine (PL — 1, CONFIRMED).
- **`gate-encoding`'s non-git fallback scans a different file set** than its git path, so "gates green on the git-free candidate" does not transfer for that gate (TI, GA — 2, CONFIRMED, `git ls-files` exit 128 observed). A-only.
- **17 of 178 retained files have no sibling test**, so §3's "sibling test for every retained production file" overstates by 17 (TI, CX — 2). GA verified all 17 match G1's exemption list, so no gate breaks — a wording defect only.
- **The blind review copy is not the record copy** — the §7 disposition table of round 1 and the REJECT history were stripped (DT — 1, CONFIRMED by `diff`, 30,642 vs 34,687 bytes). Process note for this round: a reviewer could re-raise something already dispositioned in a row they were never shown. It did not distort the P0/P1 list — every P0 above is independently measured — but the next blind round should ship the record copy.

---

## 3. FINDINGS I JUDGE FALSE OR OVERSTATED

| # | Finding | Ruling | Proof |
|---|---|---|---|
| CX #17a | "39 protocol files" is wrong; it is 38 | **FALSE** | `find protocol -type f \| wc -l` → **39**; `git ls-files protocol \| wc -l` → **39**. CX counted `conformance/v1` only and dropped `protocol/zer0-room-v1.schema.json` (§A1). |
| DT F3 / TI F5 / PL F21 | P6 is impossible because the room's DB is `{14}` (or `{14,15}`) and has no `journal_entries` | **FALSE** (the impossibility claim) / **CORRECT** (that I5 and §4 step 3 are false) | Measured: the room's own two-step open lands at `{14,15,16,20}` with `journal_entries` present and 60 tables (§A2). `room-host-support.ts:35` calls `initCarrierRuntime` unconditionally — no `carrierEnabled()` gate, unlike `chat-tui-boot.ts:53`. |
| RE R6 | `cargo metadata --no-deps` succeeds when an optional path dep's directory is absent | **FALSE** | Reproduced from scratch: `--no-deps` → **exit 101**, same error as the full resolve and as `cargo build` (§A6). The finding's conclusion is right and its mechanism is worse than stated. |
| RE R6 / PL F4 | the extra local packages are 11 / 20 | **BOTH UNDERSTATED** as a description of what must exist on disk | Direct edges leaving the 19 = **20** (PL right for "direct"); transitive local closure = **75** normal / **80** with dev+build, of 83 workspace packages (§A6). |
| CX #17b | the spec locates the wrapper at `prompt-budgeter.ts:33`, which is wrong | **OVERSTATED** | `prompt-budgeter.ts:33` is `estimatePromptTokens` — the wrapped function the sentence names. The wrapper is `prompt-builder.ts:83-85` and is simply uncited (§A4). |
| CX #14 / #15 | deferring Zod hardening, structured logging, pagination and the 250-line ceiling "violates the operator's non-negotiables" and "must move before S8" | **OVERSTATED** | These are scope calls the document makes explicitly and records in a follow-up register. An extraction that changes validation behaviour is no longer an extraction, and §2.3 says so. The defensible residue is that the release notes must state the boundaries are unvalidated — kept as J38 at P2. |
| CX #3 | G-E's absolute paths are a **P0** | **OVERSTATED** | Real, but the gate does not exist yet and the correction is to scope it to repo-relative paths. Kept as J44 at P2. |
| GA #9 | ship-gate fail-open (kept at P1) | **CORRECT, and it is the operator's own invariant** | Quoted from `~/.claude/hooks/ship-gate.sh:138-139`. Not overstated — flagged here only because it is the one finding sourced outside both trees. |

---

## 4. THE THREE QUESTIONS

### (a) Under Approach B, the five things that must be done or the copied folder will not build, run, or pass gates

1. **Bring `protocol/` in and repoint every reference.** 39 files live only in the workspace root (`D:\Zer0 Chat V2\protocol\`), and both halves reach out of their own repository to find them: `conformance.rs:23` and `transport_protocol.rs:11-24` use `include_str!/include_bytes!("../../../../../protocol/…")` — five levels up, landing on the workspace root — and `room-protocol.test.ts:23` uses four levels up. Copy the tree without this and `cargo test` fails at **compile** time, loudly; the ancestor counts then differ between `crates/<c>/tests` and `crates/codegen/<c>/tests`.
2. **Prune the Rust manifests before deleting a single crate directory.** The 19 retained packages declare 20 direct path dependencies outside themselves (16 optional + 4 dev on `xai-grok-pager`, 3 optional on `xai-grok-pager-render`, 1 dev on `zer0-v2-bin`), and through `xai-grok-shell` those pull a transitive local closure of **80 of the workspace's 83 packages**. Measured: an absent path-dep directory makes `cargo metadata`, `cargo metadata --no-deps` and `cargo build` all exit 101. Delete first and every cargo command in the folder dies.
3. **Move the three seams out before deleting `src/tower` and `src/tui`.** Seven retained files import into the doomed directories across eight lines: five importers of `escapeUntrusted` (`headless-turn.ts:29`, `permission-ask.ts:19`, `room-engine-primitives.ts:8`, `room-host-support.ts:20`, `room-mode.ts:30`), `room-mode.ts:31` on `tui/status-mode-language.js`, and `tower-bridge-lane.ts:12` on `tower/types.js`. Then delete the non-closure `src/chat` files that pull the rest of tower/loop in (`tower-bridge*.ts`, `cockpit-*.ts`, `loop-commands.ts`, `agent-bins.ts`, `chat-bridge-session.ts`) — and expect `gate-no-claude-p` to fail loudly when `agent-bins.ts` goes, because a missing tripwire file is a violation by design (`scripts/gate-no-claude-p.mjs:79-91`). Also drop the `bin` field: `bin/zer0.mjs:10` launches `src/cli/index.ts`.
4. **Carry the two invisible workspace dependencies.** `.cargo/config.toml` supplies `[target.x86_64-pc-windows-msvc] rustflags = ["-C","force-unwind-tables=yes","-C","target-feature=+crt-static"]` — omitting it in a copy changes the shipped binary's linking with no error. And `git` is a hard runtime prerequisite, not a build convenience: `session/new` refuses any root that is not a git work tree **and** its own toplevel (`project-scope.ts:149-166`), after which `room-host.ts:121-123` throws.
5. **Fix both false assertions in the proof before trusting it.** A real `session/new` leaves `_schema_version = {14,15,16,20}`, not `{14}` (measured), because `room-host-support.ts:35` opens the lane DB unconditionally; and the proof's project root must be `git init`'d and be its own toplevel. Add one value assertion — write something through the RPC surface and read the same value back — or the proof passes on a room that persists nothing.

### (b) Which reviewer findings become irrelevant under B

The whole **"the module map omits a file that must travel"** class dies, and it is roughly a third of the list: `tests/setup/{codex-home-global,worker-store-root,real-store-guard}.ts` (J24), `vitest.config.live.ts` and `vitest.config.integration.ts` (J25), `docs/agents/*` + `CLAUDE.md` + `GEMINI.md` (J6's ENOENT half), `src/memory/digest-runner.ts` and `src/chat/chat-trace.ts` (J8), the ten observability files' justification, the `.gitignore` narrowing (J35), `vitest.setup.ts`, the fourth `.tmTheme`, and the `createRequire` resolution class the allow-list script would have missed. Under B every file travels by default, so an omission cannot happen. The **allow-list machinery** findings go with it: the gate that is never enrolled and cannot run on a git-free candidate (J29), the undefined type-only-edge rule, and the "12 dependencies / 19 packages have no derivation" complaints (J36) — B derives nothing, it deletes and observes. So do the **filtered-history** findings: P5's contradiction between `git log --all -- src/tui` being empty and `--follow` reaching tower history, the S4 audit ordering, and decision 7 itself — a squash plus a provenance manifest makes all three moot. Finally `gate-encoding`'s non-git fallback (J-P3) is A-only, since B has a git history from the first commit.

### (c) The single biggest risk of B that A avoided

**B never produces a statement of what belongs in the folder, so "clean" is asserted and never checked — and the same gap lets the operator's real data walk into a public repository.** A's allow-list is a falsifiable claim about the result: a file that is not on the list is not there, and a missing file fails loudly at `tsc`/`cargo`. B has no such artifact. Two consequences follow from that one root cause. First, everything that survives silently, survives: 328 production `.ts` files outside the closure, 720 non-compiling `.rs` files inside the retained crates, the quarantined second room UI behind `#[cfg(feature="quarantined-local-ui")]`, and a 60-table schema of which 23 tables have no reader — none of which any gate will mention, because they all compile. Second, and more concretely damaging: a **copy is not a clone**. The working tree carries ignored and untracked state — `.zer0/evidence.db` (the operator's dogfood database, historically 14,434 junk `chat_sessions` rows), `.council/runs/<id>/transcript.json` for every past session, `dist/`, `rust/target/` — and a folder copy takes all of it into the folder that is about to get a fresh git history and be published. A takes only listed files and structurally cannot do this.

The mitigation is cheap and should be in v3 rather than left to discipline: **copy with `git archive`/`git clone` rather than a file copy** (so ignored bytes cannot travel), and after each cut re-run the import-closure computation — the tool exists and was validated in this review against `closure-181-repo.txt` with an empty diff — then diff the tracked file list against it. That gives B the same falsifiable membership statement A gets from its allow-list, at a fraction of the cost.

---

## 5. VERDICT

**REJECT.** The plan's architecture is sound — prove the file set, then replay history over it — but the document that will be built from contains six measured P0s, and two of them sit inside S1, the slice every other slice is gated on: the oracle asserts a schema-version row-set that a correct room does not produce, and its project root cannot even reach the assertion because `session/new` refuses a non-git directory. A third makes the proof command itself crash on the file set the map specifies, and a fourth means the Rust half of the result does not build until an edit the plan never names. The strategy survives; this draft does not.

Two notes for whoever writes v3. The rejection is **not** an argument for Approach B: of the 45 merged findings, roughly two thirds apply unchanged to B, six become B-only risks that are sharper than their A equivalents (the protocol corpus, the cargo pruning order, `.cargo/config.toml`, the seam moves, the fork, the ignored-state copy), and one whole class disappears. And the single most useful sentence to carry into either approach is the one no reviewer wrote and the measurement forced: **`src/room/room-host-support.ts:35` calls `initCarrierRuntime` with no `carrierEnabled()` gate, where the Ink boot gates the identical call** — which is why the room's database is at `{14,15,16,20}` with `journal_entries` present, why the digest has a place to write, and why `ZER0_MEMORY=0` is not the lever anyone assumed it was.
