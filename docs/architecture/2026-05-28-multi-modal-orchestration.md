# Multi-Modal Orchestration Architecture

**Date:** 2026-05-28
**Status:** Phase 1 plan — drafted in session 2026-05-27/28 (claude orchestrator + codex/gemini council)
**Scope:** SYSTEM-LEVEL
**Companion:** `docs/architecture/buildPacketWorkflow.md` (existing workflow architecture, still canonical for packet-level work)
**Purpose:** Comprehensive next-session brief so future-claude/codex/gemini does NOT rediscover what's already built. Read this BEFORE any code work.

---

## TL;DR (10 lines)

1. zer0-agent-ci has ~17,000 LOC of pipeline infrastructure (Temporal + adapters + evidence + observability + chat). **Most of what I was about to draft already exists in Temporal.**
2. `buildPacketWorkflow` already has mode signals (`auto`/`semi`/`full`), cancel/approve/reject signals, two-pass-audit-per-phase, commit-before-review, lease/concurrency, retry, persist-phase-transition, post-commit-documentation.
3. `generate-fix-brief.ts` activity is the SAME brief structure I hand-crafted ~10× this session. Reuse, don't reinvent.
4. **Chat product (shipped this session) does NOT bridge to Temporal.** It dispatches directly through adapters. This is the biggest architectural gap.
5. User wants: **modes** (manual/auto/audit/research/brainstorm/council) × **quality knob** (mvp/production/L7), auto-detected from prompt or explicit `/mode`/`/quality` commands.
6. Decisions locked: writer-never-reviews-own-draft, ground-in-code-before-any-plan, builder-escalation-rights, user-as-tie-breaker, lead-by-class (not claude-default).
7. Banned behavior #10 in `ROUND_TABLE.md` already prohibits "over-specifying builder prompts." Was violated 10×/this session.
8. Phase 1 = bridge chat→Temporal + 3 small protocol docs (not 5) + quality knob (`gate-mvp.mjs`) + tight role file trim. NOT a fresh greenfield.
9. Keep diagnostic CLI commands (cost/diagnose/doctor/findings/inspect/mandates/replay/trace) — user won't use them but "in case."
10. Pre-flight: READ section 2 files before doing ANYTHING. Then section 3. Then propose.

---

## 2. Pre-flight — READ THESE FIRST (next session)

These files are the source-of-truth. Read in this order before touching anything:

| Order | File                                                                                        | Why                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | `docs/architecture/2026-05-28-multi-modal-orchestration.md`                                 | This doc                                                                                                 |
| 2     | `docs/architecture/buildPacketWorkflow.md` (was `docs/ARCHITECTURE-buildPacketWorkflow.md`) | Existing workflow architecture; modes already in here                                                    |
| 3     | `ROUND_TABLE.md`                                                                            | Source-of-truth for agent role files. Already has banned-behavior-10 ("over-specifying builder prompts") |
| 4     | `src/temporal/workflows/build-packet.ts`                                                    | The workflow. Has mode signal already.                                                                   |
| 5     | `src/temporal/activities/generate-fix-brief.ts`                                             | The brief structure I hand-crafted. Already implemented as a deterministic Temporal activity.            |
| 6     | `src/temporal/activities/escalate.ts`                                                       | Escalation primitive                                                                                     |
| 7     | `src/temporal/activities/dispatch-review.ts`                                                | Cross-family review primitive                                                                            |
| 8     | `src/temporal/activities/dispatch-agent-activity.ts`                                        | Agent dispatch primitive (workflow-side)                                                                 |
| 9     | `src/temporal/manifest/loader.ts` + `schema.ts` + `semantic-validators.ts`                  | Packet manifest format — drives phase order                                                              |
| 10    | `src/chat/dispatch-service.ts`                                                              | Current chat dispatch path (bypasses Temporal)                                                           |
| 11    | `src/cli/commands/build.ts`                                                                 | How packet builds are invoked today                                                                      |
| 12    | `.council/cross-model/codex-council-response.md` + `gemini-council-response.md`             | Council perspective from this session                                                                    |
| 13    | This session's chat history (transcripts in `.council/runs/chat-*/`)                        | Full architecture conversation                                                                           |

**Do not skip these.** The #1 failure mode in this session was building on top of an unexamined codebase. The cure is reading first.

---

## 3. Complete infrastructure inventory (what's BUILT)

### 3.1 LOC by module

