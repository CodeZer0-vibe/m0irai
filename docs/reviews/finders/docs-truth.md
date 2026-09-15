# Finder report — lens: docs-truth

**Document reviewed:** `D:\Zer0 Chat V2\.council\review-copy\standalone-v2-spec.md`
**Trees resolved against:** `D:\Zer0 Chat V2\sources\zer0-agent-ci` (branch `codex/v2-room-layer`, HEAD `106d5ea775d4eaa2e617fcc0207a213e0798e824`) · `D:\Zer0 Chat V2\sources\grok-build-b13-candidate`
**Method:** every file:line quote re-read at that line; every count recounted with a command; every path stat'd; the Rust closure re-derived from `cargo tree`; the room test suite executed.

---

## F1 · `.council/review-copy/standalone-v2-spec.md:3-5` · **important** · CONFIRMED
**The document handed to reviewers is not the document in the repo — the review copy has had the "REJECTED once" history and the entire §7 disposition table stripped out.**

Trigger: reading the review copy as if it were the spec of record.

Proof — `diff` of the two files:
```
$ diff ".council/review-copy/standalone-v2-spec.md" "sources/zer0-agent-ci/docs/specs/2026-08-16-standalone-v2-spec.md"
3,5c3,10
< **Date:** 2026-08-16 · **Author:** Claude Fable 5 · **Status:** DRAFT — awaiting review, then operator go.
---
> **Date:** 2026-08-16 · **Author:** Claude Fable 5 · **Status:** DRAFT v2 — revised after codex
> sol-ultra referee round 1 (verdict **REJECT**, 5 P0 / 16 P1 / 3 P2 — report at
> `D:\Zer0 Chat V2\.council\reviews\2026-08-14-standalone-v2-spec-codex-referee.md` ...
...
> ## 7. REFEREE ROUND 1 — disposition of every finding   [24-row table, absent from the review copy]

$ wc -c
30642 .council/review-copy/standalone-v2-spec.md
34687 sources/zer0-agent-ci/docs/specs/2026-08-16-standalone-v2-spec.md
```
Also differing: the review copy's §6 says "**Awaiting:** review, then the operator's go"; the repo's says "**Awaiting:** codex sol-ultra referee **round 2** on this document (item-by-item against §7)". The review copy omits "**Supersedes** `2026-08-14-standalone-v2-spec.md` (v1)".

Consequence for lens item 4 (orphan artifacts): judged on the review copy, the round-1 REJECT looks like an undispositioned orphan. It is not — the repo copy dispositions all 24. Any finding a reviewer raises may already be dispositioned in a §7 row they were never shown.

---

## F2 · spec §5 row S0 and §5b bullet · **important** · CONFIRMED
**S0 instructs the builder to "Explain the two red `room-host.test.ts` cases" — the file is fully green, and so is every other room test.**

Trigger: running the suite on the exact branch the spec pins as its baseline.

Proof:
```
$ cd "D:/Zer0 Chat V2/sources/zer0-agent-ci" && npx vitest run src/room/room-host.test.ts
 ✓ src/room/room-host.test.ts (10 tests) 10206ms
 Test Files  1 passed (1)
      Tests  10 passed (10)

$ npx vitest run src/room --reporter=dot
 Test Files  26 passed (26)
      Tests  124 passed (124)
```
Branch/commit under test: `codex/v2-room-layer` @ `106d5ea` (`git branch --show-current`, `git log -1`).

§5b escalates the same non-fact into a risk: "*The two red room-host tests are a real regression* → S0 explains them; if a defect, own /fix before S3b." A builder will hunt for two failures that do not exist on this tree.

Honest caveat: these are process/ConPTY-heavy tests and I ran them once, on this machine. If the two red cases were environment-specific, the spec states them without any environment qualifier and without quoted output — which is itself the defect for a slice whose entire product is a pinned, quoted baseline.

---

## F3 · spec P6 vs I5 vs §4 step 3 · **important** · CONFIRMED
**P6 (a closing session yields a `journal_entries` row) cannot happen on the database the room opens, and the change that would make it happen falsifies I5 and the oracle's `{14}` assertion.**

Trigger: S6 wiring the digest against the room's existing DB open path.

Proof — the facts, each read at the line:
- `src/room/room-host.ts:117` — `const bootDb = openDb(options.dbPath);` (the memory-**off** open).
- `src/evidence/db.ts:190` — `applyMemoryMigration(db);` is called only inside `openMemoryDb`; `db.ts:138` — "migration (applyMemoryMigration), landing at **{14,15}**".
- `src/evidence/migrations-v15.ts:5` — "Applied ONLY by applyMemoryMigration via the memory-scoped openMemoryDb — **NEVER by the global applyMigrations chain**, so a memory-off DB stays byte-for-byte at v14"; `:25` — `CREATE TABLE IF NOT EXISTS journal_entries (` — the sole creation site (`grep -rn "CREATE TABLE.*journal_entries" src/` returns only this).
- `src/evidence/schema.sql` — 23 `CREATE TABLE` statements, `journal_entries` not among them (`grep -n journal_entries src/evidence/schema.sql` → no match).
- `src/evidence/migrations-v15.ts:13-17` — "15 is ADDED while 14 is KEPT, so a memory-on DB is **ALWAYS {14,15}**".

