# m0irai CTO audit — findings and evidence

Date: 2026-09-06. Prepared by Codex/Astra for the operator and Claude.

**Read next:** [Claude remediation handoff](2026-09-06-claude-remediation-handoff.md).

## Findings

The eight IDs below preserve the numbering of the audit delivered in chat. They are local audit IDs, not new `FL-*` ledger allocations. All eight remain open in the inspected mainline; a candidate fix on another branch is not a shipped fix.

| # | Severity | File | Finding | Evidence |
| --- | --- | --- | --- | --- |
| ASTRA-001 | IMPORTANT (P1) | [session-store.ts:96](../../src/chat/session-store.ts#L96) | An interrupted transcript overwrite can leave a saved room unreadable; catalog loading silently drops that room. | Direct whole-file `writeFile`; [load failure is converted to an absent entry](../../src/room/zer0-v2-host.ts#L294). Source-confirmed; no crash injection was run. |
| ASTRA-002 | IMPORTANT (P1) | [package-lock.json:3799](../../package-lock.json#L3799) | Production dependencies contain four audit-reported affected packages, including two high-severity packages. | Live `npm audit --omit=dev --ignore-scripts --json` exited 1. `npm ls` confirmed the production ancestry through the bundled Claude adapter. Application exploitability is UNVERIFIED. |
| ASTRA-003 | IMPORTANT (P1) | [lane-carrier.ts:259](../../src/chat/lane-carrier.ts#L259) | Shared-memory briefing can disappear without an operator-visible notice. | The catch returns no briefing. [The fallback recorder](../../src/chat/headless-prompt.ts#L259) only appends a file, has no production reader, and swallows its own write failure. |
| ASTRA-004 | IMPORTANT (P1) | [headless-carrier.ts:388](../../src/chat/headless-carrier.ts#L388) | A stopped turn returning accepted, clean, empty output can be classified as failed and paint the provider unavailable. | The empty-result classifier has no cancellation signal. The [non-carrier twin](../../src/chat/headless-turn.ts#L454) has the same gap; [health classification](../../src/chat/lane-gate.ts#L185) consumes that outcome. |
| ASTRA-005 | IMPORTANT (P1) | [zer0-v2-host.ts:290](../../src/room/zer0-v2-host.ts#L290) | Session discovery and boot catch-up do work for all accumulated sessions. | Listing loads all candidate transcripts concurrently before returning 128. [Boot catch-up](../../src/memory/digest-runner.ts#L270) schedules a child for every other session without a parent-side completed-digest filter. |
| ASTRA-006 | IMPORTANT (P1) | [room-engine-primitives.ts:108](../../src/room/room-engine-primitives.ts#L108) | Paged resync repeatedly scans history from the beginning and copies the published journal per page. | [Caller](../../src/room/room-engine.ts#L277). Current-source synthetic probe: median 1.95 seconds at 100,000 events for paging alone. |
| ASTRA-007 | IMPORTANT (P1) | [ship-gate.mjs:16](../../scripts/ship-gate.mjs#L16) | Repository verification does not enforce complete release-artifact and operator acceptance. | [Package scripts](../../package.json#L16) lack the planned release command; [CI](../../.github/workflows/verify.yml#L37) runs repository verification without the complete staged release layout. This is unfinished M1 delivery scope, not proof the source build cannot run. |
| ASTRA-008 | IMPORTANT (P1) | [oracle-standalone.mjs:234](../../scripts/oracle-standalone.mjs#L234) | The standalone oracle's build-freshness claim is stronger than its timestamp check. | The implementation compares source/output mtimes, skips orphan outputs, and does not establish output-content or schema equality. Clean staged builds mitigate the exposure. |

**Confidence: YELLOW, 85%.** Current source, focused tests, dependency inspection, and a paging probe support these findings. Runtime consequences that were not reproduced remain explicitly qualified. No P0 exploit or unrecoverable-data-loss scenario was reproduced.

## Snapshot and authority

- Source: `D:/m0irai-work`; branch `overnight/2026-08-21`; HEAD `dc6b721b87eba82b2aea09d85bcee8aedc618c56`.
- HEAD tree: `fd3681ebb7e3824dcc525cfe351872009821b8d2`.
- The audit began at `1bd57d2` with an existing handoff edit. An external actor advanced the checkout to `dc6b721`, changing only `docs/HANDOFF-m0irai.md` and `docs/STATE.md`. Runtime source was unchanged.
- The original missing-receipt observation is superseded: `--assert-head` subsequently found a GREEN receipt for the current tree. Do not report the old missing receipt as an unresolved finding.
- The audit made no source, documentation, configuration, index, or commit changes. The later operator request authorizes these two Markdown handoff files only; it does not itself authorize implementing fixes, merging, staging, committing, publishing, or launching live agent turns.
- Mainline source sites and parked branch tips were checked again while preparing this handoff. The workspace was clean before these files were created.
- Line references are pinned to this snapshot and can move. Current files and command output outrank this report.

The existing [STATE](../STATE.md), [handoff](../HANDOFF-m0irai.md), and [v5 plan](../specs/2026-08-17-m0irai-standalone-plan-v5.md) remain the project records. This report does not replace the plan or change product policy.

## CTO assessment

**Recommendation: keep the architecture and prioritize stabilization before feature expansion.** The division between Rust presentation, a TypeScript room host, native-agent adapters, and SQLite evidence is defensible for a local terminal product. The audit found no justification for a language rewrite or a database replacement.

The product hypothesis is credible: persistent native agents sharing project knowledge could reduce repeated explanations and manual handoffs. The inspected evidence does not establish that three-agent collaboration consistently improves accepted code quality, elapsed task time, operator effort, or subscription usage. Treat that advantage as a hypothesis to measure.

| Area | Assessment and implication |
| --- | --- |
| Product idea | Shared context and recoverable evidence are useful differentiators to test. More agents and more messages are not outcome measures. |
| Architecture | The host owns room truth; the terminal owns a display cache. Preserve this boundary when adding corruption and memory notices. |
| Protocol | Validated envelopes, shared conformance fixtures, deterministic reduction, replay handling, and bounded channels are strengths. Changes need proof in both languages. |
| Persistence | WAL, immediate migration transactions, explicit tiers, and foreign-key checks show care. Transcript files alongside SQLite add consistency and recovery obligations. |
| Integrations | ACP, native CLI processes, local patches, PTY behavior, and provider-specific transcripts create continuing compatibility work. Budget for that ownership. |
| Code quality | Strict TypeScript, dependency rules, reachability checks, and meaningful regression tests are useful controls. File size alone does not establish cohesion or simplicity. |
| Maintainability | The inherited Rust renderer carries substantial legacy surface. Remove it selectively when reachability and parity are proven, rather than treating the entire fork as fresh product code. |
| Delivery | Exact-tree receipts and retained failures are good practices. A GREEN repository receipt and a user-tested release are separate pieces of evidence. |

Permission paths inspected generally fail closed. Cleanup has explicit deadlines and process-tree escalation. Preserve those controls while repairing lifecycle classification.

## Finding detail and recommended direction

### ASTRA-001 — transcript integrity and discoverability

`persistSession` overwrites `transcript.json` and then records session evidence. `loadSession` requires valid JSON and schema data. The RPC catalog turns load errors into absent entries; `listSessions` also converts all directory-read failures into an empty list.

**Impact:** interruption or storage failure can leave a room inaccessible through normal resume even if some SQLite/journal evidence survives. Permanent loss of every copy was not demonstrated.

**Direction:** use platform-tested atomic transcript replacement, preserve the last valid file on failure, and give unreadable rooms an explicit, recoverable state. Keep directory-not-found distinct from permission or I/O failure. Preserve identity validation and rebinding to the currently opened repository. Acceptance details are in the companion handoff.

### ASTRA-002 — dependency advisories

Observed production ancestry:

```text
@agentclientprotocol/claude-agent-acp@0.63.0
  @anthropic-ai/claude-agent-sdk@0.3.220
    @modelcontextprotocol/sdk@1.30.0
      ajv@8.20.0 -> fast-uri@3.1.0
      express-rate-limit@8.6.2 -> ip-address@10.2.0
      express/body-parser -> affected qs versions
```

| Package reported by npm | Severity | Observation |
| --- | --- | --- |
| `fast-uri` | high | Installed `3.1.0`; several URI normalization advisories apply. |
| `ip-address` | high | Installed `10.2.0`; address interpretation/classification advisories apply. |
| `body-parser` | moderate | Affected installed `1.20.5` path, including inherited `qs` exposure. |
| `qs` | moderate | Affected copies at `6.14.2`, `6.15.1`, and `6.15.3`. |

The maintained [fast-uri advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc) lists a patched 3.x version of `3.1.6` for malformed IPv6 normalization. The maintained [ip-address advisory](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-mwp4-54f8-5fhr) lists `10.3.1` for leading-zero IPv4 interpretation. These are dated observations, not a permanent instruction to pin those versions.

**Direction:** refresh the advisory data, identify compatible fixes through the owning dependency chain, verify the two local patches, and test the packaged adapter. Do not use `npm audit fix --force` as a substitute for compatibility analysis. Package presence proves exposure to an affected dependency version; actual exploitability in this application remains UNVERIFIED.

### ASTRA-003 — visible memory degradation

The carrier catches briefing composition failure and proceeds with no briefing. The only fallback is an append to `memory-failures.log`; no production consumer of that log was found, and recorder failure is swallowed. `getLaneCursor` and request-file extraction also sit outside the narrow composition catch.

**Direction:** reuse and review the existing MN candidate. Give each failure class one quiet, durable, deduplicated notice per session. Keep raw diagnostics out of the rendered row, bound the diagnostic log, and preserve the fail-soft turn policy. Rendering and replay must agree.

### ASTRA-004 — cancellation classification

Both empty-result classifiers inspect the observer outcome without receiving the turn's cancellation authority. A provider can return an accepted/clean/empty result after stop; the classifier turns it into a generic failure, and health handling can paint the agent down.

**Direction:** carry the existing turn signal to the terminal classification boundary in both paths. Distinguish an operator-cancelled empty result from a genuine empty-output failure. Preserve already-set failures and already-completed useful results; do not indiscriminately rewrite every late result as cancelled. Coordinate with AG's separate empty-Gemini-output work.

### ASTRA-005 — session-growth costs

The result limit of 128 is applied after loading and sorting all candidates. A limit on returned rows therefore does not bound transcript I/O. Sorting is by `updatedAt` with a session-ID tie break, so taking the first 128 directory names earlier would change behavior.

Boot catch-up schedules each other on-disk session at `index * 250 ms`. Staggered starts do not establish a bound on overlapping children. Idempotency inside the child does not avoid the child's startup cost.

**Direction:** use trustworthy bounded metadata discovery while preserving exact ordering, plus controlled fallback/reconciliation for legacy or corrupt metadata. Filter digest candidates using the real durable watermark before launching children, and bound active work. An old watermark must not cause changed or previously failed sessions to be skipped.

### ASTRA-006 — repeated resync work

`resyncPage` copies the complete published journal, then `pageRoomResync` walks from its beginning to find entries after the cursor. [Rust resync](../../rust/crates/zer0-v2-bin/src/host_process.rs#L466) accumulates all pages into one vector before returning them.

**Direction:** seek directly into the ordered published prefix and iterate only the page, preserving decimal sequence ordering, publication boundaries, byte/event limits, and replay semantics. Review the Rust aggregate memory path with an end-to-end measurement before changing its contract.

### ASTRA-007 — complete release proof

The repository has a sidecar packager and a Rust build, but lacks the v5 plan's single release command and its complete acceptance binding. The ship gate checks cleanliness, oracle registration, and the repository receipt. CI's comment promises a Windows release layout that its steps do not produce.

**Direction:** finish the already specified release path: a contained owned output directory, the executable plus sidecar, a declared file manifest and hashes, Node/ABI metadata, packaged checks, and a separate record of authorized live operator acceptance. Source-only distribution does not eliminate the need to prove the assembled layout a source builder runs.

### ASTRA-008 — freshness proof

The standalone oracle checks whether a surviving source `.ts` file is newer than its paired compiled `.js`. Orphan outputs are skipped; newer wrong bytes, missing expected outputs, and stale schema data are not established by that comparison.

**Direction:** bind the actual build inputs and complete runtime outputs with a content manifest generated by the real build/package path. Validate the artifact being tested, including an external staged launcher. Changing documentation alone should not invalidate a runtime-input manifest. Do not replace one weak timestamp heuristic with another.

## Performance evidence

The audit executed the current `pageRoomResync` implementation through `tsx`, with the same full-array copy used by its caller. Each synthetic event was a small `room.paused` envelope; 100,000 events serialized to 19,877,791 bytes, below the declared 64 MiB journal cap. There were three runs per size; fixture construction was outside the timed region; every run checked the delivered count.

| Events | Pages | Run 1 ms | Run 2 ms | Run 3 ms | Median ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 8 | 3.70 | 3.13 | 2.18 | 3.13 |
| 8,000 | 32 | 20.09 | 14.83 | 16.81 | 16.81 |
| 32,000 | 125 | 187.51 | 182.36 | 177.75 | 182.36 |
| 100,000 | 391 | 1,954.72 | 1,929.65 | 2,008.52 | 1,954.72 |

This is a paging microbenchmark, not a measurement of startup, full reload, drawing, model latency, or memory consumption. The executable reproduction is included in the companion handoff. Historic slow-rebuild numbers in comments describe defects already addressed by RP and must not be reused as current application timings.

## Additional observations requiring bounded follow-up

These items were not promoted to additional confirmed P1 findings in the final audit. Do not silently add them to the eight-finding implementation scope.

| ID | Observation and source | Recommended next evidence / possible solution |
| --- | --- | --- |
| FOLLOWUP-01 | [Busy-lane redraw](../../rust/crates/codegen/xai-grok-pager/src/app/room_runtime.rs#L326) occurs on a 132 ms poll; [unchanged-layout preparation](../../rust/crates/codegen/xai-grok-pager/src/scrollback/state/mod.rs#L1980) still [sums cached heights](../../rust/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L1122). | Measure frame CPU at long histories. If material, cache aggregate heights with correct invalidation for folds, navigation, mode, width, and streaming. |
| FOLLOWUP-02 | [Reducer retention](../../rust/crates/zer0-room-protocol/src/reducer.rs#L49) and [presentation state](../../rust/crates/codegen/xai-grok-pager/src/room_scrollback.rs#L93) retain overlapping event/text data. Writer queues bound slot counts, not necessarily frame bytes. | Measure heap/RSS through maximum admitted history, resync, resize, and close. Reduce duplicate ownership or add budgets only with replay/copy/search parity. No OOM was reproduced. |
| FOLLOWUP-03 | [Activity recording](../../rust/crates/zer0-room-protocol/src/reducer.rs#L617) searches by tool-call ID; [presentation updates](../../rust/crates/codegen/xai-grok-pager/src/room_scrollback.rs#L1343) clone/scan activity. | Measure many-tool-call turns. If material, use a keyed index while preserving stable display order and repeated-call updates. |
| FOLLOWUP-04 | [Carrier cancellation](../../src/chat/lane-carrier-cancel-send.ts#L76) closes the ACP connection; in-band cancellation was not found. | Prove stop-after-send behavior and attempt reconciliation against the real adapter. Connection shutdown alone was not established to be incorrect. No automatic switch to in-band cancellation is authorized by this observation. |
| FOLLOWUP-05 | [Fallback PTY dispatch](../../src/chat/pty-session.ts#L192) appeared to lack a signal check between boot/readiness and write. Production reach and timing were not reproduced. | First prove reachability and gate the boot boundary deterministically. If the race exists, check cancellation immediately before sending while preserving queue ownership. |
| FOLLOWUP-06 | [Script scope](../../scripts/gate-scripts-scope.mjs#L2) is intentionally narrower than full JavaScript typechecking; [retained Rust targets](../../rust/crates/codegen/xai-grok-pager/Cargo.toml#L8) include deferred legacy surface. | Address executable-script typing and reachable Rust cleanup as separately bounded work. Do not remove legacy files solely because a crate-level test excludes them. |
| FOLLOWUP-07 | [STATE's September position](../STATE.md) records a prior operator startup timeout under load. The audit did not reproduce it. | Verify the current packaged build on quiet and loaded machines; measure startup phases before choosing a deadline/progress policy. Treat the prose as historical evidence, not a fresh failure. |
| FOLLOWUP-08 | No controlled evidence of improved multi-agent outcomes was established. Full live UX, heap profiling, and Rust dependency security scanning were unswept. | Compare representative single-agent and room tasks on accepted quality, elapsed time, interventions, conflicting edits, and usage. Run the missing technical checks before making broader readiness claims. |

Minor documentation issue: [rust/README.md:27](../../rust/README.md#L27) links to `README.md#running-it`, while the root heading is `Run it`. This is NIT (P2), not a release blocker.

## Verification provenance and limits

The following were run during the preceding read-only audit, not rerun merely to create these Markdown files:

| Check | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS, exit 0. |
| `npm.cmd run lint` | PASS, exit 0; Biome checked 550 files and the configured gates passed. |
| `npm.cmd run dep-check` | PASS, exit 0; 506 modules / 1,576 dependencies; one orphan warning for `src/chat/statusline-emit.cjs`. |
| `npm.cmd run dead-code` | PASS, exit 0. |
| `node scripts/gate-l5-mandates.mjs` | PASS, exit 0. |
| Reachability, tracked-surface, oracle-registration, cut-closure | Each reported PASS. Reachability: 196 production-program files, 203 inventory files, 7 declared test-support files, zero orphans. |
| Seven focused Vitest files, `--no-cache` | PASS: 44 tests; exact command is in the companion handoff. |
| Production `npm audit` | FAIL, exit 1: two high and two moderate affected packages. |
| Current-source paging probe | PASS count assertions; timings above. |
| `node scripts/verify-staged.mjs --assert-head` | Initial failure at `1bd57d2`; superseded by PASS at `dc6b721`. |

The externally produced [current-tree receipt](../../.verify-logs/receipts/fd3681ebb7e3824dcc525cfe351872009821b8d2.json) records `ok: true`, Node `v24.18.0`, `npm ci` exit 0 in 18 seconds, and `npm run verify` exit 0 in 1,051 seconds, from `08:00:04Z` to `08:18:19Z` on 2026-09-06. That run was not launched by this audit. The local receipt is ignored by Git and will not travel with these documents.

Unswept by the audit: a fresh full Rust run, live three-agent execution, packaged installation, crash/power-loss injection, heap profiling, Rust dependency advisory scanning, and comprehensive visual UX testing. A green repository receipt does not close the findings above.

**Product readiness: INCOMPLETE.** The audit and these documents implement none of the proposed fixes.
