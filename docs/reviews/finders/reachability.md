# Finder report — lens: REACHABILITY

Document reviewed: `D:\Zer0 Chat V2\.council\review-copy\standalone-v2-spec.md`
Evidence trees: `D:\Zer0 Chat V2\sources\zer0-agent-ci` (Node), `D:\Zer0 Chat V2\sources\grok-build-b13-candidate` (Rust)

Instruments built (scratchpad, read-only over the trees): an import-closure / reverse-graph tool, a schema table reader-writer sweep, a Cargo path-dependency closure tool, and a live drive of the built room host.

**Instrument control passed before any finding was written:** my independently computed static import closure from `src/room/zer0-v2-host.ts` is identical to the spec's `closure-181-repo.txt` (diff empty, 181 files). The tool agrees with an artifact it did not produce, so its later answers are trustworthy.

---

## R1 · spec section 3 line 175 (`src/ = closure (181) minus {prompt-builder.ts, memory-compiler.ts, lessons-reader.ts}`) · important · CONFIRMED

**Deleting the three named files orphans nine more files that the module map still retains — including the entire `src/security/` secret-filter module.**

Trigger: apply the subtraction, then recompute reachability from `src/room/zer0-v2-host.ts`.

Proof — recomputed closure with those three removed as both nodes and edges:

    reachable after deleting the 3: 169  | spec's retained set: 178
    === RETAINED BUT NO LONGER REACHABLE FROM THE HOST (9) ===
    src/chat/agent-prompt-stack.ts
    src/evidence/memory-queries.ts
    src/memory/persistence.ts
    src/memory/redaction.ts
    src/memory/scoped-query.ts
    src/memory/snapshot-builder.ts
    src/security/denylist.ts
    src/security/entropy.ts
    src/security/filter.ts

The security module's only production importers today:

    src/chat/prompt-builder.ts:23:import { prefilter } from "../security/filter.js";     <- deleted by section 3
    src/memory/redaction.ts:7:import { flagHighEntropy } from "../security/entropy.js";  <- itself orphaned
    src/temporal/activities/dispatch-prefilter.ts:11 / dispatch.ts:16                    <- not retained (P4 bans src/temporal)

So `prefilter` — the secret denylist/entropy filter — has **zero importers** in the delivered repo. Section 2.3 describes the trust boundary "as it IS" and says "this pass changes none of it"; the accurate statement is that secret filtering already has no caller on any V2 path, and after S3b it is not even import-reachable. Related: S3 plans to relocate `.zer0/workflows/adversarial-locked-override.md` to `tests/fixtures/` for `agent-prompt-stack.test.ts` — carrying a fixture for a module with no caller.

## R2 · spec section 2.4 row F (`G-F: ... knip entry = host`) · important · CONFIRMED

**The gate assigned to defect class F cannot detect the nine orphans in R1, because every `*.test.ts` is a knip entry and section 3 keeps a sibling test for every retained file.**

Trigger: run `npm run dead-code` (knip) on the S3b candidate.

Proof — `knip.config.js:48` lists `"src/**/*.test.{ts,tsx}!"` as an entry and `knip.config.js:66` sets `files: "error"`. Section 3 line 180 retains "sibling *.test.ts for every retained production file". All nine orphans have one:

    SIBLING TEST EXISTS: src/chat/agent-prompt-stack.test.ts
    SIBLING TEST EXISTS: src/evidence/memory-queries.test.ts
    SIBLING TEST EXISTS: src/memory/persistence.test.ts
    SIBLING TEST EXISTS: src/memory/redaction.test.ts
    SIBLING TEST EXISTS: src/memory/scoped-query.test.ts
    SIBLING TEST EXISTS: src/memory/snapshot-builder.test.ts
    SIBLING TEST EXISTS: src/security/denylist.test.ts
    SIBLING TEST EXISTS: src/security/entropy.test.ts
    SIBLING TEST EXISTS: src/security/filter.test.ts

A production file whose only importer is its own test is indistinguishable from a live module under this config. The stub question — would a constant still pass? — answers yes: knip goes green on a tree where nine modules are dead. If instead the test entries are dropped, knip flags every test-only helper and export in the tree. The spec picks neither and says only "entry = src/room/zer0-v2-host.ts + retained scripts" (section 3 line 186).

