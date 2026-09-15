# ADR-009 — Defer self-healing automation to packet-12

**Status:** Accepted
**Date:** 2026-05-05
**Source:** codex hostile critique §"Self-healing loop: out of scope for packet-10" + gemini synthesis (designed it but agreed deferral is right)

## Context

The user's vision is a self-debugging system: when something breaks, agents read the evidence, diagnose, propose a fix, optionally apply it. Two scopes:

1. **Manual triggered** — `zer0 propose-fix <run-id>` runs a Diagnoser agent, outputs `failure-context.md`, human reviews, dispatches Healer manually. (Available from packet-10.)
2. **Automated loop** — Sentinel watches event stream, auto-dispatches Diagnoser on failure, Healer auto-generates patch, human approves via `zer0 approve <patch-id>`, Verifier runs failing gate against patched code, regression triggers revert. (Future packet.)

Codex's argument: "The system is only 38% built per `docs/HANDOFF.md`. Automatic self-modification before full evidence durability creates a failure loop: bad diagnosis writes a patch, gates fail, evidence is incomplete, next agent learns from corrupted context."

Gemini's argument: "Self-healing should ship in packet-11 with human approval gate."

## Decision

**Packet-10 ships the FOUNDATION for self-healing. The LOOP itself defers to packet-12.**

What packet-10 ships:

- Stable error code catalog (ADR-implicit-error-codes)
- Error fingerprinting (ADR-011) — Diagnoser can group repeats
- Append-only causal history (ADR-003) — Diagnoser can read full timeline
- `failure-context.mjs` script — produces agent-ready repair brief
- Replay-complete dispatch columns (argv_json, cwd, env_allowlist_version, context_blob_hash, model_version, repo_commit) — Healer can reproduce failure deterministically

What packet-12 ships (deferred):

- Sentinel detector — Temporal child workflow `failureWatchWorkflow` subscribes to `error-raised` events
- Diagnoser activity — dispatches gemini (cheapest tokens) with failure-context input, outputs `FixProposal` JSON
- Healer activity — dispatches codex with FixProposal, outputs `.patch` file in `.zer0/runs/{id}/proposed-fixes/{ulid}.patch`
- Approval gate — `zer0 approve <run-id> <patch-id>` signal; auto-applies patch in fresh worktree only after explicit human signal
- Verifier — runs the EXACT failing gate against patched code; PASS emits `fix-verified`, FAIL emits `regression-detected` and discards patch

## Consequences

**Positive:**

- Packet-10 stays focused on observability (its primary responsibility)
- Manual workflow available NOW: `failure-context.mjs` outputs repair brief, human dispatches Healer when desired
- Packet-12 has firm foundation when it ships — the data model already supports automation
- Risk of corrupting feedback loop is contained: humans gate every patch application

**Negative:**

- The user's vision of "system fixes itself" is N packets away — but quality gate is more important than feature speed (per user directive 2026-05-05: "no MVP, no hurry, quality > fast")
- Some overlap risk: packet-12 may want to refactor `failure-context.mjs` output structure — MITIGATED by versioning the FailureContext schema; packet-12 can target schema v2 while v1 stays for human use

## Locked design preview (for packet-12 brief author)

Sequence (gemini-provided ASCII, refined):

```
Runner ─(fails)──► event log ─► Detector (failureWatchWorkflow)
                                    │
                                    ▼
                              Diagnoser (gemini) ─(FixProposal)─► Healer (codex)
                                                                       │
                                                                       ▼
                              Healer ─(.patch)─► [APPROVAL_REQUIRED] ─► Human
                                                                          │
                                                                          ▼
                                                      Verifier ◄────── apply
                                                          │
                                               ┌─ PASS ──►  fix-verified
                                               │
                                               └─ FAIL ──►  regression-detected → revert
```

Diagnoser prompt template structure (locked for packet-12):

- Input: `failure-context.json` (sidecar from `failure-context.mjs`)
- Constraints: gemini cheapest tokens; fingerprint check first; output `FixProposal` JSON validating against schema
- Banned: writing files, modifying source, dispatching subagents

Healer constraints:

- `--sandbox workspace-write` BUT in a FRESH `.agent-ci/worktrees/{patch-id}/` worktree, not main repo
- Output: a unified diff patch file; NEVER direct writes to `src/` or main branch
- Banned phrases enforced