So: room DB = `{14}`, no `journal_entries` table → P6 impossible. Switch the room to `openMemoryDb` → row-set becomes `{14,15}` → §4 step 3 ("Assert the schema-version row-set = `{14}`") and I5 ("`_schema_version` terminal key `{14}` survives") both become false.

S6's text names `digest-entry.ts`, `digest-runner.ts`, `closeAttachedSession`, `spawnDetachedDigest`, `bootCatchUp` — and never names the DB open path. Today's digest child sidesteps this by opening the DB itself: `scripts/digest-run.ts:80` — `db = openMemoryDb(dbPath);`. Whether S6 keeps that arrangement decides which of P6 / I5 / §4-step-3 is the one that is wrong; as written all three are asserted together.

---

## F4 · spec §3 module map, `src/` line · **important** · CONFIRMED
**The one module S6 is built on — `src/memory/digest-runner.ts` — is in neither the closure nor the module map's additions, so by the map it does not exist in the result tree.**

Trigger: building `src/` from §3's formula "closure (181) − {prompt-builder.ts, memory-compiler.ts, lessons-reader.ts} + {named additions}".

Proof:
```
$ grep -n "digest-runner" .council/v2-map/phase2/closure-181-repo.txt ; echo "exit $?"
exit 1        # absent

$ grep -n "digest-runner" .council/review-copy/standalone-v2-spec.md
241:| **S6** | ... (b) `digest-runner.ts` spawns `process.execPath` on it, keeping `digestSpawnArgs`' contract ...
```
Line 241 (the S6 table cell) is the file's only mention. §3's additions list is `shared/render-escape.ts`, the `chat/types.ts` merge, `room/status-mode-language.ts`, 10 observability files, `evidence/schema.sql`, `chat/statusline-emit.cjs`, `memory/digest-entry.ts` — no `digest-runner.ts`.

`src/memory/digest-runner.ts` is real and owns all four symbols S6 names: `:20 DigestRequest`, `:41 spawnDetachedDigest`, `:95 digestSpawnArgs`, `:138 bootCatchUp`. Its own imports are already retained (`../chat/session-store.js` closure:80, `../shared/child-env.js` closure:154), so the omission is a map error, not a cascade — but the map is what the allow-list is built from.

This is lens item 6 exactly: a module the same merge depends on, not declared in the map.

---

## F5 · spec P4 vs P1 / §4 step 6 / S0 / S3b / S8 · **important** · CONFIRMED
**"the 19 local packages … and **no other** crate" is incompatible with `cargo test --locked`, which the spec demands in five places: two more local crates are dev-dependencies, and one of them drags in 78 local packages including grok's product crates.**

Trigger: running `cargo test` on a tree pruned to exactly 19 packages.

Proof:
```
$ cargo tree -p zer0-v2-bin --edges normal,dev --prefix none --offline | grep '(D:' | sed 's/ (.*//' | sort -u
  → 20 local packages: the spec's 19 PLUS  ptyctl v0.1.0

$ cargo tree -p xai-grok-pager --edges normal,dev --prefix none --offline | grep '(D:' | sed 's/ (.*//' | sort -u | wc -l
  → 78 local packages, including xai-grok-agent, xai-grok-tools, xai-grok-shell,
    xai-grok-auth, xai-grok-memory, xai-grok-sandbox, xai-grok-voice, xai-mixpanel …
```
The manifests:
- `crates/zer0-v2-bin/Cargo.toml:44-46` — `[dev-dependencies]` … `ptyctl = { path = "../codegen/ptyctl" }`
- `crates/codegen/xai-grok-pager/Cargo.toml` `[dev-dependencies]` — `xai-grok-pager-pty-harness = { path = "../xai-grok-pager-pty-harness" }`

The consumers:
- `crates/zer0-v2-bin/tests/conpty_ui.rs:21` — `use ptyctl::{`
- 16 files under `crates/codegen/xai-grok-pager/tests/` reference the pty harness (`pty_e2e/*`, `pty_auto_mode.rs`, `scripted_scenarios.rs`, …).

Root cause of the miss: the spec derives the closure partly from the `.d` file, and a `release-dist` **binary** dependency file structurally cannot see test targets or dev-dependencies. The evidence is in the same numbers the spec quotes — `crates/zer0-v2-bin` has 19 `.rs` files on disk but only 6 in the `.d`; `crates/zer0-room-protocol` has 16 on disk, 6 in the `.d`:
```
$ find crates/zer0-v2-bin -name '*.rs' | wc -l          → 19
$ grep -c '/crates/zer0-v2-bin/' <rs-inputs-from-.d>    → 6
$ find crates/zer0-room-protocol -name '*.rs' | wc -l   → 16
$ grep -c '/crates/zer0-room-protocol/' <same>          → 6
```
§3 does say every manifest is "pruned of unused deps/features/targets/benches/**dev-deps**". Pruning dev-deps removes `ptyctl`, which removes the ability to compile `tests/conpty_ui.rs`, which means the test target must go too — at which point `cargo test --locked` in §4 step 6 passes with nothing to run. That is the stub question answered against the spec: **a constant would pass this half of the oracle.** Which of "keep the 19" / "run cargo test" / "keep the Rust tests" gives way is not decided anywhere in the document.

