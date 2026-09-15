# Claude handoff — m0irai audit remediation

Date: 2026-09-06. Baseline: `dc6b721`, branch `overnight/2026-08-21`.

**Start with:** [CTO audit, evidence, and limitations](2026-09-06-astra-cto-audit.md).

## Purpose and authority

This is a task-specific implementation proposal for the eight findings in the audit. The operator requested Markdown files for Claude. Preparing these documents did not authorize code mutation, merging, staging, committing, publishing, or live provider use. Apply the operator's current execution authorization when this handoff is dispatched; do not infer it from the presence of a checklist.

Read the current repository instructions, [STATE](../STATE.md), [handoff](../HANDOFF-m0irai.md), and [v5 plan](../specs/2026-08-17-m0irai-standalone-plan-v5.md). This file does not create a new plan version or standing agent policy. Preserve unrelated work and use the existing workflow/review requirements.

## Re-establish the live state

```powershell
git status --short
git branch --show-current
git log -5 --oneline
git worktree list
git diff --stat dc6b721..HEAD
node scripts/verify-staged.mjs --assert-head
```

At preparation time, runtime source remained identical to the audit baseline, and HEAD had a GREEN exact-tree receipt. The two new handoff files are intentionally unstaged. Do not use the existing receipt to claim a later modified tree is verified.

These are local audit IDs (`ASTRA-001` through `ASTRA-008`). Reconcile them with the existing `FL-*` ledger when integration is authorized; do not allocate duplicate findings from scratch or overwrite the ledger as part of discovery.

### Existing work to inspect before implementing

| Candidate | Observed tip | Overlap / constraint |
| --- | --- | --- |
| `mn-memory-notice` | `dacf356` | ASTRA-003: durable memory notice, bounded logging, Node/Rust protocol and replay work. Candidate source exists; review status must be established live. Its Rust changes overlap RP already on mainline. |
| `ag-agy-transcript` | `9352853` | Gemini transcript continuity. Coordinate ASTRA-004 and text-less-result wording with this candidate; its presence does not prove the cancellation gap is fixed. |
| `h2-hermetic-gates` | `009f163` | Hermetic seams, tracked-surface/cut-closure, and receipt-producer changes. Integration overlaps verification work. It must not be described as the content-manifest fix without checking the actual diff. |
| SL brief | `session-store-integrity.md` | Existing external task brief overlaps ASTRA-001. STATE records it as not started; verify that before duplicating work. |
| PB brief | `perf-boot.md` | Existing external task brief overlaps ASTRA-005. STATE records it as not started; verify that before duplicating work. |

`git worktree list` showed candidate and review worktrees for MN, AG, and H2. A review worktree's existence is not proof that review completed. Do not reset, delete, or repurpose them. Locate the external SL/PB brief roots from the current project handoff rather than guessing paths.

## Recommended sequence and effort

1. Reconcile existing candidates and reproduce the narrow gaps against the current tree.
2. Repair transcript integrity, visible memory degradation, and cancellation classification (ASTRA-001/003/004).
3. Update or disposition affected dependencies with adapter compatibility proof (ASTRA-002).
4. Bound session discovery/digest work and remove repeated resync scans (ASTRA-005/006).
5. Implement content-bound build verification, then wire complete release acceptance (ASTRA-008/007).

Use one mutation owner at a time. Independent read-only investigation, tests, and review can be parallel where the governing instructions permit. Keep implementation ownership clear across `session-store`, carrier outcomes, protocol/UI notices, and verification scripts.

Planning estimate from the audit: **3–5 focused working days; reserve one week**. Urgent correctness work is approximately 1–2 days; dependencies 0.5–1 day; session/performance work 1–2 days; release/freshness work about one day, with some overlap and reuse possible. Provider incompatibility or new live failures can extend this to 1–2 weeks. This estimate excludes broad Rust cleanup and a product-efficacy study; it is not a guarantee or permission to weaken checks.

## ASTRA-001 — preserve a valid transcript and expose unreadable rooms

