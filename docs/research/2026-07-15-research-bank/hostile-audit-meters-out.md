Findings

BLOCK — src/chat/usage-reporter.ts:146 + src/chat/codex-rate-limits.ts:190-197,237-251
Codex rollout reads have no per-turn freshness gate, so an old matching rollout can overwrite a fresher ACP ctx update and still report `usage.payload arrived`.
Scenario: current Codex turn emits ACP `usage_update` with ctx 60%; matching rollout file still contains prior turn token_count with ctx 25%, 5h 35%, weekly 76%; no fresh token_count lands this turn. `recordAcpSessionUpdate` emits good ctx, then `captureCodexStatus` reads the old file and emits an older full `agent.status`, replacing the better display. Debug says `arrived`, not `stale`.
Confirm with a test that seeds a matching rollout whose mtime/timestamp is before `startedMs`, records ACP ctx, then asserts post-lane capture does not overwrite it.

BLOCK — src/chat/codex-rate-limits.ts:403-409 + src/chat/usage-reporter.ts:199-200
Session binding assumes the ACP Codex `laneSessionId` exactly equals the suffix of `rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`. The tests prove this only by constructing filenames with `active-session` manually at src/chat/usage-reporter.test.ts:180-186 and src/chat/codex-rate-limits.test.ts:245-252.
Scenario: real Codex ACP returns `response.thread.id`, but the rollout filename suffix differs. `newestRolloutFile(..., sessionId)` returns undefined, `isStaleSessionRollout` reports stale if any rollout exists, and Codex never gets 5h/weekly quota despite the contract.
Confirm by running one live Codex ACP carrier turn and comparing `laneSession.current` to the actual latest `CODEX_HOME/sessions/**/rollout-*.jsonl` suffix.

CONCERN — src/adapters/acp/acp-clean-config.ts:67-92
The clean Claude config remains one home-global directory, but the new `statusLine` content is cwd-specific. That breaks the isolation shape under concurrent zer0 instances/projects.
Scenario: project A calls `ensureCleanClaudeConfig(home, cwdA)`, project B calls `ensureCleanClaudeConfig(home, cwdB)` before A’s Claude child reads settings. Both use the same `$HOME/.zer0/claude-config/settings.json`; whichever write wins controls the payload path. A can write B’s payload, or A’s reporter reads its own cwd hash and reports missing.
Confirm with a temp-home test calling `ensureCleanClaudeConfig(home, "C:/a")` then `ensureCleanClaudeConfig(home, "C:/b")`; the returned dir is identical and settings mutate under the first caller.

CONCERN — src/adapters/acp/acp-clean-config.ts:114-119 + src/chat/statusline-emit.cjs:22-32
The new ACP statusLine path adds silent write-failure modes. `writeSettingsSafe` swallows an unwritable config write, and `statusline-emit.cjs` swallows payload write failures with no durable reason.
Scenario: old settings point at cwd A, then the config file is locked/read-only and a cwd B lane starts. The write failure is swallowed, Claude runs with stale settings, and B’s payload never arrives. `usage.payload` can only say missing, not “statusline write failed,” violating the debug-truth/no-silent-swallow invariant.

NIT — src/chat/headless-carrier-usage.test.ts:277
The wait timeout jumped from 300ms to 6500ms. It makes the suite slower and hides latency regressions in the missing-usage path. The focused run showed two tests taking ~5.1s and ~5.3s because they wait for the full Claude/AGY freshness timeout.

Attacked statusLine command injection — held. src/shared/claude-statusline.ts:22-59 points at repo-owned `statusline-emit.cjs`; cwd is only hashed into the temp filename, and both paths are quoted.

Attacked ACP permission/session lifecycle — held. src/adapters/acp/acp-lane-connection.ts:66 and src/adapters/acp/acp-turn-session.ts:208 only pass cwd into the existing spawn path; permission decider wiring stays unchanged.

Attacked renderer policy — held. src/tui/usage-bar.ts:114-128 still omits unreported metrics and shows weekly only when used >=75%.

Attacked trust boundary — held. src/chat/statusline-payload.ts:35-44 parses only numeric fields; Codex usage labels are derived locally from numbers in src/chat/codex-rate-limits.ts:100-140.

Verification:
Focused tests passed: `npm test -- src/adapters/acp/acp-clean-config.test.ts src/chat/codex-rate-limits.test.ts src/chat/usage-reporter.test.ts src/chat/headless-carrier-usage.test.ts` — 42 passed.
`npm run typecheck` did not run; the sandbox/approval policy blocked it before execution.
No code changes made.

