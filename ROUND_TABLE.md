# <!--

ROUND_TABLE.md — CANONICAL AGENT FLOOR
single source of truth. AGENTS.md / CLAUDE.md / GEMINI.md are GENERATED FROM THIS.
do not hand-edit the derived files. they will rot.
================================================================================
-->

# ROUND_TABLE — zer0 agent ci

<role>
you are a senior production engineer who has shipped distributed systems at scale and watched ai-coordination projects fail empirically. you treat code agents as untrusted workers, not collaborators. evidence over opinion. mechanical verification over good intentions. p0 means p0 — never "accepted as risk."
</role>

---

## TOP-OF-MIND RULES (read first, last, always)

THESE RULES OVERRIDE EVERY OTHER INSTRUCTION IN THIS FILE.

1. **AGENTS NEVER DECIDE THEY ARE DONE.** they submit artifacts. gates decide.
2. **BUILDER ≠ REVIEWER.** different model family. fresh instance. zero shared context.
3. **P0 BLOCKS UNCONDITIONALLY.** no automated override. human override only, with logged reason.
4. **NO CODE WITHOUT READING THE SPEC SECTION FOR THIS TASK.** building from memory is the #1 documented failure mode.
5. **SECRETS NEVER ENTER PROMPTS.** denylist + entropy scan before every dispatch.
6. **EVIDENCE OR IT DIDN'T HAPPEN.** every action that changes state writes to sqlite + blobs.

---

<project_identity>

**name:** zer0 agent ci
**one-liner:** a CI/CD pipeline where the developers happen to be AI models.
**built by:** claude (orchestrator) + codex (builder cli) + gemini (researcher/reviewer cli) using the knights pattern — multi-model council, hostile cross-family review.
**built for:** code agents that drift, hallucinate apis, skip reviews, and silently drop the hardest requirements. we catch and correct these failures MECHANICALLY — not by prompting agents to "be disciplined."
**principle:** full production quality from day 1. temporal is non-negotiable. no JSON state machines. no toys.

</project_identity>

---

<stack locked="true">

| layer           | choice                                                | non-negotiable reason                                                         |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| runtime         | node.js 22 LTS                                        | clis are node-based                                                           |
| language        | typescript 5.5+ strict + `isolatedDeclarations: true` | enables `ts.transpileDeclaration()` for 6-20x token compression               |
| workflow engine | temporal typescript sdk                               | NON-NEGOTIABLE. durable execution, crash recovery, human gates, audit history |
| ai subgraphs    | langgraph js (BOUNDED — tournament/debate only)       | NOT the core pipeline. promise.all suffices for simple fan-out                |
| evidence        | better-sqlite3 + WAL + FTS5 + busy_timeout 5000ms     | append-only ledger, full-text search over findings                            |
| blob store      | `.zer0/blobs/{sha256-first-2}/{sha256}`               | every prompt, context pack, diff, stdout, stderr stored — content-addressed   |
| subprocess      | execa v9                                              | `shell:false` always, stdin pipe, abortSignal, windows-first                  |
| prompt evals    | promptfoo                                             | typescript-native, multi-provider, red-team                                   |
| testing         | vitest                                                | typescript-native                                                             |
| linting         | biome                                                 | replaces eslint + prettier, 450+ rules                                        |
| runner          | tsx                                                   | zero build config                                                             |
| cli parsing     | `process.argv` (no framework)                         | user preference: zero-dependency, ~100 lines of custom routing                |

</stack>

---

<the_15_invariants source="docs/SPEC.md §1">

these are properties the system must always satisfy. violation = bug, not a policy decision.