**Outcome:** an interrupted or failed save preserves the last usable transcript; the operator can distinguish an unreadable saved room from having no rooms.

**Owning surfaces:** `src/chat/session-store.ts`, its tests, `src/room/zer0-v2-host.ts`, and the existing catalog/error consumer. Review the SL brief first. Any new wire state must be carried through the protocol and Rust consumer explicitly.

**Recommended implementation:**

- Write a unique temporary file in the transcript's directory, flush/close it as required by the intended durability guarantee, and use a platform-tested atomic replacement. Bound retries for transient Windows sharing failures. Never unlink the valid destination first.
- Serialize persistence for the same logical session using the current owner; verify same-session concurrent writers rather than assuming atomic rename resolves logical overwrite races.
- Keep evidence ordering and failure reporting explicit. A valid transcript plus failed SQLite metadata write must have a documented recovery path; do not pretend two independent stores form one transaction.
- Report corrupt/unreadable catalog entries through an explicit typed path. Treat missing directories as empty; surface permission and I/O failures. Preserve `loadSession` identity checking and current-repository path rebinding.

**Acceptance and falsifiers:**

- Interrupt after temporary write but before replacement: the previous transcript still loads; no partial destination is visible.
- Inject replacement failure: the previous file is unchanged, the failure is reported, and temporary-file cleanup is bounded.
- Malformed JSON, ID mismatch, and permission failure do not silently masquerade as an empty catalog. A valid neighboring room remains accessible.
- Concurrent saves do not reverse the accepted logical ordering. Scope any power-loss claim to tested platform guarantees.
- Normal create/save/load/continue and SQLite evidence behavior remain intact. Tests must be able to fail against the direct-overwrite baseline.

## ASTRA-002 — repair dependency exposure without breaking native adapters

**Outcome:** each reported production advisory has either a compatible tested fix or an explicit, evidence-backed disposition. A failure of the audit command must remain visible.

**Owning surfaces:** `package.json`, `package-lock.json`, the two declared dependency patches, adapter tests, packaging, and CI only where needed. Do not hand-edit installed `node_modules` as the fix.

**Recommended implementation:** refresh `npm audit` and package ancestry, read primary advisories, choose the smallest compatible update through the owning dependency chain, and inspect lockfile/patch changes. Prefer an upstream dependency update; use an override only after proving compatibility and documenting its owner and removal condition. Avoid forced blanket upgrades or blanket advisory suppression.

**Acceptance and falsifiers:**

- Fresh install passes the patch lifecycle and `gate-patches`; retained patch behavior is tested, not merely its application.
- Claude/Codex adapter initialization, permission decisions, streaming, cancellation, usage, and shutdown retain their contracts; the affected Claude adapter is tested from the staged sidecar.
- Current production audit is green, or every remaining finding has a scoped reachability analysis and an operator-accepted residual risk. Do not equate a transitive dependency with a demonstrated application exploit.
- The production lockfile and packaged dependency tree agree. A recurring dependency scan reports failures without running auto-fixes.

## ASTRA-003 — make memory failure visible once, including after reload

**Outcome:** chat remains usable when memory is unavailable, and the operator receives one quiet durable notice per session and cause.

**Owning surfaces:** review MN first; likely carrier/headless memory composition, the host's notice owner, protocol schema and corpus, Rust event/reducer/scrollback, and diagnostic logging.

**Recommended implementation:** integrate or complete the reviewed MN solution instead of building a parallel notice mechanism. The host owns durable deduplication; replay reconstructs it. Emit safe classified messages, retain detailed diagnostics separately, and cap logs. Cover cursor reads and request-file extraction as well as briefing composition. Use the candidate's actual current event contract; do not guess a name from historical prose.

**Acceptance and falsifiers:**