---

## F6 · spec §3, line "No retained file grows; two shrink" · **important** · CONFIRMED
**Three retained files grow by the spec's own slices, and two of them sit 10 and 4 lines under the 600-line hard gate the spec cites as its ceiling.**

Trigger: executing S3b (the S2 seam merge), S6(c), S7.

Proof:
```
$ wc -l src/chat/types.ts src/tower/types.ts src/room/zer0-v2-host.ts src/room/room-host.ts
  205 src/chat/types.ts
  122 src/tower/types.ts
  590 src/room/zer0-v2-host.ts
  596 src/room/room-host.ts
```
- `src/chat/types.ts` (205) receives `src/tower/types.ts` (122, 8 exported types per its `@exports` header) → ~327. Grows.
- `src/room/zer0-v2-host.ts` (**590**) receives, per S6(c): attached-session state `{sessionId, projectId, dbPath, repoRoot}`, an idempotent `closeAttachedSession(reason)` routing shutdown + stdin EOF + future ops, the `spawnDetachedDigest` fire, and `bootCatchUp` after `initialize`. **10 lines of headroom.**
- `src/room/room-host.ts` (**596**) receives, per S7: `disposeAllPtySessions()` inside `RoomHost.shutdown()`'s deadline. **4 lines of headroom.**

The gate is hard, with no override above the ceiling — `scripts/gate-clamps.mjs:120-122`:
```
if (lines.length > HARD_CEILING_FILE_LINES) {
  `GATE FAIL: ${rel}:1 file has ${lines.length} lines, hard ceiling is ${HARD_CEILING_FILE_LINES} (no escape hatch above hard ceiling — split the file)`
```
`gate-clamps.mjs` runs inside `npm run gates`, which P3 requires green. §3 states the ceiling correctly ("gate-clamps: 500 soft / 600 hard, functions 50" — verified at `scripts/gate-clamps.mjs:12,13,16`) and then states an incompatible fact one line earlier.

---

## F7 · spec §3, `+ observability/{…} (10)` · **important** · CONFIRMED
**The 10 observability files are counted correctly and justified nowhere: no retained production file imports them, and their only retained-side importer is a test with no production sibling — which the map's own test-retention rule does not cover.**

Trigger: applying §3's stated rule "+ sibling `*.test.ts` for every retained production file + their transitive test-only imports" to decide why these 10 are in.

