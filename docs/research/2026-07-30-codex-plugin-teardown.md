# Codex Plugin for Claude Code — full source teardown (2026-07-30)

**Source:** github.com/openai/codex-plugin-cc @ commit `db52e28` (2026-07-07) · Apache-2.0
(legal to reuse with attribution) · ~7,000 lines plugin source + ~2,900 test lines; ~90% of
non-test source read. Operator-facing report (same findings, rendered):
`C:\Users\<user>\.claude\jobs\20b1cbc2\tmp\codex-plugin-teardown.html`. Re-clone anytime — public.

**What it is:** OpenAI's official plugin running Codex INSIDE Claude Code. Slash commands
(`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:transfer`,
`/codex:status|result|cancel`, `/codex:setup`) + an optional Stop-hook review gate where codex
blocks Claude from finishing until issues are fixed. Works on ChatGPT subscription incl. Free.

**Strategic verdict:** boss-and-tool topology — Claude commands, Codex obeys, every hop is
operator-typed, results poll from background jobs, two vendors, no shared memory. It is the
"dead room" the North Star rejects (docs/decisions/2026-07-28-the-room-is-alive.md) — and it
validates the cross-vendor thesis at the biggest-lab level. Their own docs warn the review gate
"can create a long-running Claude/Codex loop and may drain usage limits quickly" — our hop-budget
guard rail, vindicated in their voice.

**This doc is the brief-writer's source.** Each section below names the slice it feeds and what
folds into that slice's BUILD BRIEF when its round fires. All file:line references are into the
plugin repo at `db52e28`.

---

## FOR S2 (memory-for-sure): canonical-path identity

They never trust a path string as identity. The per-workspace state dir is keyed by
`fs.realpathSync.native(workspaceRoot)` hashed sha256 (`scripts/lib/state.mjs:29-43`):

```js
let canonicalWorkspaceRoot = workspaceRoot;
try { canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot); } catch { ... }
const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
```

**Fold into the S2 brief:** our ledger-leak prime suspect is the `viaLedger` guard's
`carrier.dbPath === input.dbPath` string equality (src/chat/evidence.ts) failing on
relative-vs-absolute spellings. The fix shape: canonicalize (realpath, native casing) BEFORE any
path comparison or keying — and the falsifier is a test that opens the same DB via two spellings
and asserts one identity. Same discipline appears in their session-transfer path confinement
(`claude-session-transfer.mjs:20-44`: realpath both sides, then `path.relative` traversal check).

## FOR S3a/S3b (live work rendered): the app-server live-events channel

`codex app-server` (subcommand of the codex CLI) is a JSON-RPC-over-stdio interface, richer than
ACP: `thread/start|resume|list|name/set`, `turn/start|interrupt`, `review/start`,
`externalAgentConfig/import`, `account/read`, `config/read` (`scripts/lib/app-server-protocol.d.ts:59-69`).

Live notifications: `thread/started`, `turn/started`, `item/started`, `item/completed`,
`turn/completed`, `error`. Item types observed in their handler (`scripts/lib/codex.mjs:241-300`):
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `reasoning`,
`agentMessage`, `enteredReviewMode`/`exitedReviewMode`, `collabAgentToolCall` (codex-internal
subagents, with `receiverThreadIds`).

Their translation layer maps items → human lines + phase vocabulary **starting / investigating /
editing / verifying / running / reviewing / finalizing / failed**, with a test/lint regex
promoting commands to "verifying" (`codex.mjs:101-105`). Token-level streaming EXISTS: the plugin
opts OUT via `optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", ...]`
(`scripts/lib/app-server.mjs:33-42`) — zer0 would keep deltas ON.

**Fold into the S3a brief:** the evidence round captures BOTH our ACP `session/update` payloads
AND `codex app-server` item events (spawn `codex app-server`, drive one real turn, record every
notification verbatim). Decide the codex chair's feed source from captures, not docs.
**Fold into S3b:** their describeStartedItem/describeCompletedItem table is a ready-made
starting vocabulary for `codex ▸ running tests…` lines.

**Drift caveat (READ-WHAT-IS):** their protocol types are GENERATED artifacts
(`.generated/app-server-types`), and their code carries "unknown method" fallbacks for older CLIs
(`codex.mjs:738-746`, `:1071-1078`). If we adopt app-server: capability-probe on boot
(`codex app-server --help`, their `getCodexAvailability` at `codex.mjs:886-904`) and fail LOUD on
drift — the agy law.

## FOR S4a/S4b (messages when they happen): the tracked-job model

Every run = an on-disk job record + log file: `status` (queued/running/completed/failed/cancelled),
live-patched `phase`, `threadId`, `turnId`, `pid`, `summary`, `logFile`, `completedAt`
(`scripts/lib/tracked-jobs.mjs:142-204`). Progress events PATCH the visible record as they arrive
(`tracked-jobs.mjs:70-115`). Background = detached worker re-reads the job request from disk
(`codex-companion.mjs:671-710`). Cancel = `turn/interrupt` RPC **then** process-tree kill **then**
status flip (`companion:963-1022`). SessionEnd kills that session's jobs (`session-lifecycle-hook.mjs:42-75`).
`task-resume-candidate` surfaces "you have a resumable thread" as a first-class query
(`companion:928-961`).

**Fold into S4 briefs:** the phase-patch pattern (feed row updates from progress events, not from
completion) and the double-kill cancel semantics for `/pause`//`/cancel`.

## FOR S5 (call-each-other): the teaching layer

