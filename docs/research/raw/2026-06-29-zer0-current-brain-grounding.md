# zer0 Memory / Shared-Brain — Current-State Grounding (build map, file:line)

Read-only mapping of the EXISTING memory implementation (verified at file:line). Seeds the memory PRD/plan. Companion to `../2026-06-29-memory-engine-synthesis.md` §0.

## Persistence

- `better-sqlite3` v11.0.0 (`package.json:42`) — NOT `node:sqlite`, NOT `sqlite-vec`.
- DB path `.zer0/evidence.db` (CWD-relative); `.zer0/config.yaml dbPath` (`src/shared/config.ts:17`) or `ZER0_DB_PATH` (`config.ts:167`).
- `src/evidence/db.ts:openDb()` — WAL + `busy_timeout=5000` + FK; migrates to `EXPECTED_SCHEMA_VERSION=12` (`db.ts:19`).
- **sqlite-vec ABSENT** — no import / loadExtension / vec_* table. (MEMORY.md claimed it; never built.)
- Blob store: SHA256 content files at `.zer0/blobs/` (`config.ts:16`); rows carry the hash.

## Schema (base `src/evidence/schema.sql` v5 + hand-rolled migrations → v12 in `db.ts`)

- **`chat_sessions`** (v7→v8, `db.ts:58`): `id` (`chat-{ms}-{uuid}`), `run_id`→runs(id), `repo_root` (STORED, NEVER FILTERED), `run_dir`, `created_at/updated_at`, `default_agent/last_agent` CHECK in (claude,codex,gemini), `summary_text DEFAULT ''` (ALWAYS EMPTY), `summary_through_turn DEFAULT 0`.
- **`chat_messages`** (v8): `id, session_id, turn, round, role, agent, text_blob_hash, created_at, status, token_estimate, dispatch_id`.
- **`chat_working_sets`** (v9, the "shared-brain debate" table): `UNIQUE(session_id,turn,round,agent)`, `context_blob_hash` (per-round context snapshot), `peer_refs` (JSON ChatPeerRef cross-agent output refs), `outcome` CHECK(ok/fail/empty/timeout/cancelled/incomplete), `token_estimate`.
- **`active_debates`** (v9, per-session mutex): `session_id PK, turn, started_at`; `acquireActiveDebate` = CAS (INSERT OR IGNORE), prevents concurrent council turns/session.
- **BUILD-pipeline tables (separate path):** `findings` (`run_id, path, severity, source_agent, finding`); `findings_fts USING fts5` (`schema.sql:228`, BM25 over `findings.finding`) — BUILD-ONLY, chat never indexed here.

## Scoping/Isolation (TODAY = implicit only)

- Session id `chat-${Date.now()}-${randomUUID()}` (`src/chat/session-store.ts:44`).
- NO explicit project scoping at DB level. Isolation = (1) one `.zer0/evidence.db` per CWD (convention); (2) FS: `listSessions` scans `.council/runs/chat-*/` (`session-store.ts:92`); (3) `chat_sessions.repo_root` STORED (`schema.sql:283`) but **never a WHERE filter** (`queries-statements.ts`, `memory-queries.ts`). Shared `.zer0` → cross-project contamination.

## Resume (Phase 1 — BUILT)

- `src/chat/session-resume.ts:resolveBootSession()`: `--resume/-c` → `listSessions` newest-first → first `transcript.json` with messages; or `resumeId` (picker) loads by id.
- **Source of truth = FILESYSTEM `transcript.json`, NOT SQLite** (despite `db.ts:275` comment "SQLite holds the truth"). `loadSession` (`session-store.ts:66`) reads JSON. In-memory `session.messages[]` is continuity; last 20 injected via `buildTranscript` (`prompt-builder.ts:80`).

## Summarizer (P2) / Recall (P3)

- **Summarizer NOT implemented** — `summary_text` always `""`; `buildSummary` (`prompt-builder.ts:142`) renders only if `length>0`. Hard ceiling `TRANSCRIPT_WINDOW=20` (`prompt-builder.ts:26`) → silent loss past turn 20.
- **Recall partial / BUILD-only / no semantic** — `findFindingsByPathAcrossRuns` (`memory-queries.ts:95`) exact `WHERE path=?`; `findRecurringFindings` (:97) exact `GROUP BY finding`. `compileMemory` (`src/temporal/activities/memory-compiler.ts`) scoped to BUILD `findings`. Chat calls it with `relevantPaths:[]` (`prompt-builder.ts:258`) → ZERO results every time. Chat only gets recurring findings (≥2 across BUILD runs) + `docs/lessons/`.

## Write path (all best-effort: catch+warn+continue, never throws)

1. User prompt → `cockpit-turn-persist.ts:persistOperatorPrompt:38` → `appendMessage` (RAM) + `persistSession` (`.council/runs/${id}/transcript.json`) + `recordChatMessage` (SQLite + blob).
2. Dispatch done → `cockpit-turn-exec.ts` → `recordChatDispatch` (`evidence.ts:68`) — `dispatches` row + blobs.
3. `persistSession` → `persistSessionEvidence` → `recordChatSession` (`evidence.ts:124`) — `chat_sessions` upsert.
4. Debate round → `persistDebateTurn` (`evidence-strict.ts` via `evidence.ts:16`) — `chat_working_sets` + `active_debates` lease.
5. Session end → optional `writeHandoff` (`handoff.ts`) → `HANDOFF-CHAT.md`.

## Recall/injection surface — `src/chat/prompt-builder.ts:buildPrompt():72`

| Section       | Source                                           | Cap                                                 |
| ------------- | ------------------------------------------------ | --------------------------------------------------- |
| role          | CLAUDE.md/AGENTS.md/GEMINI.md per-agent          | unbounded                                           |
| request       | current user text                                | unbounded                                           |
| peers         | other agents' outputs this round                 | unbounded                                           |
| transcript    | last 20 from `session.messages[]` (RAM)          | `TRANSCRIPT_WINDOW=20` (:26)                        |
| older-context | `session.summary.text` (always "")               | 8000 tok                                            |
| project-state | live `git status/log/diff`                       | 15 lines each                                       |
| memory        | `compileMemory()` cross-BUILD findings + lessons | 10 findings / 5 recurring / 5 lessons / 80-line cap |
| instructions  | chat/build/research endcap                       | fixed                                               |

- `budgetPromptSections` trims (`src/chat/prompt-budgeter.ts`). Security: `prefilter` high-entropy scan BLOCKs dispatch (`src/security/filter.js`) — only injection guard.

## Risks (= build target)

- R1 BLOCK: source-of-truth split (loadSession reads FS not DB; best-effort DB writes diverge).
- R2 BLOCK: no project isolation at DB (repo_root never filtered).
- R3 BLOCK: no summarizer (ctx cliff @ turn 20, silent).
- R4 gap: chat zero cross-run/semantic recall (relevantPaths:[]).
- R5 operability: `listSessions` O(N) FS scan, not DB query (`session-resume.ts:146`).

## Key files

`src/evidence/schema.sql` (tables) · `src/evidence/db.ts` (openDb, migrations v1→12) · `src/evidence/memory-queries.ts` (find* recall) · `src/chat/session-store.ts` (create/load/list/persist) · `src/chat/session-resume.ts` (resolveBootSession, listSessionSummaries) · `src/chat/evidence.ts` (recordChat*) · `src/chat/prompt-builder.ts` (buildPrompt/loadMemory — injection surface) · `src/temporal/activities/memory-compiler.ts` (compileMemory) · `src/shared/config.ts` (db path) · `src/tui/cockpit-turn-persist.ts` (per-turn writes).