## R3 · spec section 2.4 row F (`every table has a reader`) · important · CONFIRMED

**23 of the 45 tables the retained schema creates have no reader in the 178 retained files, so G-F as worded cannot go green while P3 requires it in `npm run gates`.**

Trigger: enumerate `CREATE TABLE` across `src/evidence/schema.sql` plus every retained `migrations*.ts`, then search all 178 retained production files for `FROM <t>` / `JOIN <t>`.

Proof (artifacts `is` and `lane_*_v20` excluded — the first is a comment in migrations-v8-v12.ts:78, the others are intra-migration rename staging tables in migrations-v20.ts:36-73):

    real tables: 45
    orphan (no FROM/JOIN in the 178 retained files): 23
    agent_failure_patterns, agent_turns, capacity_snapshots, chat_artifacts,
    chat_build_assignments, chat_build_runs, commit_intents, decisions, dispatch_claims,
    gate_transitions, generated_artifacts, memory_tasks, requirements, tournament_results,
    tower_agent_lanes, tower_decision_sends, tower_decisions, tower_proposals, tower_sessions,
    tower_turns, tower_worktrees, verifications, work_journal

And live, from a room I actually booted (driver in R4): a fresh V2 room database contains **60 tables**, including all seven `tower_*`, `work_journal` plus its four FTS shadow tables, `decisions` plus FTS, and `tournament_results`. Section 1 states "schema untouched" and the follow-up register defers schema trimming to its own spec, so the orphans are by design — but then the guard's own sentence is unsatisfiable. The delivered repo bans `src/tower` files (P4) while every database it creates still builds the tower's tables.

## R4 · spec section 4 step 3 ("Assert the schema-version row-set = {14}") and section 2.2 I5 · important · CONFIRMED

**A real `initialize` + `session/new` leaves `_schema_version` = {14,15,16,20}. The oracle's positive-path assertion and invariant I5 are false as written.**

Trigger: exactly the oracle's own positive path — spawn the built host in a fresh temp project root, `initialize`, then a valid `session/new`.

Proof — I drove `dist/src/room/zer0-v2-host.js` over stdio in a fresh git repo under the scratchpad. The room came up (`"id":2,"result":{"sessionId":"chat-1786904547372-..."}`, followed by `room-ready`, `agent.mode` and `agent.status` events for gemini/codex/claude). Its stderr shows the two opens in order:

    [DEBUG] database opened {"dbPath":".../.zer0/evidence.db","mode":"global"}   <- room-host.ts:117 openDb
    [DEBUG] database opened {"dbPath":".../.zer0/evidence.db","mode":"lane"}     <- lane-transport.ts:127 openLaneStateDb

Read back read-only:

    _schema_version after initialize + session/new = [14,15,16,20]
    journal_entries rows after a full session/new + shutdown: 0

Mechanism: `session/new` -> `AliveRoomHost.create` (`room-host.ts:117` `openDb`, global mode = {14}) -> `initializeRoomSession` (`room-host-support.ts:35`) -> `initCarrierRuntime` (`lane-transport.ts:127`) -> `openLaneStateDb`, which applies the v15/v16/v20 migrations unconditionally. Isolated confirmation of the two openers:

    openDb        (room-host.ts:117 bootDb): _schema_version = {14}  journal_entries table present = false
    openLaneStateDb (called by session/new): _schema_version = {14,15,16,20}  journal_entries table present = true

Consequence for the plan: S1 enrolls this oracle in `npm run gates` before any push, and the falsifier is run against the positive path. A positive path that fails for a reason unrelated to the falsifier gets "fixed" by relaxing the assertion — which is the one edit that makes the oracle stop biting.

## R5 · spec section 3 lines 175-189 plus S6(b) · important · CONFIRMED

**S6 depends on two files the module map never lists: `src/memory/digest-runner.ts` and `src/chat/chat-trace.ts`.**

Trigger: build the digest entry's own import closure and subtract the retained set.

Proof:

    === digest-side files NOT in closure-181 ===
    scripts/digest-run.ts
    src/chat/chat-trace.ts
    src/memory/digest-runner.ts