Three Apache-2.0 prompt assets — the closest published prior art to our taught skill:

1. **Proactive hand-off lives in ONE sentence** — the subagent description
   (`agents/codex-rescue.md:3`): "Proactively use when Claude Code is stuck… Do not wait for the
   user to explicitly ask for Codex." Counterweight: "Do not grab simple asks that the main
   thread can finish quickly."
2. **Forwarder discipline** (`codex-rescue.md:20-42`, `skills/codex-cli-runtime/SKILL.md:14-43`):
   one call, no freelancing — "Do not inspect the repository… Do not add commentary before or
   after the forwarded output." Routing flags (`--resume`/`--fresh`/`--model`/`--effort`) are
   STRIPPED from the task text — control channels never leak into the message body.
3. **Honest relay** (`skills/codex-result-handling/SKILL.md:9-22`): "Preserve evidence
   boundaries… do not turn a failed Codex run into a Claude-side implementation attempt…
   if Codex was never successfully invoked, do not generate a substitute answer at all…
   Auto-applying fixes from a review is strictly forbidden."

**Fold into the S5 brief:** the team-setup skill teaches (a) when a teammate call is warranted
(proactive, never for trivial asks), (b) hop messages carry the ask only — routing metadata stays
out of the message text, (c) relaying preserves evidence boundaries and NEVER fabricates a
substitute answer on teammate failure (the agy lesson, in OpenAI's words).

## FOR THE PIPELINE (coordinator practice, adopt now): prompting codex + schema verdicts

- **OpenAI's canonical codex prompting doctrine** (`skills/gpt-5-4-prompting/SKILL.md`,
  `references/prompt-blocks.md`): prompt like an *operator, not a collaborator*; compact XML
  blocks — `<task>`, `<structured_output_contract>`/`<compact_output_contract>`,
  `<default_follow_through_policy>`, `<verification_loop>`, `<completeness_contract>`,
  `<grounding_rules>`, `<missing_context_gating>`, `<action_safety>`, `<dig_deeper_nudge>`,
  `<research_mode>`, `<tool_persistence_rules>`, `<progress_updates>`. On resumed threads send
  ONLY the delta instruction. Their words: "Do not raise reasoning or complexity first. Tighten
  the prompt and verification rules before escalating."
- **Schema-forced verdicts:** `turn/start` accepts `outputSchema` (`codex.mjs:1136-1142`);
  their review schema (`schemas/review-output.schema.json`) = verdict enum
  `approve|needs-attention`, findings each with severity/file/line_start/line_end/confidence
  0-1/recommendation; parse failures recorded, never swallowed (`codex.mjs:1188-1213`).
- **Hostile-review phrasing worth cribbing** (`prompts/adversarial-review.md`): "break confidence
  in the change, not validate it" · "no credit for good intent, partial fixes, or likely
  follow-up work" · "prefer one strong finding over several weak ones."

## FOR S9/S10 (AFK loop): the stop-gate contract

Stop hook → codex judges the last turn → reply's FIRST LINE must be `ALLOW: <reason>` or
`BLOCK: <reason>` → block decision forces Claude to continue (`stop-review-gate-hook.mjs:69-96`).
Timeout (15 min) and unparseable output fail TOWARD blocking with a bypass note — never a silent
pass (`:112-139`). Scope rules (`prompts/stop-review-gate.md`): only the previous turn's DIRECT
edits count; "Do not treat the previous Claude response as proof that code changes happened;
verify that from the repository state before you block."

## FOR THE OPERATOR MENU (product, theirs): official cross-vendor session transfer

`externalAgentConfig/import` converts a Claude Code transcript (.jsonl under `~/.claude/projects`
only, realpath-confined) into a NATIVE codex thread; receipts (source path + content sha256 →
imported thread id) land in `~/.codex/external_agent_session_imports.json`; resume via
`codex resume <threadId>` (`codex.mjs:657-699`, `:1058-1093`). One-way, one-shot — NOT a shared
memory. Possible future zer0 feature: "hand this room conversation to another vendor." Menu item,
not in the milestone.

## Hardening notes + codex facts (reference)

- Broker pattern: ONE shared codex runtime per session behind a local socket; 150ms socket
  liveness probe; stale broker → teardown + respawn (`broker-lifecycle.mjs:102-171`); busy/dead
  broker → automatic DIRECT-spawn fallback (`app-server.mjs:621-641`).
- Windows: codex spawn needs `shell:true` on win32 (`app-server.mjs:190-196`); kills use a
  process-TREE kill because the direct child is cmd.exe with a node grandchild (`:244-262`) —
  matches our ConPTY lesson.
- Codex effort tiers: `none|minimal|low|medium|high|xhigh`; alias `spark` = `gpt-5.3-codex-spark`
  (`codex-companion.mjs:71-72`). Native reviewer via `review/start` with targets
  `{type:"uncommittedChanges"}` / `{type:"baseBranch", branch}` (`companion:259-268`).
- Job list capped at 50 (`state.mjs:13`); review context inlines diffs up to 256KB / 2 files,
  measured before inclusion (`git.mjs:8-9`).

## What we deliberately do NOT take

The topology (boss+tool, operator-typed hops, no peer messages, no shared memory, no third
vendor) — that is the product difference, not a detail. Plugin plumbing (marketplace,
CLAUDE_PLUGIN_ROOT, Claude Code hook wiring) — irrelevant to zer0 the product; one far-future
note: a zer0 plugin inside Claude Code as a distribution channel.
