1. **EXTRACTION**

BLOCK: current code still has split truth. `schema.sql` says SQLite owns chat state and `transcript.json` is derived, but `loadSession` reads `transcript.json` and `persistSession` writes it before best-effort DB mirroring: `src/evidence/schema.sql:275-289`, `src/chat/session-store.ts:65-80`, `src/chat/evidence.ts:124-153`.

MVP digestion trigger:
- Exit hook: `runChatTui` already has a `finally` that shuts bridge/pty/db on every exit path; add `await digestSession(active.boot.session.id)` before `active.bridge.shutdown()` while DB is still open, with timeout/fail-soft: `src/cli/commands/chat-tui.ts:117-125`.
- `/new`: not implemented. `control-commands.ts` explicitly says `new` lands later and the live command union excludes it; `/help` says `/new is coming next`: `src/chat/control-commands.ts:13-18`, `src/tui/control-execute.ts:57-65`. MVP must add `/new` as a session-swap like `/resume`, not pretend the hook exists.
- Lazy boot: before `buildMount` resolves/creates the boot session, scan prior `chat_sessions` / transcripts for `digest_status != done`; current boot already centralizes session selection in `resolveBoot`: `src/cli/commands/chat-tui.ts:64-73`, `src/cli/commands/chat-tui.ts:224-257`.

Watermark:
- Add `chat_session_digests(session_id PK, project_id, digest_through_message_id, digest_through_created_at, status, attempts, error, updated_at)`.
- Use message IDs from `ChatMessage.id` and `chat_messages.id`: `src/chat/types.ts:87-97`, `src/evidence/schema.sql:291-303`.
- Do not use `summary_through_turn`; that field exists but only supports one rolling summary, not exact crash-safe extraction watermark: `src/evidence/schema.sql:287-288`.

Who extracts:
- Cockpit conductor owns extraction. A cheap subscription CLI pass is acceptable, but its output is untrusted proposal data, never canonical instruction. Existing headless dispatch proves subscription adapters can be invoked from cockpit code: `src/chat/headless-turn.ts:184-224`.
- Cost control: digest only undigested messages, cap input chars, one pass per session close or lazy boot, Zod-parse strict JSON, max 2 retries, then `status=failed` and reuse prior memory. This matches the existing fail-soft evidence posture: `recordTurnEvidence` catches and never breaks chat: `src/chat/turn-evidence.ts:119-165`.

Schema:
- Extend existing `.zer0/evidence.db`, not a second DB. Config default is `.zer0/evidence.db`: `src/shared/config.ts:16-18`; schema is already v13 memory/evidence ledger: `src/evidence/db.ts:16-18`, `src/evidence/migrations-v13.ts:18-27`.
- Reconcile D1 as: physical per-project DB means the repo-local `.zer0/evidence.db` is the project brain. The existing `projects.project_id` stays as defense-in-depth and moved-root support, not the only isolation boundary.

New tables:
- `chat_facts(fact_id PK, project_id, text, kind, source_session_id, source_message_ids_json, confidence, pinned, superseded_by, created_at)`.
- `chat_decisions(decision_id PK, project_id, text, kind, source_session_id, source_message_ids_json, confidence, pinned, superseded_by, created_at)`.
- Add FTS5 mirrors for both. FTS5 is already used in schema and v13: `src/evidence/schema.sql:228-232`, `src/evidence/migrations-v13.ts:190-193`; installed runtime was verified with `CREATE VIRTUAL TABLE ... fts5`.

2. **RECALL**

MVP retrieval should be both:
- Recency: last N pinned/high-confidence facts and decisions for this `project_id`.
- FTS5 keyword: query terms from current operator turn, scoped first by joining base table on rowid and `project_id`.

Do not use embeddings/sqlite-vec in MVP. The spec says sqlite-vec is not required and deferred: `docs/specs/2026-06-29-shared-brain-memory.md:56-62`, `docs/specs/2026-06-29-shared-brain-memory.md:122-128`.

Injection path:
- Real cockpit lanes use `headless-prompt.ts`, not `prompt-builder.ts`. The current prompt is an 8-message tail capped at 24k chars: `src/chat/headless-prompt.ts:14-18`, `src/chat/headless-prompt.ts:67-75`.
- Therefore MVP must add memory injection to `composePrompt`, or wrap it from `runOneLane` before `writePromptFile`: `src/chat/headless-turn.ts:189-193`.
- `prompt-builder.ts` already has the better budgeter and memory section, but it is not the default cockpit path. It loads `compileMemory` with `relevantPaths: []`, limiting current usefulness: `src/chat/prompt-builder.ts:77-103`, `src/chat/prompt-builder.ts:260-273`.