- Inject failures at DB open, scope/cursor read, extraction, briefing selection/composition, and diagnostic-log write. Each preserves the specified turn behavior and produces the appropriate visible classification when the durable event path is available.
- Repeated same-cause failures do not spam; a distinct cause is distinguishable. Reload preserves the row without duplicating it.
- Live and rebuilt scrollback agree in modern and legacy consoles. Raw errors, paths, and attacker-controlled diagnostic text are not painted as the notice.
- Protocol validation and conformance fixtures pass in both languages. Define the fallback when the event journal itself is unavailable; never claim a durable notice was recorded if that write failed.
- Healthy memory injection and byte budgets remain unchanged.

## ASTRA-004 — treat a cancelled empty turn as cancellation

**Outcome:** an operator stop does not mark a healthy provider unavailable merely because an accepted result is empty.

**Owning surfaces:** both empty-result classifiers in `src/chat/headless-carrier.ts` and `src/chat/headless-turn.ts`, terminal outcome/observer helpers, `src/chat/lane-gate.ts`, and adjacent tests. Coordinate with AG.

**Recommended implementation:** carry the existing turn cancellation signal to the precise clean-empty classification boundary. Reuse the existing outcome vocabulary and health policy. Avoid a late blanket override of every result whenever a signal happens to be aborted; preserve terminal outcomes that already settled and useful output according to the existing contract.

**Acceptance matrix:**

| Input state at the classification boundary | Required result |
| --- | --- |
| Accepted, empty, cancellation won | Cancelled; no new provider-down or auth failure signal. |
| Clean empty result, no cancellation | Genuine empty-output failure remains visible. |
| Already failed or timed out | Existing terminal classification preserved. |
| Already completed useful output; later unrelated abort | No retroactive corruption of a settled success. |
| Partial output followed by cancellation | Existing partial-text retention and cancellation policy preserved. |

Run the same controlled race cases through both carrier and non-carrier paths. Cover provider state `ready`, sanctioned retry, and pre-existing exhaustion/auth failure; cancellation must neither invent failure nor clear an existing real block. Use barriers, not fragile sleeps.

## ASTRA-005 — bound discovery and digest catch-up

**Outcome:** accumulating old sessions does not cause unbounded concurrent transcript reads or unnecessary digest process launches.

**Owning surfaces:** session metadata/listing, RPC catalog, digest-runner and durable watermark queries; inspect PB and SL first. Coordinate metadata integrity with ASTRA-001.

**Recommended implementation:**

- Preserve the catalog's latest-by-`updatedAt` ordering, session-ID tie break, V2 filtering, 128-result limit, and unsupported-cursor behavior. Taking 128 directory names before sorting is incorrect.
- Use existing indexed metadata only after proving freshness and coverage. Session metadata writes are currently best-effort, so SQL rows cannot simply replace disk truth without reconciliation. Keep heavy transcript I/O bounded, including legacy/corrupt cases.
- Determine pending digest work from the existing durable watermark and session freshness before process creation. Keep the child's idempotency/lease checks as the final authority against races.
- Bound active children and queued work explicitly. A launch every 250 ms is not a concurrency limit. Preserve immediate boot return, attached-session exclusion, shutdown behavior, and recovery of unfinished work on a later boot.

**Acceptance and falsifiers:**

- Many large historical transcripts do not create one simultaneous read per session. Latest-128 results match a reference full sort, including an old room updated recently and tied timestamps.
- All-complete histories launch no unnecessary digest children; changed-after-watermark sessions and failed digests remain eligible.
- Missing/stale metadata, corrupt transcripts, concurrent session updates, child errors, and active leases have explicit behavior.
- Active work stays at or below the declared cap; immediate return and close-digest behavior remain correct.
- Record cold/warm startup, listing, process counts, and I/O at increasing history sizes. Preserve exact digest facts and replay idempotency.

## ASTRA-006 — seek to the resync cursor

**Outcome:** paging work grows with returned history, without repeated prefix scans or full-journal copies per page.

**Owning surfaces:** `src/room/room-engine.ts`, `room-engine-primitives.ts`, page tests, and Rust resync only if measured aggregation work justifies that additional change.