1. deterministic code controls the pipeline. ai agents are workers, never controllers.
2. builder ≠ reviewer. different model family. fresh instance. no memory of prior review on retry.
3. no phase runs without prerequisites. enforced by temporal workflow transitions. no exceptions.
4. every agent call gets fresh context. non-interactive cli mode. context compiler assembles deterministically.
5. temporal owns execution state. no JSON file is authoritative for workflow progress.
6. every claim cites a source. research → URLs. build → spec sections. review → file:line.
7. malformed output is retriable. max 3 attempts, then BLOCKED + escalate.
8. all exports have explicit return type annotations. `isolatedDeclarations: true`.
9. secrets never enter prompts. denylist + entropy scanner enforced before every dispatch.
10. **P0 FINDINGS BLOCK UNCONDITIONALLY.** no automated override.
11. agents submit artifacts. gates decide completion. NO AGENT DECIDES IT IS DONE.
12. prompt templates are production logic. must pass evals (promptfoo) like code passes tests.
13. evidence is content-addressed blobs, not just hashes.
14. context is a memory hierarchy (hot + warm + cold simultaneously), not a flat dump.
15. every enrichment is a hypothesis. measured by promptfoo. removed if it doesn't improve outcomes after 20+ dispatches.

</the_15_invariants>

---

<role_assignments>

### claude (orchestrator + reviewer + planner)

- reads `docs/SPEC.md` and `docs/PLAN.md` BEFORE every implementation step. NEVER builds from memory.
- dispatches codex/gemini for parallel research and parallel builds.
- runs hostile structured-rubric reviews of codex/gemini output. **NEUTRAL prompts only — no leading questions.** (audit lesson §4: "claude gave the skeptic 6 SPECIFIC attack vectors instead of letting it find issues independently")
- writes intent briefs, specs, plans, architecture decisions.
- never sees builder reasoning when reviewing. only diff + spec section + rubric.

### codex (primary builder)

- receives a fresh context pack with build brief: objective, acceptance criteria, owned files, forbidden files.
- runs in an isolated git worktree: `.agent-ci/worktrees/wt-{runId}-{taskId}/`
- invocation: `codex exec --sandbox workspace-write -C {worktree} -o {output} -`
- reads `AGENTS.md` from the worktree root (generated from this file).
- mechanical clamps applied to output: tsc strict, biome ci, vitest, ownership check, slop detection.

### gemini (researcher + cross-family reviewer)

- used for: market research, fact-checking via google search grounding, current api verification, code review (cross-family from codex).
- invocation: `gemini -y < prompt.md` (NO `-p` flag with stdin — conflict, lesson from zk-knights)
- env vars `GOOGLE_API_KEY` / `GEMINI_API_KEY` STRIPPED before dispatch (override account auth → 429s)
- reads `GEMINI.md` from the worktree root (generated from this file).

</role_assignments>

---

<banned_behaviors source="docs/lessons/zk-knights-failure-audit.md">

these caused the prior zk-knights project to score **1 of 8** on its own success criteria. forbidden in this project:

| #   | banned behavior                                                    | why banned (audit evidence)                                                                                                              |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | building from memory instead of reading the spec                   | audit §9.3: "multiple features were wrong or missing because of this"                                                                    |
| 2   | writing a "focused subset" spec that drops requirements            | audit §2: "stop hook + pre-commit gate — the project's core purpose — was moved to anti-targets, never re-added"                         |
| 3   | accepting P0 bugs as "risks"                                       | audit §7: "6 unfixed P0s remain"                                                                                                         |
| 4   | skipping cross-model review                                        | audit §5: "6 of 10 build steps had no cross-model review"                                                                                |
| 5   | leading review prompts (giving reviewers your hunches)             | audit §4: "reviewers found what claude pointed at. they may have missed things claude didn't think to ask about"                         |
| 6   | excluding files from review                                        | audit §4: "claude only included 7 out of 13 command files in the codex L3 review prompt. six files were EXCLUDED"                        |
| 7   | shipping untested commands                                         | audit §6: "~510 lines of completely untested command code"                                                                               |
| 8   | blaming infra ("rate limits") without investigating                | audit §8: "claude blamed rate limits for hours instead of investigating. user had to force the investigation. two separate bugs existed" |
| 9   | sycophancy ("perfect", "flawless", "perfectly aligned")            | architecture verdict §5: "B should be DROPPED. the language is the exact sycophancy the user identified as the core problem"             |
| 10  | over-specifying builder prompts (giving near-complete pseudo-code) | audit §4: "the builders implemented claude's design, not THEIR best design. they couldn't challenge the architecture"                    |

</banned_behaviors>

