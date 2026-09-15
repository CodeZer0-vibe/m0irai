# Module Contract Map — ACP turn transport (claude + codex)

Run claude/codex turns over ACP (persistent session) instead of headless `claude -p` / `codex exec`. Unlocks
native skill/command firing, models, modes, streaming. PROVEN live (2026-06-28): an ACP turn completes
(`stopReason: end_turn`, ~8s) and loads 63 of the operator's commands/skills — IF claude runs with a clean
`CLAUDE_CONFIG_DIR` (the operator's 8 Stop hooks otherwise hang every turn 120-207s).

## Phase 1 — the ACP turn adapter foundation (UNIT-TESTED, NOT wired into the live runHeadlessTurn path)

| Module (file)           | Responsibility (ONE sentence)                                                            | Exports (≤2)                 | Trust boundary                                                                                    | Budget | Imports from                                                |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| acp/acp-clean-config.ts | Produce a hook-free CLAUDE_CONFIG_DIR mirroring the operator's real skills/commands/auth | ensureCleanClaudeConfig      | ~/.claude is read-only truth; files may be absent; NEVER copy a provider API key (INV-7)          | ≤180   | node:fs, node:os, node:path                                 |
| acp/acp-turn-session.ts | Drive ONE persistent ACP session: open → prompt → stream chunks → close                  | openTurnSession, TurnSession | agent chunks UNTRUSTED (caller escapes — INV-13); child may die mid-turn; bounded + always closes | ≤200   | @agentclientprotocol/sdk, ./acp-servers, ./acp-clean-config |
| acp/acp-turn.ts         | Run one agent turn over ACP, returning the reply (adapter-shaped)                        | dispatchAcpTurn              | input validated at the edge; reply is agent bytes; not the live default yet                       | ≤150   | ./acp-turn-session, ../../shared/types                      |

Data flow: cockpit (Phase 2) → dispatchAcpTurn → openTurnSession → {acp-servers spawn spec + acp-clean-config env} → ACP child.
Dependency direction: acp-turn → acp-turn-session → {acp-servers, acp-clean-config} → node/sdk. Acyclic, monotonic, feature-isolated, single-source.
Deletion test: `rm acp/acp-turn*.ts acp/acp-clean-config.ts` breaks nothing outside adapters/acp/ (Phase 1 unwired).

## Boundary decisions (ADRs)

- The model-fetch (acp-session, one-shot newSession) does NOT fire a turn → no Stop-hook → does NOT need the clean
  config. Only acp-turn-session adds CLAUDE_CONFIG_DIR. Two modules, two responsibilities — not merged.
- acp-clean-config is CLAUDE-ONLY (the Stop hooks are ~/.claude-specific). codex turns over codex-acp may not need
  it (codex hooks live in ~/.codex; unverified) — Phase 2 confirms before wiring codex.
- INV-7: the clean config copies ONLY the subscription `.credentials.json` + junctions skills/commands; it never
  writes a provider API key. INV-13: chunks are returned raw; the cockpit lane render escapes them (Phase 2).

## Phase 2 (later) — wire claude+codex turns through dispatchAcpTurn + stream to cockpit lanes (touches the live path).

## Phase 3 (later) — permissions/modes via session/request_permission → the Control Tower.

Enforcement: repo gates already bind this (clamps 500/600, knip dead-code, dep-cruiser no-circular, G1 sibling tests).