Proof — all 10 exist (each stat'd OK: `inspect.ts`, `with-meta.ts`, `schemas/index.ts`, `schemas/{diagnostic-report,error-event,event,failure-context,last-run-summary,run-inspection,run-state}.ts`), count is exactly 10. But:
```
$ grep -l "observability/" $(cat closure-181-repo.txt)
src/observability/lessons-reader.ts        ← dropped by the spec
src/temporal/activities/memory-compiler.ts ← dropped by the spec

$ grep -rn "from \"[^\"]*observability" src/chat/ --include=*.ts
src/chat/evidence-ledger-gate.test.ts:23:import { inspectRun } from "../observability/inspect.js";

$ ls -la src/chat/evidence-ledger-gate*
-rw-r--r-- 1 <user> 197609 15978 Jul 31 23:47 src/chat/evidence-ledger-gate.test.ts
   ← the .test.ts exists; src/chat/evidence-ledger-gate.ts does NOT
```
Every production importer of `observability/` is in `src/cli/commands/` (7 files) or `src/temporal/activities/` (7 files) — both banned by P4. The chain that pulls the other 9 is `src/observability/inspect.ts:17,18,19` (`./schemas/index.js`, `./with-meta.js`).

Two consequences the spec does not address: (a) the map's stated retention rule does not admit `evidence-ledger-gate.test.ts`, so under the map's own rule the 10 are unreachable; (b) §3 sets `knip.config.js (entry = src/room/zer0-v2-host.ts + retained scripts)`, dropping today's `src/observability/index.ts!` entry — and `src/observability/index.ts` is **not** among the 10 retained files, so nothing re-establishes the entry. `knip.config.js` sets `rules: { files: "error" }`, and `npm run dead-code` is inside `npm run gates` (P3).

§7 row 23 of the repo copy records this as "Observability count inconsistent — **FOLDED**: exact 10-file list in §3". The count was fixed; the reason was not supplied.

---

## F8 · spec P4 vs §3 (`.zer0/oracle/UNSUPPORTED`) vs §3 (`.gitignore`) · **important** · READ
**Three statements about `.zer0/oracle/*` cannot all be true.**

Trigger: creating the repo and deciding whether `.zer0/oracle/UNSUPPORTED` is committed.

Quoted, all from the review copy:
- P4: "no **tracked runtime state** (`.zer0/**` except `.zer0/oracle/*` markers and `.zer0/state.json` when generated — **both gitignored**)"
- §3 module map: "`.zer0/oracle/UNSUPPORTED` (harness marker)" — listed as a file of the repo
- §3 module map: "`.gitignore` (`.zer0/state.json`, `.zer0/evidence.db*`, `dist/`, `rust/target/`)" — **no `.zer0/oracle/*` pattern**

If the marker is gitignored it is not in the repo and a fresh clone (S8) has no oracle marker; if it is in the repo it is tracked state under `.zer0/`, which P4's parenthetical says is gitignored; and §3's own `.gitignore` contents contradict P4's "both gitignored" either way.

For contrast, today's mechanism is a negation list — `.gitignore:16-21`: `.zer0/*`, `!.zer0/.gitkeep`, `!.zer0/workflows/`, `!.zer0/workflows/*.md`, `!.zer0/agents/`, `!.zer0/agents/*.appendix.md` — which is why exactly one `.zer0/` file is tracked (`git ls-files .zer0` → `.zer0/workflows/adversarial-locked-override.md`, count 1, as the spec correctly states). §3's four-pattern replacement drops the negation structure without saying so.

---

## F9 · spec P3 · **important** · CONFIRMED
**P3 enumerates the gate chain and names 5 of the 7 gate scripts §3 retains — `gate-agent-files` and `gate-encoding` are missing, and both are in `npm run gates` today.**

Trigger: a builder implementing "P3 Gates green" from P3's parenthetical.

Proof:
```
$ node -e "console.log(require('./package.json').scripts.gates)"
npm run typecheck && npx biome check . && node scripts/gate-agent-files.mjs && node scripts/gate-clamps.mjs
 && node scripts/gate-encoding.mjs && node scripts/gate-no-claude-p.mjs && node scripts/gate-patches.mjs
 && node scripts/gate-scripts-scope.mjs && node scripts/gate-l5-mandates.mjs && npm run dep-check
 && npm run dead-code && npm test && npm run test:live && npm run test:integration
```
P3's list: "typecheck … · vitest · biome · knip · dependency-cruiser · gate-l5 · gate-clamps · gate-patches · gate-scripts-scope · gate-no-claude-p · the S1 oracle · G-E docs-truth · G-F reachability."
§3's scripts line: "`gate-{clamps,encoding,l5-mandates,no-claude-p,patches,scripts-scope,agent-files}.mjs`" — 7, all verified present on disk.
P3 also omits `test:live` and `test:integration`, both currently in the chain, and §3 retains `vitest.live-files.ts` which exists only to serve `test:live`.

Under the spec's own defect class E, P3 is the machine-checkable postcondition; a shorter chain here is what a builder will implement.

---

## F10 · spec NEEDS-DECISION item 6 · **nit** · CONFIRMED
**`gate-no-claude-p.mjs:43–47` is cited as the `src/chat/agent-bins.ts` entry; the entry is at 44–48.**

Proof:
```
43:   },                                    ← closes the PREVIOUS entry (src/adapters/registry.ts)
44:   {
45:     file: "src/chat/agent-bins.ts",
46:     pattern: /ZER0_ALLOW_CLAUDE_P/,
47:     why: "tower claude lane must stay behind the explicit cost-acknowledged override",
48:   },                                    ← closes the agent-bins entry
```
Off by one at both ends. The substance is right: `src/chat/agent-bins.ts` is not in the closure, and the other two tripwire files are — `src/chat/dispatch-headless.ts` (closure line 44) and `src/adapters/registry.ts` (closure line 25). Not covered by decision 6: the same file's `QUARANTINE` array at `:20-23` also names a removed tree — `/src[\/]tower[\/]adapter-claude[^\/]*\.ts$/` — so "the entry must go; the other two stay" is not a complete inventory of the gate's stale tree references.

---

## F11 · spec §2.4 row E (G-E scope) · **important** · CONFIRMED
**G-E docs-truth is scoped to "README, AGENTS.md, STATE.md, this spec" — it excludes source-file headers, which are the documents the three seam moves actually falsify, and no existing gate validates an `@file` path.**

Trigger: moving/merging the three seam files and running gates.

The header claims that go stale, each read at the line:
- `src/tower/render-escape.ts:2` — `@file src/tower/render-escape.ts`; `:8` — `@exports escapeUntrusted, towerChrome, agentSegment, decisionKeys, TOWER_CHROME_MARK` (5 names; §3 keeps 2); `:9` — `@depends yoctocolors, figures` (both imports leave with the trimmed exports — I read lines 60-100: `escapeUntrusted` uses neither).
- `src/tui/status-mode-language.ts:2` — `@file src/tui/status-mode-language.ts`; `:7` — `@exports ModeWord, MODE_WORDS, modeWord` (3 names; the trim keeps 2 — `MODE_WORDS`' only importer is `src/tui/status-cell-text.ts:19`, not retained).
- `src/tower/types.ts:2` — `@file src/tower/types.ts`; `:4` — 8 `@exports` that must be absorbed into `src/chat/types.ts`'s own `@exports` line.

Absence claim, with the search: `grep -n "@file\|fileTag\|headerPath" scripts/gate-l5-mandates.mjs` returns only line 3 (its own header). The L5 gates implemented are G1 test-coverage, G2 execa-handling, G3 zod-type-any, G4 unbounded-select, G5 activity-registration, G6 test-activity-isolation, G7 schema-discipline — none checks that `@file` matches the file's path. `scripts/generate-agent-files.mjs:4` generates the agent files "from `docs/agents/core.md` plus per-agent appendices", not from source headers. So a moved file carrying a stale `@file` ships silently, and G-E as scoped will not look.

---

## F12 · `scripts/gate-l5-mandates.mjs:9-20` · **nit** · CONFIRMED
**A retained script's own docstring enumerates its gates and omits one it implements.**

The header lists G1, G2, G3, G4, G5, G7. `grep -n "G6" scripts/gate-l5-mandates.mjs` → `348: // ---------- G6: test-activity-isolation ----------` and `393: gate: "G6 test-activity-isolation",`. A counted comment, undercounting by one, in a file §3 carries into the new repo unchanged.

---

## F13 · spec §1 facts, `host_process.rs:1065` · **nit** · CONFIRMED
**The citation resolves exactly but quotes the branch that never executes on the operator's machine.**

```
1062:         node: if cfg!(windows) {
1063:             OsString::from("node.exe")
1064:         } else {
1065:             OsString::from("node")
1066:         },
```
`grep -n 'OsString::from("node")' crates/zer0-v2-bin/src/host_process.rs` → only `:1065`. The claim ("`node` is a PATH lookup … a Node runtime is an external prerequisite") holds; the Windows lookup is for `node.exe` at `:1063`, and P1/P4/S8 all target Windows.

---

## F14 · spec P10 · **important** · READ
**"every test resolves it from a stable repo-root marker, never by ancestor count" is not achievable for the Rust half as written — those references are compile-time macros, resolved relative to the source file.**

Quoted from the tree:
- `crates/zer0-room-protocol/tests/conformance.rs:23` — `const MANIFEST: &str = include_str!("../../../../../protocol/conformance/v1/manifest.json");` plus ~35 more `include_bytes!` with the same prefix.
- `crates/zer0-v2-bin/tests/transport_protocol.rs:12,14,16,17,19,21,23,24` — same `../../../../../protocol/…` prefix.

`include_str!`/`include_bytes!` take a path relative to the containing source file and are expanded at compile time; a runtime repo-root marker cannot feed them. The nearest available mechanism is still an ancestor count, expressed against `CARGO_MANIFEST_DIR`. The TypeScript side is genuinely fixable — `src/room/room-protocol.test.ts:23` is `const corpusRoot = new URL("../../../../protocol/conformance/v1/", import.meta.url);` (citation resolves exactly at line 23), and that is a runtime resolution. P10 states one rule for both halves.

Related and unstated: the ancestor counts differ per crate in the new layout. Today all Rust references use five `../` from `<workspace>/sources/grok-build-b13-candidate/crates/<crate>/tests/`. Under `rust/crates/<crate>/tests/` the correct count is four, and under `rust/crates/codegen/<crate>/tests/` it is five — so "repointed to a repo-root marker" is not one substitution.

---

## F15 · spec §3, "package.json (12 deps · no bin/dev · …)" · **nit** · CONFIRMED
**The 12 resolves; "no bin/dev" is ambiguous in the one place a wrong reading breaks every gate, and no devDependency count appears anywhere in the spec.**

The 12 is right. My independent recount of the closure's external packages:
```
$ grep -h -oE 'from "(@?[a-z0-9@/._-]+)"' $(cat closure-181-repo.txt) | grep -v 'from "\.' | grep -v 'from "node:' | sort | uniq -c
     26 zod   8 execa   3 ulid   3 node-pty   3 @agentclientprotocol/sdk   2 yoctocolors   2 figures   2 better-sqlite3
$ grep -h -oE '"@agentclientprotocol/[a-z-]+"|"@openai/codex"' $(cat closure-181-repo.txt) | sort -u
"@agentclientprotocol/claude-agent-acp"  "@agentclientprotocol/codex-acp"
```
= 10, plus `patch-package` (postinstall) and `@openai/codex` (spawned bridge) = **12**, matching `phase2/out/L6-npm-dependency-truth.md:46` ("**8 + 3 + 1 = 12.**"). Today's `package.json` declares 21; L6 §6 records the same arithmetic ("21 → 12 production dependencies. 12 → 8 devDependencies").

The gap: `package.json` today has **12 devDependencies** and L6 says keep **8** — a number the spec never states. "no bin/dev" sits immediately after "12 deps" and can be read as "no devDependencies"; `npm run gates` needs `typescript`, `vitest`, `@biomejs/biome`, `knip`, `dependency-cruiser`, all of which are devDependencies. There is a `dev` npm script (`scripts: postinstall | dev | build | …`) and a `bin` field (`{"zer0":"./bin/zer0.mjs"}`), so the intended reading is probably "drop the bin field and the dev script" — the spec should not leave a builder to guess which, and G-E has no devDep count to resolve.

---

## F16 · spec header (repo copy) · **nit** · CONFIRMED
**The round-1 referee report exists at two paths under two different dates in the filename; the spec cites only the copy that lives outside the repository.**

```
$ ls -la .council/reviews/2026-08-14-standalone-v2-spec-codex-referee.md
-rw-r--r-- 22427  ← cited by the repo copy of the spec

$ ls -la sources/zer0-agent-ci/docs/reviews/2026-08-16-standalone-v2-spec-codex-round1.md
-rw-r--r-- 22427  ← the in-repo copy, never cited

$ cmp <the two> ; echo $?
0    (byte-identical)
```
Same bytes, two names, two dates, one inside the repo and one outside it. §3b says `docs/reviews/` carries referee reports into the new repo; the `.council/` copy will not travel. Nothing reconciles them if one is edited. The spec's own header already flags this failure mode once for a different file — "`…\.council\v2-review-2026-08-14.html` (dated 08-14 in name; the review ran 08-16)" — so it is a known-recurring naming defect, unguarded.

---

## F17 · `D:\Zer0 Chat V2\.council\reviews\` · **nit** · CONFIRMED
**Agent-produced artifacts sit beside the cited referee report with no disposition recorded in any document.**

Stat only — I did not open these files (my brief bars reading other reviewers' output):
```
-rw-r--r--     249  2026-08-16-standalone-v2-spec-codex-round2.md
-rw-r--r--   32964  2026-08-16-standalone-v2-spec-codex-round2.md.err
-rw-r--r--   16768  2026-08-16-standalone-v2-spec-codex-round2.md.raw
drwxr-xr-x       0  2026-08-16-standalone-v2-spec-codex-blind.md.lock     ← lock dir, no output file
drwxr-xr-x       0  .dispatch-run.9cZzeK
-rw-r--r-- 1359530  2026-08-14-standalone-v2-spec-codex-referee.md.err
-rw-r--r-- 1127649  2026-08-14-standalone-v2-spec-codex-referee.md.raw
```
The repo copy of the spec says it is "Awaiting **round 2**". A 249-byte round-2 output next to a 32,964-byte stderr and a 16,768-byte raw is the shape of a dispatch that did not produce a review; a `.lock` directory with no output beside it is the shape of one that did not finish. Neither has a disposition (fixed / scheduled / rejected-with-reason) in the spec or anywhere else I searched. Under lens item 4 that is the field pattern verbatim: unreferenced agent output at rest while documents assert the review state.

---

## F18 · spec §1 facts · **nit** · CONFIRMED
**"Callers of `compileMemory` outside the closure exist (`src/temporal/activities/prepare-context.ts:29`)" cites the import, not a caller.**

```
29: import { type CompiledMemory, compileMemory } from "./memory-compiler.js";
...
264:  const memory = await (deps.compileMemoryFn ?? compileMemory)({
```
The call is at `:264`. The claim is true; the line number points at the wrong kind of evidence, in the one sentence the spec offers as a corrected fact.

For contrast, the neighbouring citations in the same paragraph resolve exactly: `src/chat/prompt-budgeter.ts:33` is `export function estimatePromptTokens(text: string): number {`, and `estimateTokens` at `src/chat/prompt-builder.ts:83-85` really is a one-line wrapper (`return estimatePromptTokens(text);`). The "four static imports in the closure" recount is also exact — 9 importers of `prompt-builder.js` exist repo-wide, of which exactly 4 are in the closure (`commands.ts`, `evidence.ts`, `evidence-strict.ts`, `headless-turn.ts`) and all 4 import only `estimateTokens`.

---

## F19 · spec §3, "+ assets (3 .tmTheme, Roboto-Regular.ttf)" · **nit** · CONFIRMED
**A fourth `.tmTheme` exists inside a retained crate; the count of 3 is right only if read as "assets actually embedded".**

```
$ find crates/zer0-v2-bin crates/zer0-room-protocol crates/codegen prod/mc third_party -name "*.tmTheme"
crates/codegen/xai-grok-markdown/assets/tokyo-night.tmTheme        ← the 4th
crates/codegen/xai-grok-pager-render/assets/grok-day.tmTheme
crates/codegen/xai-grok-pager-render/assets/grok-night.tmTheme
crates/codegen/xai-grok-pager-render/assets/tokyo-night.tmTheme
```
Only three are embedded — `crates/codegen/xai-grok-pager-render/src/syntax.rs:152,154,156` (`include_bytes!` of grok-night, tokyo-night, grok-day). The markdown crate's copy appears only in doc-comment examples (`lib.rs:18`, `syntax.rs:35`). In a module map that otherwise describes files on disk, an allow-list reviewer reconciling "3" against a `find` will get 4 and not know which reading is intended.

---

## F20 · spec §3, "New files: `src/memory/digest-entry.ts` (<60 lines)" · **nit** · CONFIRMED
**The size claim for the replacement digest entry is asserted without accounting for what the existing entry does, including an import of a module that is not retained.**

Today's entry is `scripts/digest-run.ts` (6,418 bytes; named at `src/memory/digest-runner.ts:31` — `const ENTRY = path.join(REPO_ROOT, "scripts", "digest-run.ts");`), and `scripts/digest-run.ts:14` is `import { attachTraceSink } from "../src/chat/chat-trace.js";`. `src/chat/chat-trace.ts` exists (5,686 bytes) and is **absent from the closure** (`grep -c "chat-trace" closure-181-repo.txt` → 0). Its other imports are all retained (`events.ts` closure:47, `digest-extractor.ts` :112, `digest.ts` :111, `journal-store.ts` :116, `debug-mode.ts` :158) and `openMemoryDb` comes from `evidence/db.ts` :90. So `digest-entry.ts` either drops tracing (and with it `ZER0_DEBUG=1` observability on the digest child) or pulls in a file the map does not list. Neither is stated.

---

## F21 · spec §3b, "`AGENTS.md` (≤100 lines)" · **nit** · CONFIRMED
**A ceiling stated as a rule with no named mechanism, in a section whose own contract is to label rules ENFORCED-with-mechanism or ADVISED.**

`wc -l AGENTS.md` → **135** today. `scripts/gate-agent-files.mjs:10` is `const drift = generateAgentFiles({ check: true });` — a regeneration-drift check against `docs/agents/core.md` plus appendices, not a length check. §3b's own words are "rules labeled ENFORCED (mechanism) / ADVISED"; this one carries a number and no label.

---

## F22 · `scripts/gate-l5-mandates.mjs:428-434` · **preexisting** · CONFIRMED
**A retained gate hardcodes a line number inside `src/evidence/schema.sql`, and its docstring names a schema version the tree left behind.**

```
428:  const baselineVersionLineNumber = 9;
429:  const baselineVersionLine = lines[baselineVersionLineNumber - 1];
431:  if (baselineVersionLine !== expectedVersionLine) {
434:      message: `Schema baseline version must stay at 5. Found: ${baselineVersionLine ?? "missing"}`,
```
against `:19` — "G7 schema-discipline — schema.sql stays at **baseline v5** and new indexes ship through migrations only". The live `_schema_version` terminal is 14 (`src/evidence/migrations.ts:80` — `INSERT OR IGNORE INTO _schema_version(version) VALUES (14);`; asserted at `src/evidence/db.test.ts:309`). The gate's own invariant is coherent (a v5 *baseline* file plus a migration chain to 14), but it binds to `schema.sql` line 9 positionally, and the spec's engineering call is "schema untouched" — so the binding survives this pass and travels into the new repo as a latent line-number dependency.

---

## Checks that came back clean

Every one of these I resolved with a command and it matched the spec exactly.

**Rust closure numbers — all exact.** `.d` file `.rs` inputs: 292 total = 215 `crates/` + 11 `prod/mc/` + 66 `third_party/` (0 outside those three). `crates/` resolves to 14 crates: `zer0-v2-bin`, `zer0-room-protocol`, and 12 under `crates/codegen/` whose names match §3's list one-for-one (`xai-grok-pager`, `-pager-render`, `-markdown`, `-markdown-core`, `-config`, `-mermaid`, `xai-ratatui-inline`, `-textarea`, `xai-tty-utils`, `xai-prompt-queue`, `xai-grok-version`, `xai-grok-paths`). 14 + 1 + 4 = **19** for the normal-edges closure. `.d` file mtime `Aug 14 02:13`, matching "b13-candidate build of 2026-08-14 02:13".

**Both cargo-tree chains are real.** `crates/codegen/xai-grok-config/Cargo.toml:13` — `prod-mc-cli-chat-proxy-types = { path = "../../../prod/mc/cli-chat-proxy-types" }`; `cargo tree -i prod-mc-cli-chat-proxy-types --workspace` renders the inverse tree through to `zer0-v2-bin`, and the forward tree from `zer0-v2-bin` contains it. `xai-grok-mermaid/Cargo.toml:25` → `mermaid-to-svg`; `xai-grok-pager/Cargo.toml:37` → `xai-grok-mermaid`; `zer0-v2-bin/Cargo.toml:37` → `xai-grok-pager` (optional, behind `grok-pager-room`, which `release-dist` enables — the `.d` proves it compiles).

**Licences.** third_party = Apache-2.0 ×3 (`dagre_rust:39`, `graphlib_rust:27`, `ordered_hashmap:32`), MIT ×1 (`mermaid-to-svg:141`); LICENCE/LICENSE present in all four, plus `THIRD_PARTY_NOTICES` in mermaid-to-svg.

**Protocol corpus.** `find protocol -type f | wc -l` → **39**; `git ls-files protocol | wc -l` → **39** in the outer workspace repo. Absent from both source repos — `ls sources/zer0-agent-ci/protocol` and `ls sources/grok-build-b13-candidate/protocol` both fail, and `git ls-files | grep -c '^protocol/'` → 0 in each.

**`git ls-files | wc -l` in `grok-build-b13-candidate` → 3166.** The "subtree dragging 3,166 files" figure is exact. `bin/protoc` exists, so P4's exclusion of it is real.

**JSON-RPC boundary.** `grep -c zod src/room/zer0-v2-rpc.ts` → 0. §2.3's "hand-rolled validation" holds.

**Test fixture.** `src/chat/agent-prompt-stack.test.ts:39-44` is exactly the block that reads `.zer0/workflows/adversarial-locked-override.md` — the cited range is correct to the line. `git ls-files .zer0` returns that one path and nothing else, matching P4's carve-out.

**Schema and query counts.** `_schema_version` terminal 14 (`migrations.ts:80`; `db.test.ts:309`). `createQueries` prepares against **14** distinct tables (extracted from `src/evidence/queries-statements.ts`: `active_debates, chat_messages, chat_sessions, chat_working_sets, context_items, context_runs, dispatches, errors, events, findings, findings_fts, gate_transitions, runs, tasks`).

**The exact error string** in §4 step 4 — `src/room/zer0-v2-host.ts:508`: `if (canonical !== repoRoot) throw invalidParams("cwd must match the host project root");`

**MT3d TOCTOU test exists and is reusable** — `src/memory/digest.test.ts:217`, with the production seam at `src/memory/digest.ts:29,79,182`; `digest.ts` is in the closure.

**`disposeAllPtySessions` exists** — `src/chat/pty-session-registry.ts:76`, and `pty-session-registry.ts` is in the closure (line 77), so P7/S7 have something to call.

**`assertProductionJavaScript` exists** — `scripts/package-zer0-v2-sidecar.mjs:122`, already called at `:42` and `:61`.

**`f6-privacy` patch is real** — 4 `PATCH(zer0 f6-privacy)` markers inside `patches/@agentclientprotocol+claude-agent-acp+0.63.0.patch`. `patches/` holds 3 files today; `package.json` `zer0Patches` lists 3; removing `ink+5.2.1.patch` leaves the 2 the spec claims, and the two remaining filenames match §3 character-for-character.

**gate-clamps ceilings** — `scripts/gate-clamps.mjs:12` 500, `:13` 600, `:16` 50, exactly as §3 states.

**Every path §3's module map names exists.** All 18 scripts (`package-zer0-v2-sidecar.mjs` + `.test.mjs`, `clean-dist`, `copy-evidence-schema`, 6 `patch-*`, 7 `gate-*`, `generate-agent-files`) and all 9 root/config files (`knip.config.js`, `vitest.config.ts`, `vitest.live-files.ts`, `.dependency-cruiser.cjs`, `biome.json`, `tsconfig.json`, `tsconfig.production.json`, `src/evidence/schema.sql`, `src/chat/statusline-emit.cjs`) stat OK. All 10 observability files stat OK. `vitest.live-files.ts:5-9` carries the `src/tower/` rows the spec says to remove.

**Every evidence-base path in the spec header resolves** — `.council/v2-map/map/` (56 entries), `.council/v2-map/phase2/out/` (26 reports = 9 lanes L1-L9 + 17 refuters C1-C6 static/runtime + S1-S5, matching the "17 refuter reports" figure in the repo copy), `closure-181-repo.txt` (exactly 181 lines), `.council/v2-review-2026-08-14.html`, `.cache/target/release-dist/zer0-v2.d`, `HANDOFF-2026-08-14.md` (which does have a `## 5. WHAT HAPPENS NEXT` at line 211 describing the subtract-in-place sequence the spec supersedes).

**I7's premise holds.** No `react`, `ink`, or `@temporalio/*` specifier appears in any of the 181 closure files — the external-import extraction over the whole closure returns only `zod`, `execa`, `ulid`, `node-pty`, `@agentclientprotocol/sdk`, `yoctocolors`, `figures`, `better-sqlite3`.

**The digest really is unwired in V2 today**, as §1 claims. The only callers of `spawnDetachedDigest` / `bootCatchUp` are `src/cli/commands/chat-tui-mount.ts:521` and `src/cli/commands/chat-tui-boot.ts:95` — both under `src/cli/`, both excluded by P4.

**The seam trims are accurate.** `MODE_WORDS`' only importer is `src/tui/status-cell-text.ts:19` (not retained), so trimming `status-mode-language.ts` to `ModeWord` + `modeWord` for its one retained consumer (`src/room/room-mode.ts:31`) is correct. `escapeUntrusted` uses neither `figures` nor `yoctocolors`, so trimming `render-escape.ts` to it leaves `src/chat/ui.ts` as the sole closure user of both — the dependency count is unaffected.

**The old spec closes its own loop.** `docs/specs/2026-08-14-standalone-v2-spec.md:1-2` carries a SUPERSEDED banner naming the v2 file and the REJECT verdict — so v1 is not an orphan, even though the review copy (F1) never mentions it.
