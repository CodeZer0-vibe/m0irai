# Component research verdicts — the car, part by part (2026-06-09)

> Four parallel researchers, primary-source grounded. Operator question: "split the project into parts
> like a car; research the best option for each." Every contested part resolved KEEP-with-fix; one
> genuine transport upgrade found (codex app-server). Full reports lived in session
> 0220166f; this doc is the durable record.

## Verdicts

### 1. Cockpit TUI — KEEP Ink v7 + UX redesign (framework was never the problem)

- gemini-cli ships on an Ink fork (`@jrichman/ink@6.6.9` + `@lydell/node-pty`, win32 prebuilt);
  Claude Code is a forked Ink (custom reconciler + double-buffered diff). codex=Rust ratatui,
  crush=Go bubbletea — the non-Node leaders; nobody in Node leaves React-for-CLIs.
- Our flicker = documented stock-Ink full-redraw (vadimdemedes/ink#450, #359). Fixes: Ink ≥v6.7.0
  synchronized-update (DEC 2026 mode) + architectural — high-frequency streams go in `<Static>`,
  never the dynamic region. Upstream at v7.0.5 (2026-05-29). VERIFY our installed ink version first.
- Alternatives rejected: opentui v0.4.0 (SolidJS/Zig, 6-week-old API, HIGH migration), Rust/Go
  sidecar (invents an IPC boundary nobody runs), blessed (dead).
- **Locked UX pattern: k9s/lazygit master-detail.** Left rail = 3 agent cards (name · current task ·
  status badge · quota gauge). Center = focused agent's stream via `<Static>`. Bottom = docked
  approvals queue with count badge + batch keys. Root cause of "unusable": one shared transcript
  forces whole-region re-render on every token from every agent.

### 2. Memory — KEEP better-sqlite3 + FTS5; ADD sqlite-vec + local embeddings (smoke-gated)

- better-sqlite3 12.10.0 active (2026-05-12), FTS5 bundled, Windows prebuilt. `node:sqlite`
  DISQUALIFIED — compiled without FTS5 (nodejs/node#56951). libsql/DuckDB/LanceDB: no benefit or
  second source of truth at our scale.
- Semantic recall path: `sqlite-vec` 0.1.9 (Alex Garcia, Mozilla Builders; `sqlite-vec-windows-x64`
  prebuilt exists) via `loadExtension`, + `@huggingface/transformers` 4.2.0 + onnxruntime-node
  local CPU embeddings (all-MiniLM-L6-v2, ~10ms/query @10k docs). Hybrid FTS5 BM25 ∪ KNN → rerank.
  **MANDATORY GATE: Windows load + real KNN smoke vs our exact better-sqlite3 before adopting**
  (known DLL/SQLite-version mismatch report). Fallback: vectra (JSON index), same embeddings.
- Architecture lesson (all 3 vendor CLIs verified): **files-as-truth + index-on-top.** Markdown
  work-products/project-state stay truth; SQLite is the queryable index + transactional ledger.
  This is already our shape — no migration.
- WAL + busy_timeout 5000 is CORRECT for 3 agents + cockpit (N readers, 1 serialized writer).
  Keep writes small (better-sqlite3 is sync); bounded retry on SQLITE_BUSY.

### 3. Orchestration — KEEP Temporal + FIX THE DEPLOYMENT (we ran the wrong binary)

- **Root cause of all Temporal pain: we run the time-skipping TEST server (in-memory, virtual
  clock — a unit-test harness) as the server.** Sleep corruption + temporal.db deletes are its
  documented design, not Temporal flakiness.
- Supported local-persistent path: **`temporal server start-dev --db-filename temporal.db`** —
  real clock, SQLite persistence, restart survival documented (docs.temporal.io/cli/server;
  learn.temporal.io TS dev env). Pin the CLI version (db-file may not be fwd-compatible).
- Migration: ~1–2 days — swap boot path in `zer0 up`, drop TestWorkflowEnvironment from runtime,
  add worker-singleton guard (zombie pollers), then a sleep/wake resume smoke (the one unclosed
  verification).
- Hand-rolled SQLite state machine REJECTED: 5–8 days to re-own exactly-once + mid-activity crash
  resume that Temporal already provides; determinism tax is already paid (gates green). If ever
  forced off Temporal, closest fit = DBOS Transact TS (SQLite backend since 2026-03, embedded
  library, no orchestrator) — not now.
- Prior council KEEP ruling (2026-05-28) stands, now with the deployment correction.

### 4. Agent transport — HYBRID: codex→app-server, claude→pty (only option), gemini→pty

- **codex: switch to `codex app-server`** — JSON-RPC 2.0 over stdio; `thread/start|resume`,
  `turn/start|steer|interrupt`, streamed `item/agentMessage/delta`, approval callbacks
  (`item/commandExecution/requestApproval`). Shares the TUI's `~/.codex/auth.json` ChatGPT OAuth →
  subscription billing follows the token. **One 10-min falsification before committing: run a turn
  via app-server under ChatGPT login, confirm no API-credit decrement.** pty becomes codex fallback.
- **claude: pty is the ONLY subscription-preserving transport — VERIFIED.** ACP adapter
  (@agentclientprotocol/claude-agent-acp) is powered by the Agent SDK → bills to the separate
  Agent SDK credit pool from 2026-06-15 ($20/$100/$200). Zed's own guidance: keep subscription
  billing by running the official `claude` CLI interactively. `--output-format stream-json` is
  `-p`-family only. Do NOT move claude to ACP/SDK.
- **gemini: keep pty; do NOT invest in `--acp`** — gemini-cli stops serving AI Pro/Ultra
  2026-06-18; Antigravity CLI (Go) has NO ACP yet (open feature req #31). ACP mode also has a
  P1 stdout-corruption bug (#22647). Re-evaluate transport when Antigravity ships.
- **Seam design: adopt ACP's method vocabulary internally** (session/prompt, request_permission,
  streamed turns, steer/interrupt) so {codex: app-server, claude: pty, gemini: pty} are swappable
  bindings and a future Antigravity-ACP drops in.

## New parts to add (lead-senior additions — all load-bearing for the capstone)

1. **Task board** — `tasks` table (agent, title, status idle/working/blocked/awaiting-approval,
   owned file-set, started_at). Feeds the TUI agent cards, the write-lock arbiter, and
   project-state. Keystone for the UX redesign.
2. **Handoff proposals** — `proposeHandoff(to, task, contextRef)` → approvals-queue card →
   operator approves → dispatch. Agents propose, operator conducts (constitution intact).
3. **Interrupt + steer** — per-card `i`/`s`; codex via app-server `turn/interrupt|steer`,
   pty agents via Esc/`\x03` + follow-up message.
4. **Quota telemetry** — per-card usage gauge (codex /status bucket, claude session, gemini quota).
   Mechanical protection of the cost model.
5. **Session reattach** — live pty sessions registered in SQLite (pid, agent, chatSessionId);
   cockpit boot reattaches instead of respawning. Falls out of persistence (T2).

NOT adding (v1): web UI, voice, 4th agent, agent-to-agent direct channels, allow-always approvals,
anything past the capstone.

## Revised build order

Temporal deployment fix (1–2d) → persistence + session reattach (T2) → task board + Ink
master-detail redesign → codex app-server adapter (after billing falsification) → handoff
proposals + steer → G1–G5 closures → T_FINAL capstone.

## Open verifications (cheap, do before the dependent step)

- [ ] `npm ls ink` — confirm installed Ink ≥6.7.0 before the redesign.
- [ ] sqlite-vec Windows load + KNN smoke vs our better-sqlite3.
- [ ] codex app-server billing falsification (no API-credit decrement).
- [ ] Temporal start-dev sleep/wake resume smoke.
- [ ] Does interactive (yolo) gemini persist chats/session-\*.jsonl per turn? (from 2026-06-09 fix)