| Module              | LOC         | Test LOC    | Status                                                                                         |
| ------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `src/temporal`      | 5,860       | substantial | BUILT, USED for `zer0 build <packet>`                                                          |
| `src/chat`          | 2,857       | minimal     | BUILT THIS SESSION — does NOT bridge to Temporal                                               |
| `src/cli`           | 2,768       | substantial | 21 commands — see 3.4                                                                          |
| `src/evidence`      | 2,180       | substantial | SQLite + blobs + queries. K1 (chat_sessions/chat_messages) just added                          |
| `src/shared`        | 1,904       | substantial | types, errors, error-codes, crypto, logger, config                                             |
| `src/adapters`      | 1,291       | substantial | claude/codex/gemini + registry + failover                                                      |
| `src/security`      | 439         | small       | denylist + entropy + prefilter (wired into chat this session via A1)                           |
| `src/gates`         | small       |             | build-gate + engine                                                                            |
| `src/observability` | substantial |             | OTel + replay + state-writer + lessons-reader + agent-guide + fingerprint + inspect + tracking |

**Total:** ~17,500 LOC of production code + tests.

### 3.2 Temporal workflows (the engine)

`src/temporal/workflows/`:

| File              | Purpose                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build-packet.ts` | THE workflow. ~640 LOC. Phases driven by manifest. Modes: `auto`/`semi`/`full`. Signals: cancel/approve/reject/mode/humanInterventionResolved. Query: status. Patches: two-pass-audit-per-phase, commit-before-review, tracking-files-canonical. |
| `pipeline.ts`     | Legacy pipeline workflow (per memory `project_pipeline_slice_vs_full_2026_05_09` — only BUILD+REVIEW slice). Other 11 activities are stubs.                                                                                                      |
| `patches.ts`      | Workflow patch helpers                                                                                                                                                                                                                           |

### 3.3 Temporal activities (18 of them)

`src/temporal/activities/`:

| Activity                       | What it does                                                                           | Relevance to new architecture                          |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `analyze-packet.ts`            | Post-build lessons extraction                                                          | Already exists — reuse                                 |
| `commit.ts`                    | Atomic git commit per phase                                                            | Already exists — reuse                                 |
| `context-compiler.ts`          | Hot+warm+cold context assembly per dispatch                                            | The "real-time memory" primitive — already built       |
| `diff-compiler.ts`             | Per-attempt diff capture                                                               | Reuse                                                  |
| `dispatch.ts`                  | Generic dispatch primitive                                                             | Reuse                                                  |
| `dispatch-agent-activity.ts`   | Agent dispatch (codex/gemini/claude) workflow-side                                     | THIS is where the bridge plugs in                      |
| `dispatch-review.ts`           | Cross-family review activity                                                           | Cross-family ALREADY enforced; chat needs to call this |
| `escalate.ts`                  | Escalation primitive                                                                   | Builder-escalation-rights already plumbed              |
| `evidence.ts`                  | Persist evidence rows                                                                  | Reuse                                                  |
| `gate.ts`                      | Run gate scripts (typecheck/lint/biome/tests)                                          | Reuse                                                  |
| `generate-fix-brief.ts`        | **Generates structured fix briefs with SAME sections I hand-crafted 10× this session** | **REUSE THIS — do not redraft Design Claim Card**      |
| `lease.ts`                     | Concurrency control (one workflow per packet)                                          | Reuse                                                  |
| `load-manifest-activity.ts`    | Loads packet manifest (phases, ownedFiles, gates)                                      | Reuse                                                  |
| `memory-compiler.ts`           | Cross-run findings + cross-packet lessons (packet-12b)                                 | The "memory" primitive — already built                 |
| `persist-phase-transition.ts`  | Atomic phase state writes                                                              | Reuse                                                  |
| `post-commit-documentation.ts` | Updates ADRs + module-map after commit                                                 | Reuse                                                  |
| `preflight.ts`                 | Pre-build validation (expected ADRs, map rows)                                         | Reuse                                                  |

### 3.4 CLI commands (21 of them)

`src/cli/commands/`:

**Core (KEEP, actively used):**

- `up.ts` — start Temporal worker
- `down.ts` — graceful teardown
- `build.ts` — kick off packet build via Temporal
- `chat.ts` — the chat REPL (shipped this session)
- `council.ts` — standalone parallel council (NOT chat slash)
- `status.ts` / `status-watch.ts` — workflow status
- `start.ts` — high-level task starter
- `resume.ts` — resume from failed phase
- `cancel.ts` — cancel running workflow
- `approve.ts` — approve a paused workflow (human-in-loop)

**Diagnostic (KEEP per user — "won't use but in case"):**

- `cost.ts` — token/$ cost report per run
- `diagnose.ts` — health diagnose
- `doctor.ts` — environment doctor
- `findings.ts` — query findings by severity
- `inspect.ts` — workflow run inspector
- `mandates.ts` — L5 mandate inspection
- `replay.ts` — replay a dispatch
- `trace.ts` — error-code trace lookup
- `stream.ts` — workflow event stream

**Dashboard:**

- `dashboard.ts` — workflow dashboard (with --demo + --replay modes)

### 3.5 Observability layer (largely untapped by chat)

`src/observability/`:

| File                            | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `agent-guide.ts`                | Generates AGENT-GUIDE.md for runtime context                       |
| `fingerprint.ts`                | Repo fingerprint for context-pack determinism                      |
| `inspect.ts`                    | Run inspection                                                     |
| `lessons-reader.ts`             | **Reads docs/lessons/ at dispatch time — already a learning loop** |
| `replay.ts`                     | Workflow replay                                                    |
| `state-writer.ts`               | **Writes live state — this is the "real-time memory" primitive**   |
| `stream.ts`                     | Event stream                                                       |
| `schemas/` + `schema-bundle.ts` | Event schemas                                                      |
| `tracking/`                     | Per-packet tracking files                                          |
| `with-meta.ts`                  | Metadata helpers                                                   |
| `otel/`                         | OpenTelemetry integration (per packet-11c)                         |

**Chat product touches NONE of this.** Chat persists transcript.json + chat_sessions/chat_messages (K1). It does NOT write to observability/state-writer or read from lessons-reader.

### 3.6 Evidence schema (post K1)

Tables (verified 2026-05-27 + 28):

- `runs` (workflow runs)
- `tasks` (per workflow task)
- `dispatches` (per agent invocation; includes argv_json, repo_commit, env_allowlist_version, context_blob_hash)
- `dispatch_claims` (concurrency claim records)
- `gate_transitions` (gate pass/fail with evidence)
- `findings` (P0/P1/P2 with FTS5)
- `events` (append-only event log)
- `errors` (append-only error log)
- `context_runs` + `context_items` (context-compiler outputs)
- `chat_sessions` + `chat_messages` (K1 — shipped this session)

Plus `idx_chat_messages_session_turn`, `idx_findings_path`, `idx_events_idempotency`, `idx_gate_transitions_unique`, `idx_dispatches_unique`, `idx_events_run_sequence_unique`.

Schema version: 8.

### 3.7 Role files + docs (current state)

- `ROUND_TABLE.md` — **526 lines**. Claims to be source-of-truth for CLAUDE/AGENTS/GEMINI.
- `CLAUDE.md` — 11KB. Hand-maintained (no generator exists).
- `AGENTS.md` — 11KB. Hand-maintained.
- `GEMINI.md` — 11KB. Hand-maintained.
- `docs/SPEC.md` + `SPEC-ADDENDUM.md` + `SPEC-v1-source.md` — spec documents
- `docs/PLAN.md` + `PLAN-CODEX.md` + `PLAN-teamwork-blueprint.md` — plan documents
- `docs/MODULE-MAP.md` — module map (per packet)
- `docs/HANDOFF.md` — project-level handoff
- `docs/ADR-buildPacketWorkflow.md` (referenced as `docs/architecture/buildPacketWorkflow.md`) — workflow architecture
- `docs/adrs/_system/` + `docs/adrs/packet-N/` — ADRs organized by scope
- `docs/lessons/` — lessons captured per session
- `docs/research/` — market/feasibility research
- `docs/plans/` — dated plans
- `docs/specs/` — dated specs

**Generator script:** NONE. Hand-sync only.

### 3.8 Scripts

`scripts/`:

- `adr-index-build.mjs` (+test) — builds an ADR index
- `gate-clamps.mjs` — function/file size + @depends validation
- `gate-l5-mandates.mjs` — L5 quality gate
- `diagnose/` — diagnostic utilities

`package.json` scripts:

- `dev` / `build` / `test` / `test:integration` / `test:watch`
- `typecheck` / `lint` / `lint:fix` / `format`
- `dep-check` / `dep-graph` / `dead-code` / `dead-code:fix`
- `gate-l5` (single L5 check) / `gates` (full pipeline)
- `spike:*` (5 spike scripts)

### 3.9 Adapters + dispatch primitives

- `src/adapters/{claude,codex,gemini,registry,types}.ts` — chat-layer dispatch
- `~/.claude/tools/dispatch.sh` — bash dispatcher used by orchestrator/non-Temporal flows. Per memory: ALWAYS via dispatch.sh, never direct CLI.
- `.codex/agents/{builder,auditor,researcher}.toml` — codex per-role configs
- `.codex/config.toml` — codex CLI memories + web_search=live
- `.gemini/settings.json` — gemini memory config

---

## 4. Architecture decisions made this session (LOCKED)

### 4.1 Modes (workflow choreography) × Quality (gate strictness)

Two independent dimensions:

**Modes (workflow):**

| Mode               | When                        | Workflow                                                                                                                            |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `manual` (default) | User wants direct control   | `@codex do X` — current chat behavior, dispatches direct via adapters (post-bridge: routes through Temporal as single-phase packet) |
| `auto`             | "Take this idea end-to-end" | Q&A → research → spec → spec-quality gate → plan → plan-vs-spec gate → build (Temporal pipeline) → ship                             |
| `council`          | "Get all 3 opinions"        | Existing `/council` slash — parallel dispatch + synthesis                                                                           |
| `audit`            | Existing codebase scan      | All 3 produce parallel audit findings → synthesis → action plan                                                                     |
| `research`         | Market/library scan         | gemini-led with web grounding                                                                                                       |
| `brainstorm`       | Design exploration          | iterative @-mention flow, no build yet                                                                                              |

**Quality (gate strictness):**

| Quality                | Triggers                                                                                              | Gates                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `mvp`                  | User says "quick", "mvp", "prototype", "vibe"                                                         | typecheck + lint only                                                                                                 |
| `production` (default) | Default for unspecified                                                                               | typecheck + lint + tests + biome + gate-clamps                                                                        |
| `l7`                   | User says "production-grade", "L7", "ship-quality", or change touches sandboxing/persistence/workflow | All of production + gate-l5-mandates + dep-check + dead-code + integration tests + cross-family review + ADR required |

**Auto-detection:** rule-based classifier reads user prompt + chat context. Explicit `/mode <name>` and `/quality <level>` override.

### 4.2 No-orchestrator-by-default

Chat IS the dispatch surface. User @-mentions agents directly. No meta-agent in front.

**Auto mode is OPTIONAL** — invoked by `/mode auto` when user wants the full pipeline.

When auto-mode runs, the lead per stage is per-class:

- Product/scope → claude
- Infra wiring → codex
- Research → gemini
- Tier-3 architecture → all 3 in parallel

### 4.3 Writer-never-reviews-own-draft

If claude wrote the brief → codex + gemini review.
If codex wrote → claude + gemini review.
If gemini wrote → claude + codex review.

User breaks ties when 2 reviewers disagree. Not any agent.

### 4.4 Ground-in-code-before-any-plan

Every Design Claim Card / brief MUST cite file:line for every claim about current state. No design from memory.

`generate-fix-brief.ts` already enforces a related discipline (loads phase, requires phase.ownedFiles, phase.requiredGates). Extend to require executionSpine citations.

### 4.5 Builder-escalation-rights

Builder can pause mid-implementation if they detect wrong-wire risk. Escalation flows to USER (not orchestrator who likely wrote the brief). `escalate.ts` activity already exists.

Format: brief-said / what-I-see (file:line evidence) / proposal / decision-needed.

### 4.6 Risk tiers (codex council proposal — adopted)

| Tier             | Triggers                                                                        | Required cycle                                                                 |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0 mechanical     | type/lint fix, rename, doc edit                                                 | gates only, sampled review                                                     |
| 1 local semantic | helper change, one-file refactor                                                | one builder + one post-commit cross-family review                              |
| 2 integration    | adapter argv, route resolution, persistence, migrations, retry/cancel, evidence | design claim + brief-review + impl + full affected gates + cross-family review |
| 3 architecture   | workflow, gate scripts, security, sandboxing, multi-system                      | independent proposals from all 3 → user synthesis → implementation packets     |

**Auto-raise triggers** (codex's list, adopted): sandbox/approval mode, adapter argv, route resolution, DB persistence, migrations, gate scripts, workflow transitions, retry/cancel, evidence ledger, OR any second failed attempt.

### 4.7 Lead-by-class (not claude-default)

| Class                                            | Lead              | Why                                                       |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------- |
| Product/UX/scope                                 | claude            | user-intent translation, scope synthesis                  |
| Infra wiring (adapters, persistence, sandboxing) | codex             | most low-level code in training; will be eventual builder |
| Research / library / best-practice               | gemini            | web grounding                                             |
| Architecture (Tier 3)                            | all 3 in parallel | high-stakes; pay 3x for independent proposals             |
| Mechanical (Tier 0)                              | any               | use whoever's fastest                                     |

---

## 5. The big finding: most "protocols" already exist

| What I was going to draft       | What's already built                                                                                                                                                                        | Action                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Design Claim Card schema        | `src/temporal/activities/generate-fix-brief.ts` — same sections (HARD CONSTRAINTS / OWNED FILES / FORBIDDEN FILES / FIX ITEMS / ACCEPTANCE / VERIFICATION COMMANDS / TESTS / OUTPUT FORMAT) | **Don't redraft. Extend generate-fix-brief to add executionSpine + knownWrongFixes fields. Reuse for chat path.**     |
| Escalation format               | `src/temporal/activities/escalate.ts`                                                                                                                                                       | **Read it. Document format. Maybe extend to chat.**                                                                   |
| Cross-family review enforcement | `src/temporal/activities/dispatch-review.ts`                                                                                                                                                | **Read it. Document. Chat doesn't currently use this — bridge.**                                                      |
| ADR template                    | `docs/adrs/_system/ADR-S-001-workflow-enforced-discipline.md` (sample)                                                                                                                      | **Already in use. Document as canonical template.**                                                                   |
| Risk tiers                      | NOT built                                                                                                                                                                                   | **Draft `docs/protocols/risk-tiers.md` — small file**                                                                 |
| Mode selector                   | `buildPacketWorkflow` has `modeSignal<"auto"                                                                                                                                                | "semi"                                                                                                                | "full">` | **Different from chat-modes I proposed. Reconcile. Workflow modes are intra-build; chat modes are workflow-choreography. Both can coexist.** |
| Quality knob                    | partial — `gate-l5` exists, no `gate-mvp` or `gate-production`                                                                                                                              | **Draft `scripts/gate-mvp.mjs` + `scripts/gate-production.mjs`. Add `npm run gate-mvp` + `npm run gate-production`.** |
| Two-pass audit                  | `REVIEW_PATCH = "v2-two-pass-audit-per-phase"` already in `build-packet.ts:32`                                                                                                              | **Already enforced. Document.**                                                                                       |
| Commit before review            | `COMMIT_PATCH = "v2-commit-before-review"`                                                                                                                                                  | **Already enforced. Document.**                                                                                       |
| Real-time shared memory         | `src/observability/state-writer.ts` + `src/temporal/activities/memory-compiler.ts` + `lessons-reader.ts`                                                                                    | **Built. Chat doesn't tap. Bridge.**                                                                                  |
| Banned-behavior enforcement     | `ROUND_TABLE.md` already enumerates 10 banned behaviors including #10 "over-specifying builder prompts"                                                                                     | **Already documented. Make it grep-enforceable via a `scripts/gate-banned-behaviors.mjs`.**                           |

---

## 6. The actual gap (small + specific)

**Gap #1: Chat ↔ Temporal bridge** (biggest)

Chat dispatches go through `src/chat/dispatch-service.ts` → `src/adapters/{codex,gemini,claude}.ts` → CLI directly. No workflow, no gate, no escalation, no fix-brief generation, no evidence beyond chat_sessions/chat_messages, no cross-family discipline.

`zer0 build <packet>` goes through `src/cli/commands/build.ts` → `buildPacketWorkflow` → activities → full discipline.

The bridge: when chat is in `/mode auto` (or system detects auto-classification triggers), the chat dispatch becomes a packet that goes through `buildPacketWorkflow`. The user keeps chatting; the workflow runs in background; chat shows live status via existing `status` query + signals.

**Concrete bridge work:**

1. `src/chat/auto-mode.ts` — new module. When chat dispatch is classified Tier 2+ or `/mode auto` is active, packetize the user's input → create manifest → trigger workflow via existing `runBuild` from `src/cli/commands/build.ts`.
2. Wire chat to subscribe to workflow's `statusQuery` + event stream. Chat surfaces phase progress.
3. Workflow's `humanInterventionResolvedSignal` / `approveSignal` plug into chat user-replies.
4. Workflow's escalate.ts pipes back to the chat session as a structured message.

**Gap #2: Greenfield Q&A flow** (the front-end of auto-mode)

Before packet build, the user idea needs to become a manifest. That's:

- Q&A (gemini — discovery)
- Market research (gemini — web)
- Spec draft (claude)
- Spec quality gate (codex + gemini review)
- Plan + manifest (codex)
- Plan-vs-spec gate (claude + gemini)
- → Hand to `buildPacketWorkflow`

This is the "auto mode" workflow. Probably a separate `src/temporal/workflows/greenfield-packet.ts` that produces the manifest-input for `buildPacketWorkflow`.

**Gap #3: Quality knob**

Three files to add:

- `scripts/gate-mvp.mjs` — `tsc --noEmit + biome check` only
- `scripts/gate-production.mjs` — current `npm run gates` minus integration tests + dead-code
- Existing `scripts/gate-l5-mandates.mjs` stays as `l7` quality

Add `npm run gate-mvp` / `npm run gate-production` to package.json scripts.

Workflow reads `manifest.qualityLevel` (new field) and routes to the right gate.

**Gap #4: Mode/quality auto-detection**

`src/chat/intent-classifier.ts` (new) — reads user prompt + recent chat context, outputs `{ mode: "manual"|"auto"|"council"|..., quality: "mvp"|"production"|"l7" }`.

Triggers:

- "quick", "mvp", "prototype" → quality=mvp
- "production", "ship-quality", "L7", "Google-level" → quality=l7
- "take this end-to-end", "build this app" → mode=auto
- "what do you think", "thoughts on" → mode=brainstorm
- "audit", "review the codebase" → mode=audit
- Sandbox/persistence keywords → quality=l7 (per auto-raise triggers)
- Default → mode=manual + quality=production

**Gap #5: Role file trim**

Move 80% of CLAUDE/AGENTS/GEMINI content into `docs/protocols/*.md`. Role files become identity + top-of-mind rules + pointer-to-protocols (~80 lines each instead of 11KB).

`ROUND_TABLE.md` becomes ~100 lines (identity + 6 invariants + pointers + the 10 banned behaviors as the only literal content).

Generator script: NOT building one. Drop the "do not hand-edit" claim. Hand-maintained 3 files is fine because they diverge naturally per agent.

---

## 7. Phase 1 plan (revised — small, bridge-focused)

**Total estimate: 8-12 hours of careful work split across 2-3 sessions.**

### 7.1 Read pre-flight (1 hour)

The 13 files in section 2. No edits. Just grounding.

### 7.2 Audit the existing primitives (1-2 hours)

Read these activities in depth + write a 1-page summary per:

- `generate-fix-brief.ts` — confirm sections, identify what to extend
- `escalate.ts` — extract format spec
- `dispatch-review.ts` — confirm cross-family enforcement
- `dispatch-agent-activity.ts` — understand the workflow-side dispatch
- `manifest/loader.ts` + `schema.ts` — understand packet structure
- `context-compiler.ts` — what context gets compiled per dispatch
- `memory-compiler.ts` — what memory gets injected
- `lessons-reader.ts` — how lessons feed dispatch

Write summaries to `docs/architecture/temporal-primitives-summary.md`.

### 7.3 Draft 3 (NOT 5) protocol docs (2 hours)

Only what's missing:

- `docs/protocols/risk-tiers.md` (per section 4.6)
- `docs/protocols/modes.md` (per section 4.1 — workflow choreography)
- `docs/protocols/quality-levels.md` (per section 4.1 — gate strictness)

The other 2 I had on the list (Design Claim Card, Escalation, Review Routing, ADR Template) all reduce to "see existing primitive at file:line". Document THIS in `docs/protocols/index.md` as a pointer index.

### 7.4 Build the bridge (3-4 hours)

`src/chat/auto-mode.ts` — packetize chat dispatch when auto-mode active. Wire to `buildPacketWorkflow` via existing `runBuild` infrastructure.

Tests: `src/chat/auto-mode.test.ts`.

### 7.5 Quality knob (1 hour)

- `scripts/gate-mvp.mjs`
- `scripts/gate-production.mjs`
- Update `package.json` scripts
- Add `qualityLevel: "mvp"|"production"|"l7"` to manifest schema (default production)
- `buildPacketWorkflow` reads it, picks gate

### 7.6 Intent classifier (1 hour)

`src/chat/intent-classifier.ts` — keyword-based. Outputs `{mode, quality}`. Used by chat to auto-select before dispatch.

Tests with sample prompts asserting expected classification.

### 7.7 Role file trim (1-2 hours)

- Read current `ROUND_TABLE.md` (526 lines)
- Identify duplicated content vs unique identity
- Extract duplicated to protocol files
- Trim ROUND_TABLE to ~100 lines
- Hand-sync CLAUDE/AGENTS/GEMINI to be ~80 lines each

Drop "do not hand-edit" claim in ROUND_TABLE header. Replace with "per-agent customization expected — keep identity + pointers in sync."

### 7.8 Validate (1 hour)

- `npx tsc --noEmit` clean
- `npm test` green (existing tests still pass)
- Live smoke: `zer0 chat "build me an mvp todo app"` → auto-detects mode=auto, quality=mvp → triggers Q&A flow (or packetization if simple enough) → user can override

### 7.9 Update memory + commit + handoff (30 min)

- New memory entry: this architecture + the bridge pattern
- Commit per phase (probably 4-6 commits)
- Update `docs/HANDOFF.md` for project-level continuity

---

## 8. Open questions (NOT decided this session)

1. **For Tier 3 parallel proposals (all 3 agents propose) — does user read 3 cards cold, OR does a 4th-pass synthesizer surface divergence only?** Synthesis bias risk vs user-time-cost.
2. **Does auto-mode require human approval gates between stages** (after Q&A, after research, after spec, after plan)? Or fully autonomous through-to-build with single approve-or-cancel at the end?
3. **Does `/mode audit` block until findings synthesized, or stream them as they come in?** Streaming feels right but commits us to an event-bus dependency from chat.
4. **The `--demo` and `--replay` flags on `dashboard.ts`** — what do they currently do? Worth understanding before designing auto-mode UI.
5. **Should the `pipeline.ts` workflow be deleted** (per memory `project_pipeline_slice_vs_full_2026_05_09`: only BUILD+REVIEW slice; rest stubs)? Or kept as the seed for auto-mode's pre-build stages (Q&A/research/spec/plan)?

---

## 9. User preferences captured (so next session doesn't relearn)

| Preference                                                                                   | Source                                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Auto-detect mode/quality from prompt, but allow explicit override                            | this session                                                                           |
| Keep diagnostic CLI commands even if unused — "in case"                                      | this session                                                                           |
| For dead/unused activities (generate-fix-brief): fresh implementation but borrow good parts  | this session                                                                           |
| Vibe-coder mode — will go with builder escalation evidence over orchestrator's design        | this session                                                                           |
| Don't bloat CLAUDE.md/AGENTS.md/GEMINI.md — keep tight                                       | this session                                                                           |
| L7 quality not always wanted — sometimes MVP                                                 | this session                                                                           |
| Ground in real code before designing — no memory-based plans                                 | this session                                                                           |
| User is the dispatcher in chat; no meta-orchestrator                                         | this session                                                                           |
| Cross-family review for all important decisions                                              | repeatedly                                                                             |
| Subscription CLI dispatch, not API                                                           | locked memory `feedback_subscription_first_no_sdk`                                     |
| `claude -p` switches to API credits 2026-06-15 — $200/mo included                            | locked memory `project_claude_p_api_credits_june_2026`                                 |
| ALWAYS via dispatch.sh, never direct CLI for codex/gemini                                    | locked memory `reference_codex_dispatch_pattern` + `reference_gemini_dispatch_pattern` |
| `claude -p --effort high` hangs on Windows piped stdio with complex prompts                  | locked memory `feedback_claude_p_headless_constraints`                                 |
| Cross-family review locked: codex builds → orchestrator (claude) reviews                     | locked memory `feedback_orchestrator_reviews_codex`                                    |
| NEVER within-family review for primary signal                                                | locked memory `feedback_no_within_family_review`                                       |
| Deep code-reviewer subagent on every codex build — not grep+spot-check                       | locked memory `feedback_deep_code_review_not_grep`                                     |
| Brief-file pattern (gitignored `.council/runs/fix-briefs/`) works for codex BUILD dispatches | session 2026-05-27                                                                     |
| Test before applying — no apply-without-testing                                              | locked memory `feedback_test_before_applying`                                          |
| HARD RULE: real E2E before phase transition                                                  | locked memory `feedback_phase_transition_real_e2e_required`                            |
| HARD RULE: falsifying test mandatory for static gates                                        | locked memory `feedback_falsifying_test_mandatory_for_gates`                           |

---

## 10. Lessons from this session (for the record + memory)

### 10.1 I violated banned behavior #10 ten times

`ROUND_TABLE.md` line ~131 lists banned behaviors. #10: "over-specifying builder prompts (giving near-complete pseudo-code)" with audit evidence "the builders implemented claude's design, not THEIR best design. they couldn't challenge the architecture."

Every fix-brief I wrote this session (Brief A through Brief I2) was near-complete pseudo-code. Codex implemented faithfully. Cross-family deep audit caught E2 theater — exactly because codex couldn't challenge my design.

**Memory candidate:** `feedback_round_table_banned_10_enforcement` — banned behaviors in ROUND_TABLE.md must be grep-enforced, not just listed.

### 10.2 The hand-crafted fix-brief pattern duplicated `generate-fix-brief.ts`

I built `.council/runs/fix-briefs/brief-A..brief-I2.md` by hand. The activity that does this deterministically already existed in `src/temporal/activities/generate-fix-brief.ts`.

Cause: I never read the activity. I never even checked if a fix-brief primitive existed before drafting.

**Memory candidate:** `feedback_check_existing_primitives_before_drafting`.

### 10.3 The dispatch path bypassed Temporal entirely

10 commits this session, zero went through buildPacketWorkflow. All went through chat → adapter → CLI. So:

- No `dispatches.argv_json` evidence
- No `gate_transitions` rows
- No fix-loop tracking
- No phase event persistence
- No lease/concurrency control

We had all this infrastructure. We didn't use any of it.

### 10.4 Rushing pattern

Caught explicitly by user 3 times this session:

- Council brief had Git Bash MSYS path bug (didn't pre-flight)
- Second council attempt hit .geminiignore (didn't pre-flight)
- Brief I1 BLOCKED itself because OWNED FILES didn't include dispatch-one-turn.ts created mid-session by Brief H

Fix: pre-flight checklist before every dispatch (path resolves? agents can read? output dir exists? quota?).

---

## 11. Existing memory entries to load on next session start

(These are already auto-loaded via memory system. Listed for completeness.)

- `MEMORY.md` index
- `feedback_orchestrator_reviews_codex.md` (cross-family review pattern)
- `feedback_no_within_family_review.md` (cross-family rule)
- `feedback_deep_code_review_not_grep.md` (subagent for review)
- `feedback_codex_brief_template_proven.md` (BUILD BRIEF format — same as generate-fix-brief activity!)
- `feedback_schema_discipline_migration_only.md` (DB migration rules)
- `reference_codex_dispatch_pattern.md` (dispatch.sh always)
- `reference_gemini_dispatch_pattern.md` (dispatch.sh always, modes)
- `reference_self_application_proof_2026_05_27.md` (this session)
- `feedback_subscription_first_no_sdk.md` (subscriptions)
- Plus 30+ other entries — see `MEMORY.md`

---

## 12. Commits this session (architecture-level reference)

| SHA       | What                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `0c5a0f7` | chore: gitignore `.council/runs/` + untrack runtime log                                                            |
| `a0b7f05` | feat(chat): zer0 chat v1+v2 snapshot — 15-file chat module + adapter chatMode + 3-model v2 audits                  |
| `53ae888` | fix(chat) Group A: 5 silent-failure fixes (prefilter wire, evidence classifier, EOF gracefulExit, lastCtrlC reset) |
| `baea85e` | fix(adapters) Group B: 3 parity fixes (chat≠research differentiation, build adds --effort, undefined→read-only)    |
| `c48b018` | feat(evidence) K1 schema v7→v8: chat_sessions + chat_messages tables                                               |
| `fea73b6` | fix(chat) Group E: BAD #11 anti-pattern fixes + F-d1 punctuation strip                                             |
| `e58b4ae` | feat(chat) K1 writes: chat_sessions + chat_messages now populated                                                  |
| `7f5703a` | fix(chat) Brief G: 7 quick fixes (diff persist, handoff swallow, types move, format)                               |
| `7664a14` | test(evidence): db.test.ts v7→v8 + K1 FK falsifying test                                                           |
| `765a47f` | refactor(chat) Brief H: controller.ts splits + dispatch-one-turn.ts extraction (F-c4 cycle break)                  |

**E2 theater** (the orchestrator-design-wrong-wire bug) is documented in cross-family audit responses at `.council/cross-model/codex-council-response.md` + `gemini-council-response.md`. NOT fixed (Brief I1 was BLOCKED, then quota ran out, then we pivoted to architecture work).

**Open fix briefs** (gitignored, drafted but not dispatched):

- `.council/runs/fix-briefs/brief-I1-adapter-tests-pipeline.md` — P0 pipeline regression + 5 broken adapter tests + E2 theater fix
- `.council/runs/fix-briefs/brief-I2-chat-layer.md` — 10 chat-layer P1/P2 fixes
- `.council/runs/fix-briefs/brief-K-backfill.md` — backfill historical chat-\* sessions into K1 tables
- `.council/runs/fix-briefs/council-dispatch-architecture.md` — the council brief that produced the architecture decisions

These should be either: (a) dispatched once codex quota restores, OR (b) rewritten as Design Claim Cards through `generate-fix-brief` activity once the bridge exists.

---

## 13. Banned phrases / behaviors to grep-enforce in next session

From `ROUND_TABLE.md` lines 137-154 (already enumerated):

Banned phrases in agent output:

```
TODO  FIXME  XXX  HACK
"placeholder"  "skeleton"  "mock implementation"
"for now"  "in the future"  "later"
as any  as unknown as
console.log  console.error  (production only)
"perfect"  "flawless"  "perfectly aligned"
"ultimate"  "compromise-free"  "bleeding edge"
"Great!"  "Excellent!"  "Awesome!"
```

Banned behaviors (1-10):

1. Building from memory instead of reading the spec
2. Writing a "focused subset" spec that drops requirements
3. Accepting P0 bugs as "risks"
4. Skipping cross-model review
5. Leading review prompts (giving reviewers your hunches)
6. Excluding files from review
7. Shipping untested commands
8. Blaming infra without investigating
9. Sycophancy ("perfect", "flawless", "perfectly aligned")
10. **Over-specifying builder prompts (giving near-complete pseudo-code)** — VIOLATED 10× THIS SESSION

**Action for next session:** write `scripts/gate-banned-behaviors.mjs` that greps agent outputs + briefs for these phrases/patterns. Add to `npm run gates`.

---

## 14. The literal next-session sequence

1. **Read this document end-to-end.** Don't skim.
2. **Read the 13 files in section 2.** Mark gaps in your understanding.
3. **Read this session's chat transcripts** at `.council/runs/chat-1779913745408/` and related dirs to see the architecture conversation in original form.
4. **Run the audit summaries (section 7.2)** — write 1-page summaries of each Temporal primitive.
5. **Confirm the section 4 decisions are still good** (or surface disagreements before drafting).
6. **Then start phase 1 from section 7.1** in order. Do NOT skip ahead. Do NOT batch.
7. **Pre-flight every dispatch** (section 10.4 rule).
8. **Per-commit cross-family review** (memory rule).
9. **Update this document if architecture decisions change.** It becomes stale fast otherwise.

---

## End

Total: ~600 lines of architecture context. Next-session-you: this is everything I know after the audit + 4 message architecture iteration with the user. Start here. Don't re-discover.