`digest-runner.ts` exports exactly the four symbols S6 names — `spawnDetachedDigest`, `digestChildEnv`, `digestSpawnArgs`, `bootCatchUp` — and its only production importers today are `src/cli/commands/chat-tui-boot.ts:29` and `chat-tui-mount.ts:50`, both banned by P4. Grepping the spec: `digest-runner` appears only in the S6 prose row, never in section 3's file list or the "New files" line; `chat-trace` appears **nowhere in the spec** (`grep -n "chat-trace"` returns no match). `chat-trace.ts` is what `scripts/digest-run.ts:15` uses (`attachTraceSink`) to write the digest child's only trace under `ZER0_DEBUG` — and the standing rule is that live tests always run `ZER0_DEBUG=1`. S3's allow-list script closes over static imports of the current tree, where `digest-runner.ts` has no retained importer, so the mechanical derivation will not pull it in; only the hand-written S6 edit surfaces it.

## R6 · spec section 2.1 P1 vs P4 (`rust/ = the 19 ... and no other crate`) · important · CONFIRMED (mechanism) / READ (application)

**The manifest-level local-path closure of the 19 seed packages is 30 packages, and a path dependency that is optional AND disabled must still exist on disk or `cargo metadata` / `cargo build` fail. P1 (`cargo metadata --locked`, `cargo test --locked`) and P4 ("no other crate") collide unless every retained manifest is pruned first.**

Trigger: `cargo metadata --locked` in an assembled `rust/` tree containing only the 19.

Proof of mechanism — synthetic workspace in the scratchpad, one optional path dep whose directory does not exist, feature OFF:

    $ cargo metadata --offline --format-version 1        # full resolve
    exit=101
    error: failed to get `ghostdep` as a dependency of package `probe-main v0.1.0 ...`
    Caused by: failed to load source for dependency `ghostdep`
    Caused by: Unable to update ...\cargotest\ghostdep