**Recommended implementation:** find the first published event after the requested decimal sequence with a safe ordered index/binary search, then scan only the page. Respect the published prefix; never expose events whose durable write is pending or failed. Do not coerce sequence strings to JavaScript `Number` or assume contiguous sequence numbers without proving that invariant.

**Acceptance and falsifiers:**

- Empty history, cursor zero, exact cursor, between-event cursor, cursor beyond the tail, large decimal values, and invalid input keep existing semantics.
- Every intended event appears once, ordered; `hasMore`, 256-event cap, 512 KiB budget, and the existing first-oversized-event progress rule are preserved.
- Concurrent append/publication and failed-write cases do not leak unpublished events or lose a boundary event.
- A structural work counter fails when the old prefix scan/full copy returns. Use it alongside timing; do not introduce tight wall-clock CI assertions.
- Rerun the probe below and an end-to-end host/Rust resync. Distinguish pure paging time from transport, reduction, drawing, and peak memory.

### Reproduce the audit's paging measurement

Run from the repository root using the installed `tsx` dependency. This reads current source, creates only in-memory synthetic events, and disables the loader cache. The `.slice()` deliberately mirrors the audited production caller; adapt the benchmark to the final production entry point after the fix.

```powershell
$env:TSX_DISABLE_CACHE = '1'
$auditProbe = @'
import { performance } from "node:perf_hooks";
import { pageRoomResync } from "./src/room/room-engine-primitives.ts";
for (const n of [2000, 8000, 32000, 100000]) {
  const events = Array.from({ length: n }, (_, i) => ({
    protocol: "zer0.room", version: 1, sessionId: "chat-audit",
    eventSeq: String(i + 1), eventId: `audit-${i + 1}`,
    turnId: "room-control", occurredAt: "2026-09-06T00:00:00Z",
    type: "room.paused", payload: {}
  }));
  const ms = [];
  let pages = 0, delivered = 0;
  for (let run = 0; run < 3; run++) {
    let after = "0";
    pages = 0; delivered = 0;
    const started = performance.now();
    for (;;) {
      const page = pageRoomResync(events.slice(), after);
      pages++; delivered += page.events.length;
      after = page.events.at(-1)?.eventSeq ?? after;
      if (!page.hasMore) break;
    }
    ms.push(Number((performance.now() - started).toFixed(2)));
    if (delivered !== n) throw new Error("replay count mismatch");
  }
  process.stdout.write(JSON.stringify({
    events: n, pages, delivered,
    serializedBytes: Buffer.byteLength(JSON.stringify(events)), ms
  }) + "\n");
}
'@
$auditProbe | node --import tsx --input-type=module
```

## ASTRA-007 — bind release acceptance to the actual artifact

**Outcome:** one reproducible release path assembles the executable and host, proves their runtime contents, and separates automated artifact proof from authorized operator acceptance.

**Owning surfaces:** package scripts, sidecar packaging, the planned release script, Rust executable staging, manifest/checksum logic, CI, and ship-gate/receipt consumers. Follow v5 Phase 6; do not invent a new installer or deployment service.

**Recommended implementation:** create an owned, contained staging directory; build the required Node and Rust outputs; install production dependencies and patches; copy the declared file set; generate hashes and Node-major/ABI metadata; verify the packaged entry and digest entry; run the packaged oracle. Bind records to the exact artifact and relevant source tree, without a self-referential manifest hash.

Use an ownership marker and resolved path-containment checks before any cleanup. Do not delete or overwrite the operator's existing demo installation as a convenience. CI runs hermetic packaged checks; real credentials and live provider acceptance remain separate.

**Acceptance and falsifiers:**

- A fresh checkout builds the documented layout without ambient `dist`, sibling source roots, runtime TypeScript loaders, or development dependencies.
- Missing host, executable, digest entry, schema, native addon, or declared runtime file fails with a useful error. Unexpected files/hashes fail the manifest check.
- New/load/continue, explicit shutdown, EOF, and digest handoff work from the packaged artifact in a disposable project.
- Node/ABI mismatch gets the policy specified by v5; native-addon loading is tested, not assumed from metadata.
- CI actually runs the layout it claims to test. Artifact acceptance records cannot be reused for another build.
- After separate authorization, record a real three-agent turn and operator acceptance, including any unavailable provider as an explicit gap. An automated handshake cannot stand in for that turn.
- Publishing and final export retain their existing separate authorization boundaries.

