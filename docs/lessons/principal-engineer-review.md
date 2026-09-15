# Principal Engineer Review: SPEC-CANONICAL v4.0

**Reviewer:** zer0
**Date:** 2026-05-03
**Verdict:** The spec is good. Stop writing specs. Ship the spike.

---

## What a real Principal Engineer at Google/Anthropic would say

### The uncomfortable truth

You have:

- 4 architecture documents (3,225+ lines)
- 15 research reports
- 7 candidate evaluations
- 3 context management deep-dives
- 2 prompt enrichment studies
- 0 lines of running code

The user's ORIGINAL complaint was: "agents produce specs and plans but not working code." We've been doing the exact same thing for an entire session — producing impressive documents that don't compile.

A team of 3 senior engineers would have:

1. Spent 2 hours on architecture (not 2 days)
2. Written the spike in an afternoon
3. Based on spike results, built the simplest pipeline that works
4. Tested it on a real project within the first week
5. Iterated based on what actually FAILS in practice

We've been doing step 1 for the entire session.

### What's genuinely good about SPEC-CANONICAL

1. **The three-subsystem split** (Intent Compiler, Context Compiler, Prompt Quality Lab) is clean, well-motivated, and each solves a different problem. This is solid architecture.

2. **The Intent Compiler** is a genuine innovation. No existing tool does vibe→senior translation with evaluation infrastructure. This is the product's differentiator.

3. **ts.transpileDeclaration()** for 6-20x token compression is a real technical insight verified from compiler source code. This alone is worth the research investment.

4. **The 6-layer attention-curve prompt assembly** is backed by "Lost in the Middle" research. Costs nothing to implement (it's string ordering) but meaningfully affects output quality.

5. **Domain Pattern Library** with OWASP ASVS + prodlint fills a confirmed market gap (searched 8,340+ repos, nothing does feature-type-aware requirement injection).

6. **The 12 critical corrections** prevent specific documented failures. These are real.

7. **The SQLite evidence ledger** gives "what exactly did the agent see?" for any dispatch, forever. This is the right call over JSON.

### What's wrong or missing

**1. No data flow diagram.**
The spec describes subsystems but doesn't show how data actually flows. A principal engineer needs to trace: user types "build auth" → what happens at each step → what file is produced → what the next step reads. Without this, the spec is a parts list, not an architecture.

**2. No concrete prompt templates.**
The 6-layer structure is described. The Intent Compiler is described. But the actual PROMPT that goes to Claude to produce an IntentBrief? Not shown. The actual PROMPT that goes to Codex to build a task? Not shown. These are the most important artifacts in the entire system and they're described abstractly.

**3. The Temporal decision is intellectually dishonest.**
The spec says "Temporal TypeScript SDK" as the workflow engine. The confidence table says "YELLOW 70% — untested." You can't call a decision "made" at 70% confidence. Either test it and confirm, or admit the decision is pending.

**4. No cost model.**
Agent CI estimated $2-6 per pipeline run. Our spec doesn't validate this. If Intent Compiler + 3 research agents + spec + architecture + plan + 20 build tasks + reviews costs $50-100, the user needs to know before committing.

**5. The enrichment assumption is untested.**
We say "inject OWASP ASVS requirements as agent constraints" and assume agents follow them. But agents might: ignore injected requirements, hallucinate compliance, or produce code that superficially matches. The strongest evidence (aider conventions A/B) is for a 2-line file, not 42 injected requirements. Does quality keep scaling with more injected requirements, or does it plateau or degrade?

**6. 5-6 weeks for a CLI tool.**
The build order has 7 phases estimated at 5-6 weeks. The user vibecodes 15 hours/day. That's 525-630 hours. Claude Code itself was probably built in less time. Are we overscoping?

**7. Confidence numbers are overconfident.**
"GREEN 96% architecture direction" for a system with zero running code? That's not confidence — it's hope. Honest number: UNKNOWN until spike passes, then reassess.

---

## The Temporal Decision — Final Honest Assessment

Three documents say use Temporal. One (ours) says don't. The SPEC-CANONICAL hedges with "fallback."

**Here's what actually matters:**

Temporal's TypeScript SDK has 5 years of production use. It handles crash recovery, retries, timeouts, human gates, and visibility. These are real features that custom code will get wrong in edge cases.

BUT: Temporal requires an external server process, Webpack bundling for workflow sandboxing, and has ~237MB of dependencies.

**The HONEST question is not "Temporal vs custom." It's: "Is the complexity budget worth it?"**

For a single-user desktop CLI that runs 8 sequential steps:

- Temporal gives: crash recovery, retry, timeout, human gates, audit trail, web UI
- Custom gives: the same 5 things in ~300 lines, minus the web UI

The REAL argument for Temporal is the **web UI** (free workflow visibility) and **battle-tested edge cases** (what happens when the process is killed at the exact moment a file write completes but before state is updated?). Those edge cases WILL bite us in custom code, eventually.

The REAL argument against Temporal is **operational friction** (external server, Webpack, 237MB) and **debugging opacity** (when something goes wrong in a Temporal workflow, you debug through Temporal's abstractions, not your own code).

**My actual recommendation:** Run the spike. If Temporal installs and runs cleanly on Windows in under 5 minutes, use it. If it requires troubleshooting, workarounds, or Docker — use custom pipeline. The decision should take 30 minutes of testing, not 2 days of analysis.

---

## What the SPEC-CANONICAL should become

The SPEC-CANONICAL is 90% right. It doesn't need another rewrite. It needs:

1. **The spike results** — which resolve the Temporal question permanently
2. **Data flow diagram** — one page showing how data moves through the pipeline
3. **3 concrete prompt templates** — Intent Compiler prompt, Build prompt, Review prompt
4. **A cost estimate** — rough token count for a full pipeline run
5. **A validation experiment** — one vibe prompt run through raw agent vs Intent Compiler, compared

These 5 things turn the spec from "good architecture document" into "buildable blueprint."

---

## The REAL next step

Stop writing specs. Stop comparing documents. Stop producing reports.

Run the Phase 0 spike:

1. `npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity` — does it install on Windows?
2. `temporal server start-dev` — does the dev server run?
3. Create a minimal workflow that calls `claude -p "say hello"` via execa — does it work?
4. `npm install better-sqlite3` — prebuilt binaries work?
5. `ts.transpileDeclaration()` on a test file — works?

30 minutes. 5 pass/fail results. Every open question answered.

Then build Phase 1. Then test on a real project. Then iterate.

The spec is good enough. It will never be perfect. Ship.
