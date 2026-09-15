# Module Reality Map — what we actually use (claude)

- **Author:** claude
- **Date:** 2026-08-14
- **Why:** Operator flagged bloat. This is the measured answer, not an estimate.
- **Method:** static import-graph analysis from the single real entrypoint (`bin/zer0.mjs` → `src/cli/index.ts`). Every number below was produced by a command, not recalled.
- **Relationship to [`MODULE-MAP.md`](./MODULE-MAP.md):** that document is **stale** (see §4). This file is a *proposal to replace its DAG*, not a second authority. Do not let both stand — pick one. Two canonical maps is the same failure we just rejected Temporal for.

---

## 1. The headline

> **`docs/MODULE-MAP.md` — the canonical architecture doc — mentions `src/temporal` 36 times and `src/chat` zero times.**

It documents the dead subsystem in detail and does not know the live one exists. ~43,600 LOC of shipping V2 code is invisible to the map that governs the codebase.

> **`knip.config.js` declares `src/temporal/worker.ts!` and `src/temporal/server.ts!` as production entrypoints.**

That is why the dead-code gate has never flagged 6,393 LOC of Temporal. **The dead-code detector has been configured to treat the dead code as a root.** Fix this line and the gate starts telling the truth on its own.

---

## 2. Module size and status

Measured: `.ts` files excluding `*.test.ts`.

| Module | Files | LOC | Status | Reached by |
| --- | ---: | ---: | --- | --- |
| `src/chat/` | 115 | 20,591 | **LIVE** | CLI `chat`, room host |
| `src/tui/` | 61 | 8,236 | **LIVE** | chat cockpit |
| `src/temporal/` | 38 | **6,393** | 🔴 **DEAD** | old build pipeline only |
| `src/memory/` | 37 | 6,096 | **LIVE** | chat, room, reconciler |
| `src/room/` | 19 | 5,237 | **LIVE** | V2 room host |
| `src/cli/` | 40 | 5,133 | **MIXED** | 23 commands, 9 temporal-bound |
| `src/loop/` | 23 | 5,029 | **LIVE** | chat events, cockpit loop |
| `src/adapters/` | 30 | 4,711 | **LIVE** | ACP + agy lanes |
| `src/tower/` | 32 | 4,529 | **LIVE** | chat bridge (10 importers) |
| `src/evidence/` | 22 | 3,621 | **LIVE** | persistence |
| `src/shared/` | 32 | 3,282 | **LIVE** (1 dead file) | everywhere |
| `src/observability/` | 27 | 2,139 | **LIVE** | 7 CLI commands |
| `src/security/` | 3 | 446 | **LIVE** | prompt filter |
| `src/gates/` | 2 | 323 | **LIVE** | quality gate |
| **Total** | **481** | **~75,766** | | |

I checked `tower` and `loop` specifically because their names sound legacy. **Both are live** — `tower` has 10 non-test importers in `src/chat/`, `loop` has 5. Neither is bloat.

---

## 3. The Temporal blast radius — smaller than feared

This is the good news, and it's the part that was being guessed at.

### 3.1 The live V2 path is already clean

```
grep -rln "@temporalio" src/room src/chat src/tui src/adapters src/memory src/evidence
  → NONE
```

**Zero** `@temporalio` imports across room, chat, tui, adapters, memory, evidence. The V2 product does not touch Temporal.

### 3.2 The one cross-boundary edge is a misfiled file, not a dependency

`src/chat/prompt-builder.ts:27` — the live prompt builder, on the hot path for every turn — imports:

```ts
import { compileMemory } from "../temporal/activities/memory-compiler.js";
```

That looks like entanglement. It isn't. `memory-compiler.ts` declares:

```
@depends zod, src/evidence/db, src/evidence/memory-queries,
         src/observability/lessons-reader, src/shared/logger
```

and contains **zero** `@temporalio` references. It is an ordinary module that happens to live in the wrong folder. **One `git mv` frees the entire chat path.**

### 3.3 Complete `@temporalio` surface (20 non-test files)

| Where | Count | Disposition |
| --- | ---: | --- |
| `src/temporal/**` | 15 | delete with the module |
| `src/cli/commands/{approve,cancel,resume,up}.ts` | 4 | delete — old pipeline commands |
| `src/shared/application-failure.ts` | 1 | delete — **all 12 of its consumers are inside `src/temporal/`** |