## ASTRA-008 — validate build contents, including external staged output

**Outcome:** the oracle rejects mismatched or incomplete runtime output even if all timestamps look fresh.

**Owning surfaces:** build/clean/copy-schema scripts, standalone oracle, sidecar packaging, manifest validation, and their tests. Inspect H2 changes to the receipt producer before editing overlapping files.

**Recommended implementation:** generate a deterministic build-content manifest from the actual production input closure, relevant compiler/build configuration and dependency pins, and the complete output file set including `schema.sql`. A build failure must not leave a usable success manifest. Validate bytes and set membership, not just mtimes. The release verifier must validate the supplied staged artifact rather than unrelated repository `dist`.

**Acceptance and falsifiers:**

- Change output bytes while advancing its mtime: rejection.
- Add an orphan output, remove an expected output, or change `schema.sql`: rejection.
- Change a production input, relevant compiler option, or dependency pin without rebuilding: rejection.
- Change unrelated documentation or a nonproduction test: no false runtime-staleness claim.
- Partial failed builds cannot reuse a previous success manifest; clean repeated builds are deterministic under the declared inputs.
- A valid current source build plus a corrupted external staged sidecar is rejected when testing that sidecar.
- Preserve clean staged verification and oracle registration; register intentional oracle changes under the existing repository process.

## Verification and final closeout

Define a failing test or other decisive falsifier before each material repair. Use source-based diagnosis for the known causal owners; use the repository's diagnostic workflow when a reproduction reveals multiple plausible owning layers. Preserve migration, permission, ordering, cancellation, and replay invariants.

The audit's limited baseline test command was:

```powershell
npm.cmd test -- src/room/room-protocol.test.ts src/room/room-recovery.test.ts src/room/room-recovery-matrix.test.ts src/chat/session-store.test.ts src/memory/carrier-budget.test.ts src/memory/memory-safety.test.ts src/chat/lane-carrier-memory-safety.test.ts --no-cache
```

It passed 44 tests in seven files. It does not prove any future fix. Add the relevant fault/race/scale tests described above and run the owning suites.

At authorized integration, run the repository commands individually and retain each exit code. Stop on an unexpected failure; the last command's success does not certify earlier commands:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run dep-check
npm.cmd run dead-code
node scripts/gate-l5-mandates.mjs
node scripts/gate-reachability.mjs
node scripts/gate-tracked-surface.mjs
node scripts/gate-oracle-registration.mjs
node scripts/gate-cut-closure.mjs
npm.cmd audit --omit=dev --ignore-scripts --json
npm.cmd run verify
```

`verify` owns the complete Node/Rust proof; run Rust verification from the repository root. After authorized staging and inventory/registration reconciliation, prove the exact index with `verify:staged` before any authorized commit. Do not stage merely to run a check when staging has not been authorized. The two handoff files are not automatically enrolled in tracked-surface inventory while they remain untracked.

Required independent review and risk audit follow the repository's current contract. Review the final state after the last mutation; do not substitute a candidate branch's old review or this audit for that gate. Report any unavailable independent gate honestly.

Final handback should list, for each ASTRA ID: changed files, causal fix, failing-before/passing-after proof, final validation, remaining gaps, and candidate-branch reconciliation. Keep diagnostic text redacted. Report `VERIFIED COMPLETE` only when every applicable acceptance item passes; otherwise use `IMPLEMENTED, UNVERIFIED` or `INCOMPLETE` with the precise missing proof/work.

The additional `FOLLOWUP-*` observations in the audit are a separately scoped investigation backlog. Do not roll broad Rust refactoring, alternative ACP cancellation, market research, or product-efficacy experiments into this repair batch without an accepted reason.
