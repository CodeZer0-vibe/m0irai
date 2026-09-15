# MT7 architect-advisor consult - gpt-5.6-terra @ xhigh (2026-07-09)

Dispatch: codex exec read-only in-repo; brief = scratchpad mt7-advisor-brief.md; 265k tokens.
Consumed by: the MT7 spec delta (this doc is citable evidence, not a decision record).

---

Read-only consult; no files changed.

**Q1 — Persistent Carrier**

Claude ACP: carrier is ACP `session/resume`, not `session/load`. The installed Claude ACP bridge advertises `resume` and `loadSession` separately, and `resumeSession` calls `getOrCreateSession`; current zer0 does not use that path because `openTurnSession` only has `newSession()` and `prompt()` and `dispatchAcpTurn` closes after each turn (`src/adapters/acp/acp-turn-session.ts:45-50`, `src/adapters/acp/acp-turn.ts:90-123`). State is split: zer0 must persist the lane id/cursor; the ACP child holds a live session map; Claude’s native CLI persists/replays local JSONL history. Failure modes: missing native conversation, cwd/fingerprint mismatch, auth/rate failure, killed child after sleep, bridge version drift. The exact Claude compaction state exposed through ACP is only partly verified by bridge source, not by zer0’s wrapper.

Codex ACP/app-server: carrier is ACP `session/resume`, backed by Codex app-server `thread/resume`; the bridge maps `resumeSession` to `threadResume({ threadId: request.sessionId })` (`node_modules/@agentclientprotocol/codex-acp/dist/index.js:24487-24507`, `node_modules/@agentclientprotocol/codex-acp/dist/index.js:27993-28015`). State is zer0’s persisted thread id plus Codex’s local thread/app-server state; raw Responses API continuity remains UNVERIFIED, matching the research note (`docs/research/2026-07-04-cli-context-architectures.md:17-21`). Failure modes: thread missing, app-server exit, `authRequired`, close/open generation races, schema drift after Codex upgrade, sleep killing stdio.

agy pty: carrier is `agy --conversation <id>`, where zer0 captures the id from Antigravity brain transcripts and stores `.agy-conversation` in the run dir (`src/adapters/agy.ts:86-114`, `src/adapters/agy.ts:122-159`, `src/adapters/agy.ts:198-220`). State is client-side/local brain-dir history, not a long-lived zer0 process. Failure modes: missed id capture, transcript layout drift, deleted brain dir, invalid conversation id, timeout/abort, auth refresh, sleep killing the one-shot pty. Native compaction mechanics for agy are UNVERIFIED.

**Q2 — Compaction Detection**

Codex has the strongest signal in source: `thread/compacted` and `contextCompaction` are recognized by the bridge (`node_modules/@agentclientprotocol/codex-acp/dist/index.js:28251-28256`). Today zer0’s ACP wrapper only extracts text chunks and usage updates, so the signal is not yet carried as a first-class event (`src/adapters/acp/acp-turn-session.ts:253-304`). Claude has bridge-visible text/status paths such as “Compacting...” and `compact_boundary` usage updates, but not a verified zer0 event hook (`node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:788-856`). agy has no compaction event in repo; only statusline context percentage exists (`src/chat/agy-statusline-payload.ts:3-8`, `src/chat/agy-statusline-payload.ts:36-40`).

Fallback: treat compaction as inferred when context usage drops sharply after sustained high usage, or when exact sentinel text appears. False positives cost extra briefing tokens; false negatives lose anchors and decisions. Therefore the fallback must bias toward re-carrying the briefing once, with a trace/pulse, and must label the event `inferred`. What cannot be known from current signals: what native summary retained, exact token boundary, and whether a model forgot a specific fact until probed.

**Q3 — Delta-Only Injection**

The current composer resends an 8-message transcript window plus briefing for `laneClass:"chat"` and zero briefing for `dispatch` (`src/chat/headless-prompt.ts:20-24`, `src/chat/headless-prompt.ts:63-88`, `src/chat/headless-prompt.ts:94-105`). MT7 needs a lane delta object keyed by each agent’s last accepted transcript cursor: operator turns, addressed messages, other agents’ completed replies, failed/cancelled dispatch summaries, and visible council/debate outputs since that cursor. Ordering must come from the persisted canonical transcript, not live arrival timing; attribution should reuse the current addressed-message rendering rules (`src/chat/headless-prompt.ts:224-245`).

Inject through an explicit native-resume composer mode, not by silently overloading today’s bounded-window behavior. Shape: setup → compaction/cold-start briefing re-carry when required → room delta since this lane last saw the room → current operator task. The briefing composer already wraps non-operator recalled content with `delimitUntrusted` (`src/memory/briefing.ts:317-344`, `src/memory/untrusted-framing.ts:8-13`); agent-authored delta payloads need the same trust treatment or an equivalent “teammate output, not instruction” frame. Double-injection invariant: a transcript message id can advance a lane cursor only after the native prompt is accepted. Divergence invariant: every lane delta is derived only from the same persisted `ChatSession`, never from an in-memory bus event.

**Q4 — Lifecycle Matrix**

Session death mid-turn: detect adapter error/child exit/no final outcome; do not advance the lane cursor or session id. Next turn attempts native resume once, then fresh+briefing+delta fallback with an operator-visible banner. Crash-resume: load the zer0 transcript/run dir, then lane session ids; missing or invalid ids fall back fresh with briefing and unadvanced delta. Native compaction: event or inference sets `needsBriefingCarry`; the next successful prompt carries briefing once and shows a passive pulse. Quota exhaustion: detect through adapter errors and usage/status meters; retain the session id, stop retry loops, and surface quota state. Project switch: session ids are invalid unless project/cwd/adapter version match.