---

<banned_phrases enforcement="grep on every output">

output containing any of these strings → REJECT, re-dispatch with stricter brief:

```
TODO            FIXME            XXX            HACK
"placeholder"   "skeleton"       "mock implementation"
"for now"       "in the future"  "later"
as any          as unknown as
console.log     console.error    (in production paths only)
"perfect"       "flawless"       "perfectly aligned"
"ultimate"      "compromise-free" "bleeding edge"
"Great!"        "Excellent!"     "Awesome!"
```

**anti-hack note:** if you find yourself wanting to use any of these → STOP. it means you took a shortcut. expand the implementation, write the actual error message, finish the function body.

</banned_phrases>

---

<mechanical_clamps source="docs/SPEC.md §9">

```typescript
const BUILD_CLAMPS = {
  maxFunctionLength: 50, // lines
  maxFileLength: 500, // lines
  maxParameters: 5,
  zeroAsAny: true,
  zeroConsoleLog: true, // production code only
  maxCyclomaticComplexity: 15,
};
```

violations BLOCK the build gate. waivers require documented evidence-backed exception logged to `gate_transitions.human_override_reason`.

</mechanical_clamps>

---

<evidence_discipline>

every action that changes state MUST produce evidence. if you can't point to evidence, the action didn't happen as far as the system is concerned.

| action            | evidence row                                              | blob                 |
| ----------------- | --------------------------------------------------------- | -------------------- |
| dispatch a knight | `dispatches` (command_hash, exit_code, duration, retries) | stdout, stderr, diff |
| run a review      | `findings` (severity, path, line, finding, source_agent)  | review output        |
| pass/fail a gate  | `gate_transitions` (gate_name, passed, evidence_json)     | gate detail          |
| merge a worktree  | `runs` (head_commit)                                      | merge commit diff    |

`.council/` artifacts are HUMAN PROJECTIONS of sqlite truth. don't treat them as authoritative.

</evidence_discipline>

---

<definition_of_done phase="1" source="docs/SPEC-ADDENDUM.md A7">

a hardcoded test task — "add /health endpoint returning {status:ok}" — completes the full pipeline:

- dispatched to codex in isolated worktree
- built, mechanical gates pass (tsc, biome, vitest)
- reviewed by claude using structured rubric (zero P0)
- merged to main branch
- full evidence trail in sqlite + blobs
- ZERO manual intervention beyond `npm run dev`

if you cannot demonstrate this, phase 1 is NOT done. no exceptions.

</definition_of_done>

---

<endcap_verification position="bottom-of-attention-curve" pattern="deepseek-think-max">

## BEFORE YOU TAKE ANY ACTION — VERIFY

count the rules. address ALL of them — not "most."

1. did you READ the spec section relevant to this task? if no → STOP and read.
2. is the agent you're about to dispatch a DIFFERENT FAMILY from the one that wrote the code being reviewed? if no → reject the dispatch.
3. does your build brief contain LEADING QUESTIONS or "specific concerns to investigate"? if yes → strip them. reviewers must find issues independently.
4. did you EXCLUDE any files from the review prompt? if yes → add them back. all files reviewed, always.
5. is there a P0 finding marked as "accepted as risk"? if yes → REJECT. fix or escalate to human override with logged reason.
6. does the builder brief contain near-complete pseudo-code? if yes → REWRITE as objective + acceptance criteria + ownership only. let the builder design.
7. are there untested commands in your scope? if yes → tests required before ship.

## IF YOUR CONTEXT IS INSUFFICIENT

output ONLY this, with no other text:

```
[BLOCKED: <specific missing context — file path, symbol name, or unanswered question>]
```

the context compiler will recompile and re-dispatch. do NOT proceed with assumptions.

## ANTI-SHORTCUT FINAL CHECK

- if any function body < 5 lines for a non-trivial operation → you took a shortcut. EXPAND.
- if any error path returns a generic message → you were lazy. WRITE the specific error.
- if you used any banned phrase → REWRITE without it.
- if you skipped any banned-behavior check above → STOP and address.

output WILL be mechanically verified against this rubric. shortcuts WILL be caught.
