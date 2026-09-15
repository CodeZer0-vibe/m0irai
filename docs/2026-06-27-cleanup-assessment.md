# Cleanup / Tech-Debt Assessment — 2026-06-27

Branch `chore/l9-cleanup` (worktree), from `feat/zer0-init` @ `94521c1`. Operator asked for an autonomous L9
cleanup pass: "dead files, refactor·organize·split, harden, clean paths." This documents what I found, what
I safely fixed, and what I deliberately did NOT touch (with the reason), so you can direct the rest.

## Bottom line

**The codebase is already clean and well-gated.** A systematic debt audit found essentially nothing rotten.
Manufacturing refactors here would be net-negative (churn + risk on a passing, deliberately-architected,
security-reviewed codebase). I did the one genuinely-safe fix and am deferring the rest to you with reasons —
that is the L9 call, not splitting files to chase a line count.

## Audit (methodology + results)

Ran across `src/` (excluding tests unless noted):

| Signal                                                       | Count | Verdict                                                                                |
| ------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------- |
| TODO / FIXME / HACK / XXX                                    | **0** | none                                                                                   |
| Real skipped / `.only` tests (`it.skip`, `describe.only`, …) | **0** | none — full suite runs                                                                 |
| Type escapes (`as any`, `as unknown as`, `: any`)            | **0** | the 2 raw hits were the word "any" in prose                                            |
| `biome-ignore` / `@ts-ignore`                                | 52    | ALL `biome-ignore format:` (intentional compact wire-types under the clamp) — not debt |
| Empty `catch {}` (undocumented)                              | 1     | **FIXED** — `prompt-builder.ts:126` (try-next-role-file) now has a why-comment         |
| knip dead code (files / exports / prod deps)                 | **0** | gate-enforced; full report clean (1 devDep `promptfoo` warn + cosmetic config hints)   |

## Largest files — all accounted for (NOT debt)

`500` soft / `600` hard clamp ([[reference_repo_file_line_gate]]). The big ones are each justified or cohesive:

- `src/shared/types.ts` 600, `src/evidence/db.ts` 599, `src/temporal/activities/dispatch.ts` 506,
  `src/temporal/workflows/build-packet.ts` 597 → **all `@size-justified`** with documented reasons (build-packet
  explicitly: "splitting risks bundler boundary + replay determinism", see docs/ARCHITECTURE-buildPacketWorkflow.md).
- `src/tui/cockpit-model.ts` 498 — UNDER the soft cap; a cohesive view-model (types + reducer). 17 consumers.
  A types-extraction is possible but it's metric-chasing (not violating, types+reducer are one contract). Skipped.
- `src/temporal/workflows/pipeline.ts` 495 — a single cohesive workflow; same Temporal-determinism caution.

## The one REAL deferred item — needs your call (security-sensitive)

`.council/findings.md` (2026-06-08 chat-full-auto DECISION) flags **`writeCapableMode` + the chatMode read/write
classification** as VESTIGIAL ("flagged for cleanup, harmless meanwhile"). I investigated:

- It lives in `src/chat/message-router-multi.ts` (the **@-for-write trust boundary** — 6 rounds of codex hostile
  review for trust-boundary bugs).
- It is only PARTIALLY vestigial: adapters no longer use its mode for tool-gating, BUT the mode it produces still
  drives **effort + codex web_search** (`chatMode`). So it can't just be deleted — the effort path needs untangling.
- **Risk:** a subtle mistake re-opens a write-capability trust-boundary hole (a security regression that may pass
  gates). **Reward:** modest (naming/clarity). With you away, the risk/reward says DEFER.
- **Recommendation:** when you're back, a focused session: rename/retarget `writeCapableMode` → an effort-only
  selector, drop the dead write-gating branch, and re-run the cross-family trust-boundary review. ~1 session.

## What I changed in this branch

- `src/chat/prompt-builder.ts` — documented the intentional empty catch (try-next-role-file). Zero behavior change.
- This assessment doc.

## Recommendation for the remaining autonomous time

Refactoring a clean codebase is the wrong use of it. The higher-value, lower-risk next step is **product**: the
`/skills` picker over ACP (ACP already advertises `availableCommands` — the same connection the /model picker
proved). It has a UX choice for you (skills are MODEL-INVOKED by description, not "set" like a model — so the
picker is a discover/insert affordance, not a setter). I've left it SCOPED but unbuilt pending your UX steer, to
avoid building the wrong affordance. [[project_native_model_skill_pickers]] [[reference_acp_interactive_skills_solution]]
