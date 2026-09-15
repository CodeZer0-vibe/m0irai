**Design-Delta: zer0 Loop vs Frontier-Lab Agent Loops**

Scope: read-only source review plus current web sources. I verified local implementation files, the loop v1 draft, and prior synthesis. I did not run tests because this is a research-only request.

**1. Loop Shape**

Field baseline: Anthropic’s public doctrine is simple: agents gather context, act, verify, and repeat; complex cases use orchestrator-workers and evaluator-optimizer when task decomposition or iterative critique is valuable. Anthropic also stresses ground-truth feedback from tools/execution and stop conditions such as max iterations and checkpoints. Sources: [Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents), [Claude Code loop docs](https://code.claude.com/docs/en/how-claude-code-works).

OUR mapping:

| Field Doctrine | OUR Phase | Repo Evidence | Judgment |
| --- | --- | --- | --- |
| Gather context | `negotiating-goal` + prompt rebuilt from durable state | [protocol.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/protocol.ts:80):80-99, [loop-commands.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/chat/loop-commands.ts:64):64-70 | Match, with stronger bounded-contract discipline than a normal CLI loop. |
| Take action | `building` via builder in isolated loop worktree | [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:101):101-108, [driver-lanes.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-lanes.ts:196):196-219 | Match. Worktree isolation is a strength. |
| Verify work | cross-family verifier, then mechanical gates | [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:146):146-166, [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:223):223-264, :281-315 | Stronger than typical single-family evaluator-optimizer. |
| Repeat | `runLoopUntilStop` bounded loop | [driver-boot-loop.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-boot-loop.ts:266):266-295 | Match. |
| Outcome history | durable progress file, not chat context | [types.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/types.ts:160):160-174, [progress-store.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/progress-store.ts:163):163-181 | Match with community “fresh context + files/git” doctrine from prior local synthesis [docs/research/2026-07-02-loop-synthesis.md](C:/Users/<user>/VibeCoding/zer0-agent-ci/docs/research/2026-07-02-loop-synthesis.md:12):12-18. |

Main deviation: OUR loop is not a free-form Claude Code-style agent loop. It is a deterministic manager workflow: one builder, one verifier, gates, apply. That is a strength for a shipping control tower. The novel part is cross-family stop authority: an iteration completes only on verifier PASS from a different family plus green gates [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:161):161-179. I found no frontier-lab public doc that describes this exact multi-vendor family split as a standard pattern.

**2. Stop Conditions & Goal Contracts**

OUR strengths:

- I-10 preflight negotiates scope before starting work: `/loop <goal>` returns a negotiation prompt and never calls `startLoop` [loop-commands.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/chat/loop-commands.ts:82):82-102.
- Explicit confirmation is required before start [loop-commands.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/chat/loop-commands.ts:140):140-153, with y-only confirmation in TUI [use-loop-confirm-keymap.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/use-loop-confirm-keymap.ts:44):44-70.
- Max iterations are required in schema [types.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/types.ts:57):57-73 and UI parse enforces 1-50 [control-execute.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/control-execute.ts:165):165-211.
- Wall-clock cap is enforced before each iteration and during transient waits [driver-boot-stop.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-boot-stop.ts:52):52-65, [driver-boot-loop.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-boot-loop.ts:133):133-150.
- I-6 same-wall detection switches builder once, then pauses [driver-iteration.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-iteration.ts:237):237-256, [driver-boot-stop.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-boot-stop.ts:90):90-97.

Field comparison: Anthropic explicitly recommends stopping conditions such as max iterations and human checkpoints; OpenAI Agents SDK stops when a run finishes or pauses for approval. Sources: [Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents), [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents).

Missing stop condition: confidence/uncertainty threshold on verifier quality. OUR verifier has pass/fail/failureClass and one parse retry, but no “verifier cannot establish adequacy” / “needs human judgment” terminal distinct from fail. OpenAI’s guardrails/HITL docs treat approval/pause as a first-class run decision before risky continuations; OUR equivalent exists for operator stop/pause, but not for verifier uncertainty. Source: [OpenAI guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).

**3. Verification Integrity**

Field issue: reward hacking/specification gaming is real. Anthropic defines reward hacking as satisfying the letter of the task without the intended work and documents coding-task cheating and later misalignment risk. Sources: [Anthropic reward hacking](https://www.anthropic.com/research/emergent-misalignment-reward-hacking), [Anthropic reward tampering](https://www.anthropic.com/research/reward-tampering). OpenAI’s current agent-eval guidance hardens workflows with traces, graders, datasets, and repeatable eval runs, not a single final answer check: [OpenAI agent evals](https://developers.openai.com/api/docs/guides/agent-evals).

OUR defenses:

- Cross-family verifier blocks same-family “grading own homework” [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:161):161-166.
- Mechanical gates are required and run in loop worktree [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:281):281-315.
- Completion requires both verifier PASS and gate PASS [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:165):165-179.
- Zero-delta cannot pretend success; it is counted and signed as its own failure shape [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:108):108-113, [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:317):317-342.
- Failure signature excludes prose/timing and uses gate names, verifier class, changed-file hashes, and zero-delta marker [failure-signature.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/failure-signature.ts:51):51-80.

Remaining gaming vectors:

| Vector | Blocked Today? | Evidence / Gap |
| --- | --- | --- |
| Builder edits tests to satisfy gates | Partially blocked only if verifier catches it. Gates run after build, but builder owns worktree edits including tests. No policy layer marks test edits suspicious. |
| Builder changes gate config/scripts | Same gap. Gates are mechanical, but editable gate inputs can be part of the diff unless separately protected. |
| Verifier rubber-stamps or misses intent | Partially blocked by cross-family split, not by calibrated confidence or trace-grader history. |
| Failure-signature gaming | Partially blocked. Hash uses file path/content and gate/verifier class [failure-signature.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/failure-signature.ts:74):74-80, but a builder can make superficial content changes to dodge “same wall.” |
| Zero-delta success claims | Blocked. Zero-delta bypasses verifier and records a non-completion [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:317):317-342. |
| Same-family PASS | Blocked [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:161):161-166. |
| Tampering with progress ledger | Mostly blocked by schema + atomic writes [progress-store.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/progress-store.ts:203):203-205, :366-371, but not cryptographically sealed. |

**4. Context Across Iterations**

Field: Claude Code encourages exploring/planning, then acting, and supports interruption/steering; cost docs recommend clearing stale context, compacting, moving specialized instructions into skills, and using subagents to isolate verbose work. Sources: [Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [Claude costs](https://code.claude.com/docs/en/costs).

OUR context model is conservative and mostly right:

- Builder prompt is rebuilt from durable state only, never transcript [protocol.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/protocol.ts:1):1-9.
- Prompt budget is capped at 24k chars [protocol.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/protocol.ts:16):16-23.
- Carries only goal, current iteration, prior outcome, prior gate failures, and switch note [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:46):46-78.
- Durable record carries status, phase, goalContract, actions, and outcomeHistory [types.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/types.ts:160):160-174.

Add: a short “attempt ledger” of failed approaches or verifier findings, separate from outcome recap. Current `verifierFindings` passed to the builder is only gate-failure names [driver-phases.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-phases.ts:73):73-75, not the verifier’s substantive critique. That is too thin for complex repairs.

Drop: nothing obvious. The design avoids context rot by not accumulating raw transcript. Keep it.

**5. Human-In-The-Loop Placement**

Field: Claude Code supports interruption and steering at any point, plan mode before implementation, and user-provided verification targets. OpenAI uses human review to pause before sensitive tool actions and resumable approvals. Sources: [Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [OpenAI HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/), [OpenAI guardrails](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).

OUR placement:

- Strong start checkpoint: confirm-to-start is explicit [use-loop-confirm-keymap.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/use-loop-confirm-keymap.ts:36):36-41.
- End-of-iteration / stop visibility exists via loop cards and stop reports [loop-card.tsx](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/loop-card.tsx:73):73-109, [loop-stop-report.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/loop-stop-report.ts:39):39-50.
- Missing live steering: the bridge explicitly says no live steer entry point exists yet and points the user to `/pause` [cockpit-loop-bridge.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/tui/cockpit-loop-bridge.ts:31):31-34.

Gap: per-iteration plan preview / mid-run steering. The spec wants next-phase-edge steering, but implementation currently offers pause-then-tell-me. That is behind field UX.

**6. Cost / Quota Governance**

OUR strengths:

- Quota preflight runs before dispatch for both builder and verifier [driver-iteration.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver-iteration.ts:151):151-166.
- Unknown/stale/low are typed states, not guessed [budget.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/budget.ts:65):65-84.
- Card shows subscription capacity line, not dollars [driver.ts](C:/Users/<user>/VibeCoding/zer0-agent-ci/src/loop/driver.ts:193):193-208.

Field gap: Claude Code exposes `/usage`, spend limits, per-user reporting, context/token management, model selection, and agent-team cost warnings. Source: [Claude Code costs](https://code.claude.com/docs/en/costs).

Missing from OUR loop:

- Per-iteration token cap.
- Cumulative tokens/cost/capacity consumed by loop.
- Projected remaining budget before confirming a 20-iteration run.
- Context-window pressure surfaced to the operator.
- Model/effort downgrading policy for verifier or retry phases.

**7. Verdict Table**

| # | Decision | Verdict | Field Comparison | Recommendation |
| --- | --- | --- | --- | --- |
| 1 | Cross-family verifier as stop authority | NOVEL | Anthropic endorses evaluator-optimizer; public docs do not describe multi-vendor family split. | Keep; add verifier-confidence pause. |
| 2 | Gates + verifier both required | CONFIRMED | Matches ground-truth/tool feedback and guardrails doctrine. | Keep. |
| 3 | Goal negotiation before quota burn | CONFIRMED | Matches Claude plan-first guidance and OpenAI blocking guardrails. | Keep; make plan preview richer. |
| 4 | Fresh prompt from durable state, no transcript replay | CONFIRMED | Matches anti-context-rot/community loop doctrine and Claude cost guidance. | Keep; add compact failed-approach ledger. |
| 5 | One switch on identical failure signature | NOVEL | Field uses no-progress detection broadly, but this exact one-switch cross-family rule is yours. | Keep, but harden against superficial-delta evasion. |
| 6 | Pause on Unknown/Stale quota | CONFIRMED | Conservative cost governance aligns with subscription/rate-limit reality. | Keep; add cumulative display. |
| 7 | Worktree-only build, clean apply to main | CONFIRMED | Matches sandbox/worktree safety expectations. | Keep. |
| 8 | Confirm-to-start, then mostly AFK | CHALLENGED | Claude Code and OpenAI both support interruption/approval during runs. | Add mid-run steering and per-iteration preview for risky changes. |
| 9 | Stop report + loop card instead of verbose logs | CONFIRMED | Operator-level progress is right; raw traces can stay debug-only. | Keep, but expose trace/eval link for debugging. |
| 10 | Builder can modify tests/gate inputs | CHALLENGED | Reward-hacking literature says visible tests are exploitable. | Add tamper checks or protected gate/test policy before 0.3. |

**5 Changes Before 0.3 Ships**

1. Add verifier uncertainty as a first-class pause outcome.  
Effort: M. Impact: high. This closes the field-standard “pause for human judgment” gap when the verifier cannot honestly prove done.

2. Add anti-gaming diff policy for tests, gate config, package scripts, and CI files.  
Effort: M. Impact: high. Verifier should explicitly classify “validation surface changed” and require either human approval or stronger evidence.

3. Implement real mid-run steering at the next phase boundary.  
Effort: L. Impact: high. Current UI admits this is not wired; field tools let users interrupt/steer instead of waiting or pausing manually.

4. Add cumulative loop usage telemetry: per-iteration tokens/estimated cost/capacity, context pressure, and projected remaining iterations.  
Effort: M. Impact: medium-high. Current F-4 prevents quota mistakes but does not make cost growth legible.

5. Persist a compact failed-approach/verifier-findings ledger, not just outcome recap and gate names.  
Effort: S/M. Impact: medium. Keep fresh-context discipline, but give the next builder enough negative evidence to avoid rediscovery.

Confidence: YELLOW 86%. Local implementation evidence is strong. Web comparison is grounded in current Anthropic/OpenAI docs, but “nobody does cross-family this way” remains a public-source absence claim, not something that can be proven exhaustively.