`application-failure.ts` is misfiled in `shared/` but has no live consumer outside the dead module. It leaves with Temporal.

### 3.4 CLI commands: 23 registered, 9 touch Temporal

```
agy  approve  build  cancel  chat  cost  council  dashboard  diagnose
doctor  down  findings  init  inspect  mandates  perf  replay  resume
start  status  trace  stream  up
```

**Temporal-bound:** `approve` `build` `cancel` `doctor` `down` `resume` `start` `status` `up`

Two groups, and the distinction matters:

- **Delete outright (6):** `approve` `build` `cancel` `resume` `up` — plus `down` if it only stops the Temporal server. These *are* the old build pipeline's surface.
- **Surgery, not deletion (3):** `doctor` `start` `status` — these are general health/lifecycle commands that happen to call `ensureTemporalServer`/`stopTemporalServer`. Strip the Temporal calls, keep the commands.

Getting this wrong deletes a working `doctor`. Worth the ten minutes to check each.

---

## 4. Why `MODULE-MAP.md` is stale

Its DAG places Temporal as a central architectural layer:

```
   src/temporal/{server,client,worker}.ts
   ambient-context Temporal infra
        ↑                    ↑
   workflows/*.ts      activities/*.ts
   DETERMINISTIC ONLY  side effects ALLOWED
```

Mention counts across the whole 422-line document:

| Module | Mentions |
| --- | ---: |
| `src/temporal` | **36** |
| `src/adapters` | 2 |
| `src/room` | 1 |
| `src/memory` | 1 |
| `src/chat` | **0** |
| `src/tui` | **0** |
| `src/tower` | **0** |
| `src/loop` | **0** |

The four modules with zero mentions total **38,385 LOC** — over half the codebase, and all of the actual product.

This matters beyond tidiness: `MODULE-MAP.md` declares itself canonical and states "every BUILD BRIEF MUST cite this map for its packet's owned files." Briefs have been citing a map of a system that no longer ships.

---

## 5. Recommended cleanup, in dependency order

Each step is independently revertable. Do not batch them.

1. **Fix the gate first.** Remove `src/temporal/worker.ts!` and `src/temporal/server.ts!` from `knip.config.js` entries, then run `knip`. Let the tool produce the dead list rather than trusting mine. *This is the highest-value single line in the whole cleanup* — it converts a manual audit into a standing automated one.
2. **`git mv src/temporal/activities/memory-compiler.ts src/memory/memory-compiler.ts`** (+ its test). Update the one import in `prompt-builder.ts` and the `vi.doMock` paths in 4 chat test files. Now nothing live points into `src/temporal/`.
3. **Strip Temporal from `doctor` / `start` / `status`.** Keep the commands.
4. **Delete** `approve` `build` `cancel` `resume` `up` (+ `down` if Temporal-only), `src/shared/application-failure.ts`, and `src/temporal/**`.
5. **Remove** the five `@temporalio/*` dependencies. Verify `npm ls` is clean and the tree shrinks.
6. **Replace the DAG in `MODULE-MAP.md`** with §2 of this file, and delete this file. One map.

**Net: ~6,600 LOC and 5 runtime dependencies removed**, with zero change to the live V2 path.

---

## 6. Honest caveats

- This is **static** analysis. Dynamic `import()`, string-built paths, and shell scripts outside `package.json` won't appear. `scripts/` is only partially audited — `knip.config.js` already documents several manual `npx tsx` entrypoints that no import graph can find. Run step 1 before trusting step 4.
- I did **not** verify tests pass after removal. That's the gate, and it must run before anything is deleted.
- LOC is a proxy for bloat, not a measure of it. `src/chat/` at 20,591 LOC across 115 files is the largest module and is entirely live — size alone is not a defect. If chat needs review, that's a separate cohesion question, not a dead-code one.
- I have not audited `src/tower/` and `src/loop/` for *internal* dead code. They're reachable at the module level; individual exports inside them may not be. Step 1 answers this properly.

---

## 7. The point worth keeping

The reason 6,393 LOC of dead Temporal survived is not that anyone forgot. It's that **two mechanisms that should have caught it were configured to ignore it** — `knip.config.js` named it an entrypoint, and `MODULE-MAP.md` described it as the architecture.

Deleting the code fixes today. Fixing those two files is what stops the next 6,000 lines from accumulating. Do step 1 and step 6 even if the deletions get deferred.