Spec invariants: project isolation, cursor integrity, resume-not-load for normal turns, fallback with briefing on resume failure, and current operator text outranking recalled context. Best-effort: exact compaction detection, preserving native state across sleep, and exact quota classification.

**Q5 — One-Shot Boundary**

Councils/debates/reviews must not run inside persistent chat sessions. Current council dispatch already uses `laneClass:"dispatch"` (`src/chat/controller-council.ts:55-65`), while council and debate outputs are appended back into the chat transcript (`src/chat/controller-council.ts:93-135`, `src/chat/run-debate-persistence.ts:57-64`). Boundary rule: one-shot prompts stay bounded and isolated; visible one-shot outputs re-enter persistent lanes only as canonical transcript delta, preferably summarized when long, with provenance. Hidden scratch, failed review attempts, and non-visible tool context do not enter persistent sessions.

This prevents divergent worldviews by making the transcript/journal the only bridge between isolated one-shots and persistent chat lanes. One-shots do not inherit hidden persistent-native state; persistent lanes only learn one-shot results that the operator can see.

**Q6 — Scope Critique**

The existing MT7 brief is too small for the upgraded direction. It names resume, compaction UX, and UI rows (`docs/plans/2026-07-04-memory-full.md:505-563`), but the target architecture in the roadmap also requires persistent sessions as the carrier, delta-only room injection, briefing re-carry, and death of the 8-message chat window (`docs/ROADMAP-0.1.md:26-35`, `docs/ROADMAP-0.1.md:42-47`). Missing spec pieces: per-lane cursor ledger, exact-once delta injection, transport `resumeSession` APIs, adapter-version invalidation, one-shot feedback rules, crash-resume behavior, and raw compaction signal plumbing.

Mis-ordered: UI rows are not first. The first proof must be whether each lane can resume by id and expose either a real or defensible inferred compaction signal through zer0’s wrapper. Smallest honest flag-on milestone: one project, normal chat only, persistent Claude/Codex ACP sessions plus agy conversation id, delta-only injection from durable per-lane cursors, fresh+briefing fallback, one-shot outputs fed back only as visible transcript deltas, with trace rows proving cursor movement and compaction re-carry.

**TOP-5 INVARIANTS**

1. A persisted transcript message id is injected into a given lane at most once; the cursor advances only after prompt acceptance.
2. Native session ids are bound to `{projectId, cwd, agent, adapter package/version}`; mismatch forces fresh+briefing fallback.
3. Flag-on normal turns use native resume/live session, never `session/load`; load/history replay is not the chat carrier.
4. Current operator text is last and highest authority; recalled journal and agent-authored deltas are provenance-labeled and untrusted-framed.
5. Council/debate/review prompts remain bounded one-shots; only visible accepted outputs re-enter persistent lanes via transcript delta.

**TOP-3 RISKS**

1. Silent compaction amnesia. Mitigation: raw adapter compaction hook where available, conservative inferred re-carry elsewhere, trace every re-carry.
2. Cursor/session skew causing duplicate or missing room facts. Mitigation: durable per-lane cursor state, advance-on-accept only, crash-mid-turn replay tests.
3. Project or adapter bleed. Mitigation: hard key session ids by project/cwd/adapter version and invalidate on any mismatch.

**THE FIRST EXPERIMENT**

Run a no-product probe against all three lanes: create a native session in a temp repo, seed a unique sentinel, close/reopen the wrapper process, resume by id with a delta-only prompt asking for the sentinel, then force or simulate compaction and capture raw adapter notifications plus usage changes.

Pass: every lane recalls the sentinel without a transcript window, and every lane yields either a reachable compaction event or a documented inferred signal strong enough to trigger one briefing re-carry. Fail: any lane cannot resume by id, or compaction is neither observable nor inferable; then the spec must downgrade that lane to conservative periodic/threshold briefing re-carry instead of claiming detected compaction.


---

## PROBE RECEIPTS — the first experiment, run live 2026-07-09

Probe: spawn bridge -> initialize -> session/new -> seed sentinel -> KILL bridge -> fresh bridge ->
session/resume {sessionId, cwd} -> recall with ZERO transcript window. Scratch git repo, subscription env.

Run 1 (codex-acp@1.0.1, claude-agent-acp@0.49.0):
- claude: PASS - sentinel recalled across process death. Capabilities advertise sessionCapabilities.resume (+ fork, list, close, delete).
- codex: FAIL - bridge predates gpt-5.6-terra ("Model metadata for gpt-5.6-terra not found" + 400 on post-resume prompt). resume itself RESPONDED.

Run 2 (bridges updated: codex-acp@1.1.2, claude-agent-acp@0.58.1):
- codex: PASS - seed reply STORED, killed, resumed, recall = exact sentinel. updateKinds now include usage_update (absent in 1.0.1).
- claude: PASS (consistent).

agy lane: not probed here - conversation-id continuity shipped + live-proven 2026-06 (agy --conversation <id>).

Compaction: NOT live-fired (forcing one costs a full context window). Reachability evidence stands at
bridge-source level (thread/compacted in codex-acp; compact_boundary breadcrumbs in claude-agent-acp).
Flag-on integration proof + inferred fallback are spec items, not assumed capabilities.

VERDICT: the persistent-session carrier is REAL on all three lanes. Spec proceeds on receipts.