(`--no-deps` succeeds; the spec's P1 uses plain `cargo metadata --locked`, which resolves.)

Proof of application — path deps declared by the retained manifests, from my closure tool:

    === ALL LOCAL PACKAGES IN CLOSURE (30) ===   (seeds = the spec's 19)
    extra: ptyctl, xai-crash-handler, xai-fast-worktree, xai-file-utils, xai-grok-auth,
           xai-grok-pager-pty-harness, xai-grok-plugin-marketplace, xai-grok-sandbox,
           xai-grok-update, xai-grok-voice, xai-hooks-plugins-types
    === dev/build edges ===
      [dev] crates/zer0-v2-bin            -> ptyctl (crates/codegen/ptyctl)
      [dev] crates/codegen/xai-grok-pager -> xai-grok-pager-pty-harness

Nine of the eleven are declared `optional = true` in `crates/codegen/xai-grok-pager/Cargo.toml` (lines 93-146) and never activate in the release graph — which is why they are absent from `zer0-v2.d` and from `cargo tree`. They still have to exist, or be pruned out of the manifest. Section 3 line 174 does say "every retained manifest pruned of unused deps/features/targets/benches/dev-deps", so the plan has an answer; what it does not have is the statement that P4's "19 packages" is only true AFTER a substantial edit to a vendored third-party-shaped manifest, nor an acknowledgement that `cargo metadata --locked` in S0 (against the unpruned source workspace) and in S3b (against the pruned copy) measure two different graphs.

## R7 · spec section 3 line 174 ("pruned of ... dev-deps") vs P1 (`cargo test --locked`) · important · READ

**Pruning dev-dependencies deletes the ConPTY test — the one test class this project's history says is load-bearing — and the spec never says so.**

Trigger: remove `ptyctl` from `crates/zer0-v2-bin/Cargo.toml` `[dev-dependencies]` per the pruning rule.

Proof: `crates/zer0-v2-bin/Cargo.toml` declares `ptyctl = { path = "../codegen/ptyctl" }` under `[dev-dependencies]`, and exactly one test uses it:

    $ grep -rln "ptyctl\|portable_pty" crates/zer0-v2-bin/tests/
    crates/zer0-v2-bin/tests/conpty_ui.rs

The four Rust integration tests are `conpty_ui.rs`, `host_lifecycle.rs`, `room_dependency_closure.rs`, `transport_protocol.rs`. Keeping `ptyctl` violates P4's "no other crate"; dropping it silently removes the ConPTY test from `cargo test --locked`, which then still exits 0 — a green suite that no longer covers the terminal. This is the recurrence pattern the lens warns about: the failure lands on the feature a dedicated spike de-risked.

## R8 · spec section 2.1 P7 plus S7 (`RoomHost.shutdown() calls disposeAllPtySessions()`) · important · CONFIRMED

**In the default configuration the room opens no PTY that `disposeAllPtySessions()` knows about, so "opened and closed PID sets match" is satisfied by the empty set; the one PTY a real turn does open is agy's, outside that registry.**

Trigger: any acceptance run with `ZER0_ACP` unset (the default, and what S5/S8 will run).

Proof — the dispatch branch order in `src/chat/dispatch-headless.ts`:

    :85  if (acpTransportEnabled() && input.agent !== "gemini") return dispatchAcpHeadless(input, onChunk);
    :87  if (input.agent === "claude") return dispatchPty(input);
    :91  if (input.agent === "codex" && process.env.ZER0_CODEX_NO_PTY !== "1") return dispatchPty(input);
    :92  return sharedRegistry.dispatch(input);

`acpTransportEnabled()` is `process.env.ZER0_ACP !== "0"` (`dispatch-acp.ts:40`), so with ACP on, claude and codex never reach `dispatchPty` and the registry that `disposeAllPtySessions` (`pty-session-registry.ts:76`) drains stays empty. gemini falls through to `sharedRegistry.dispatch` -> `registry.ts:57 gemini: dispatchAgy` -> `agy.ts:330 runAgyOnce({ ..., spawn: spawnAgyPty })` -> `agy-pty-spawn.ts:35-36 pty.spawn(cmd, args, ...)` — a ConPTY child created and killed by `runAgyOnce`'s own turn-cap/abort, never registered with `pty-session-registry`. P7 claims "every PTY session it opened"; the named mechanism covers a set that is empty in the default path and excludes the only PTY actually opened.

## R9 · spec section 3 line 175 (retained closure) plus decision 4 / S10 · important · READ

**The whole PTY transport is retained but reachable only through `ZER0_ACP=0`, which the spec itself reports broken on a sidecar-only machine and defers to a decision-gated slice.**

Trigger: any user on a clean machine following the README.

Proof: the static chain exists — `zer0-v2-host.ts -> room-host.ts -> headless-turn.ts -> dispatch-headless.ts -> dispatch-pty.ts -> pty-session-registry.ts` — but per R8 the runtime branch is taken only when `ZER0_ACP=0`, and decision 4 states that fallback is "broken on a sidecar-only machine". So `dispatch-pty.ts`, `pty-session.ts`, `pty-session-registry.ts`, `pty-session-errors.ts`, `pty-binding.ts`, `pty-binding-reader.ts`, `pty-transcripts.ts` and `adapters/pty/exe-resolver.ts` ship in a repo advertised as "only what V2 needs to build and run", reachable by no working configuration. That may be an acceptable scope call — but the spec presents S10 as optional polish rather than as the thing that makes roughly eight retained modules reachable.

## R10 · spec S6(c) ("bootCatchUp runs after initialize for the resolved project root") · important · READ

**`bootCatchUp` needs a project id that does not exist at `initialize` time.**

Trigger: implement S6(c) literally.

Proof: `src/memory/digest-runner.ts:138` — `export async function bootCatchUp(repoRoot: string, dbPath: string, projectId: string, spawnFn = realSpawn)`. `repoRoot` and `dbPath` are available at process start (`zer0-v2-host.ts:438-443`), but `projectId` is produced only inside `AliveRoomHost.create` by `resolveBootLiveness(bootDb, options.repoRoot)` (`room-host.ts:117-124`), which first opens the DB and then requires "an exclusive scoped project liveness lock". At `initialize` there is no room, no open DB and no lock; the host's `initialize` handler (`zer0-v2-host.ts:242-247`) only sets a flag and returns capabilities. Placing the catch-up there needs either a second project-id resolution path (a new DB open competing for the same lock) or a move to `session/new`.

## R11 · spec S6(a) plus `src/memory/digest-runner.ts:30-33` · important · READ

**The digest child's entry path is computed by ancestor count, and the child is spawned detached with `stdio: "ignore"` and unref — so a wrong path after packaging produces no error anywhere, only a missing journal row.**

Trigger: the packaged sidecar layout, where the compiled file does not sit three directories below the repo root.

Proof:

    digest-runner.ts:30  const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    digest-runner.ts:31  const ENTRY = path.join(REPO_ROOT, "scripts", "digest-run.ts");
    digest-runner.ts:32  const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules", "tsx", ...)).href;
    digest-runner.ts:115 options: { detached: true, stdio: "ignore", windowsHide: true, cwd: tmpdir(), env: digestChildEnv() }

S6(a) prescribes "resolved by the runner relative to `import.meta.url`, no source-root/TSX assumption". `import.meta.url` plus three `".."` segments IS the source-root assumption; the property that holds across layouts is sibling resolution (the entry beside the runner in the same compiled tree). As written, the sentence can be implemented and still be wrong, and P6's only witness is a journal row that silently does not appear. S6(d)'s "integration test through the packaged launcher" is the single guard against this — worth saying so explicitly.

## R12 · spec P4 ("no .council/") plus section 3 line 187 (.gitignore) · important · CONFIRMED

**Every V2 session writes `.council/runs/<sessionId>/...` and `.zer0/leases/...` into the project root; the spec's `.gitignore` list covers neither.**

Trigger: run the room once in the new repo (dogfooding, which the plan does at S5/S8).

Proof — files created by the single live session I drove, excluding `.git`:

    .council/runs/chat-1786904547372-.../room-events.jsonl
    .council/runs/chat-1786904547372-.../transcript.json
    .council/runs/chat-1786904547372-.../zer0-v2-room.json
    .zer0/evidence.db
    .zer0/evidence.db-shm
    .zer0/evidence.db-wal
    .zer0/leases/digest-lane-6822...c17.lock
    README.md

Written by `session-store.ts:18,44-50` (`.council/runs` plus prompts/responses/stderr dirs) and `zer0-v2-host.ts:562-567` (`markV2Session`). Section 3's `.gitignore` names `.zer0/state.json`, `.zer0/evidence.db*`, `dist/`, `rust/target/`. The current repo's `.gitignore` does cover `.council/runs/` (line 29) and `.zer0/*` (line 16) — the new list is a narrowing. P4's "no `.council/`" is true of the tracked tree at S4 and false of the working tree the moment the room runs.

## R13 · `src/room/zer0-v2-host.ts:570-579` (isV2Session) · nit · CONFIRMED

**A session whose marker file is missing or unparsable disappears from `session/list` and is rejected by `session/load`, with no error surfaced to the user.**

Trigger: the marker `.council/runs/<id>/zer0-v2-room.json` is deleted, or `.council/` is cleaned.

Proof:

    zer0-v2-host.ts:268   if (!(await isV2Session(this.repoRoot, sessionId))) return undefined;   // list: silently dropped
    zer0-v2-host.ts:310   if (!(await isV2Session(this.repoRoot, sessionId))) throw invalidParams("sessionId is not a Zer0 V2 room");
    zer0-v2-host.ts:570-578  try { ...JSON.parse(readFile(marker)) } catch { return false; }

Combined with R12 (the marker lives under a directory the new `.gitignore` no longer names, and that a "clean folder" instinct invites deleting), the room's session picker can empty out while every row still exists in the database. Traced user-action to visible result: the user sees "no sessions", not "marker missing".

## R14 · `crates/zer0-v2-bin/src/lib.rs:13-14` · important · READ

**A second, dead room UI ships with the package-level allow-list: nine files under `crates/zer0-v2-bin/src/ui/` behind a non-default feature literally named "quarantined".**

Trigger: an agent or contributor opening the new repo and reading `crates/zer0-v2-bin/src/ui/model.rs`, which contains plausible `zer0/room/submit`, `control` and `permission_response` call sites (lines 147-171).

Proof:

    lib.rs:10  #[cfg(feature = "grok-pager-room")]      pub mod pager_room;
    lib.rs:13  #[cfg(feature = "quarantined-local-ui")] pub mod ui;
    Cargo.toml [features] default = ["grok-pager-room"]
    Cargo.toml comment: "Migration evidence only. This is intentionally non-default and does not
                         participate in the Zer0 CLI entrypoint; the production surface is the pager."

None of `src/ui/*.rs` appears among the 292 inputs of `zer0-v2.d`; the six compiled `zer0-v2-bin` files are `cli.rs, host_process.rs, lib.rs, main.rs, pager_room.rs, transport.rs`. Section 3 promises manifests "pruned of unused ... features" but never names this one, and P4's allow-list is path-based, so the quarantined UI travels into a repo whose stated goal is agent-navigability.

## R15 · spec section 2.4 row F (G-F scope) · nit · READ

**G-F is Node-only; a working Rust reachability guard already exists and the spec does not mention it.**

Proof: `crates/zer0-v2-bin/tests/room_dependency_closure.rs` shells `cargo tree -p zer0-v2-bin -e normal` and asserts (a) that Grok's service crates (`xai-grok-shell`, `xai-grok-agent`, `xai-grok-auth`, `xai-grok-telemetry`, `xai-grok-update`, `xai-grok-voice`, `xai-grok-plugin-marketplace`, `agent-client-protocol`, `xai-acp-lib`) are absent from the activated graph, and (b) positively that `xai-grok-pager` and `xai-grok-pager-render` are present — deliberately an activation check rather than a manifest string match ("optional dependencies can be present in a package manifest without entering the activated Zer0 release graph"). Its `workspace_manifest()` walks `CARGO_MANIFEST_DIR.ancestors().nth(2)`, which still resolves correctly at `rust/crates/zer0-v2-bin`. This is the standing sweep the reachability discipline asks for, on the half G-F does not cover.

---

## Checks that came back CLEAN

- **RPC surface has no orphan method.** All 13 methods the host implements have a real Rust caller: `initialize`, `session/list`, `session/new`, `session/load` (`cli.rs:226-268`, `pager_room.rs:397`), `zer0/room/catalog` (`pager_room.rs:180`), `submit` (`:413`), `control` (`:425`), `mode_cycle` (`:417`), `models` (`:370`), `model_select` (`:386`), `permission_response` (`:429`), `resync` (`host_process.rs:447,615`), `shutdown` (`host_process.rs:774`). No handler is unreachable from the terminal, and no Rust call names a method the host does not implement.
- **The carrier — and therefore the memory read path — IS wired in the room.** My first hypothesis was that `initCarrierRuntime` lived only in the Ink boot; the tree refuted it: `src/room/room-host-support.ts:16,35` calls it inside `initializeRoomSession`, with `lanesEnabled` defaulting to true (`lane-transport.ts:128`). So `headless-turn.ts:392`'s gate can pass, and `lane-carrier.ts:213 composeBriefing` -> `briefing.ts:103 readByProject` -> `journal_entries` is genuinely reachable for operator-origin lanes (`room-host.ts:393,400` attach `CHAT_GRANT`). The digest's rows will have a reader.
- **`journal_entries` has retained readers.** `briefing.ts:103` and `router.ts:37` are both inside the 178; the non-retained readers (`anchors.ts`, `projections.ts`) are the ones decision 5 records.
- **The digest child will not hit schema drift.** `scripts/digest-run.ts:80` uses `openMemoryDb`, and `MEMORY_VERSION_KEYS` (`db.ts:78-88`) includes `LANE_SCOPE_KEY` = `14,15,16,20`, the set the room actually produces (R4).
- **The Rust compiler-closure counts in section 1 check out.** `zer0-v2.d` contains exactly 292 `.rs` inputs; grouping by directory gives 14 packages under `crates/` (2 plus 12 codegen), `prod/mc/cli-chat-proxy-types`, and four `third_party/` crates — no file from `crates/build` or `crates/common`, which exist in the source tree but are correctly excluded.
- **Node closure reproduction.** My independent closure equals `closure-181-repo.txt` exactly (diff empty), so section 1's "closure (181)" is sound as a compile-time statement.

## What I did NOT test

- I did not run `npm run gates`, `npm ci`, or `cargo test` on either tree. R2, R3, R6 and R7 are predictions from configuration and dependency facts, each with the file:line that drives them.
- I did not exercise a live three-agent turn, so P2 and P11 are untested here; the room boot in R4 stopped at `session/new` plus the boot status events.
- Runtime reachability beyond the branches quoted in R8 and R9 was read, not executed — no agent was dispatched.
- Nothing under `D:\Zer0 Chat V2` was modified except the creation of this report file; no git state-changing command was run anywhere.