Budget:
- Reuse `prompt-budgeter.ts` concepts, but add a smaller headless budget: e.g. 1,200-2,000 tokens for `# Project Memory`; current budgeter trims memory before transcript: `src/chat/prompt-budgeter.ts:10-16`, `src/chat/prompt-budgeter.ts:36-49`.
- Same memory for all three agents by default. Tailoring per agent is deferred; identical context is needed for the acceptance test.

`/recall`:
- Add local control command. It should not dispatch to agents; current control plane already keeps `/resume`, `/status`, etc. local: `src/tui/cockpit.tsx:101-156`.
- Surface as a local turn containing top scoped facts/decisions with source session IDs. No model call on read path.

3. **GUARDS**

Session poisoning:
- Extracted rows start `confidence < threshold` unless pinned or corroborated; injection filters pinned/high-confidence only.
- Supersession is explicit via `superseded_by`; never hard-delete.
- Frame all injected memory with `delimitUntrusted`; it already neutralizes fake delimiters: `src/memory/untrusted-framing.ts:8-13`, `src/memory/untrusted-framing.ts:32-37`.
- Operator-pinned `/remember` rows can bypass confidence but still remain untrusted prompt data.

Cross-project leak:
- Every new table carries `project_id`.
- Use `resolveProjectId` from repo root before writes/reads: `src/memory/project-scope.ts:152-171`.
- Add new tables to the scoped-query whitelist or create a new scoped recall module with the same fail-closed behavior: `src/memory/scoped-query.ts:12-27`, `src/memory/scoped-query.ts:60-87`.

Token bloat:
- Hard cap recall rows and tokens.
- Rank pinned > decision > recent fact > older fact; decay unpinned facts after 30-60 days unless re-mentioned.
- Inject source/age/confidence, not raw transcript excerpts.

Confirm-lessons:
- Facts/decisions auto-write. Behavior-steering lessons must produce a cockpit local confirmation turn, not auto-injection.
- Existing curation only exposes accepted decisions: `src/memory/curation.ts:21-25`, `src/memory/curation.ts:56-71`. Extend that pattern for lessons.

4. **MODULE MAP + MVP CUT**

New files:
- `src/chat/memory-digest.ts` <250 lines: digest orchestration, watermark, retry/failure.
- `src/chat/memory-recall.ts` <250 lines: scoped recency + FTS5 recall, prompt rendering.
- `src/chat/memory-control.ts` <180 lines: `/remember`, `/recall`, `/new` control outcomes if `control-execute.ts` would exceed line budget.
- `src/evidence/migrations-v14.ts` <250 lines: digest/fact/decision tables + FTS5 + indexes.
- Tests colocated: real SQLite, no mocks except extractor seam.

Modified:
- `src/evidence/db.ts`: expected schema v14.
- `src/evidence/migrations.ts`: apply v14.
- `src/chat/headless-prompt.ts`: accept a pre-rendered memory block or use a composer wrapper.
- `src/cli/commands/chat-tui.ts`: exit digest + lazy boot digest + `/new` swap.
- `src/chat/control-commands.ts`, `src/tui/control-execute.ts`, `src/tui/cockpit.tsx`: `/remember`, `/recall`, `/new`.

In MVP:
- Digest prior conversation content into scoped `chat_facts` / `chat_decisions`.
- Lazy digest undigested transcripts on next boot.
- Inject scoped memory into all three agents on open/turn.
- `/remember` pins, `/recall` local query.
- Acceptance test: prior “vibecoding jobs” discussion is recalled in a new thread by claude/codex/gemini prompt files.

Deferred:
- sqlite-vec / embeddings.
- Native CLI resume/precompact hooks.
- Shared-across-projects memory.
- Full editor UI.
- Bi-temporal graph beyond `superseded_by`.

Build order:
1. v14 schema + scoped query tests.
2. Digest watermark + extractor seam with RED/GREEN fixture transcript.
3. Recall renderer + headless prompt injection for all three prompt files.
4. TUI controls: `/remember`, `/recall`, `/new`.
5. E2E: close/reopen/lazy-digest acceptance test.

5. **RISKS**

1. Poisoned extraction becomes permanent.
Guard: untrusted framing, confidence gate, source_message_ids, supersession, pinned-only override.

2. Cross-project leak through old session rows.
Guard: physical repo-local DB plus required `project_id`; fail-closed recall when `resolveProjectId` is unscopable.

3. Digest never runs on crash/kill.
Guard: watermark table; lazy boot scans `status != done`; extraction failure records `failed` and retries later without blocking chat.

Verification: read-only only. I inspected the current code/specs and ran a local FTS5 runtime check. No code was changed. Residual risk: I did not run the full test suite; this is an architecture consult, not an implementation pass.

