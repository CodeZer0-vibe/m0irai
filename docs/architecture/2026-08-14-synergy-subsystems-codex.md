# Zer0 Agent Synergy: Independent Subsystem Research — Codex

**Date:** 2026-08-14  
**Status:** Architecture research and recommendation; no implementation authorized  
**Source reviewed:** `2026-08-13-agent-synergy-tool-architecture.md`  
**Independence:** This is Codex's separate assessment. I did not use the Claude or Gemini subsystem-review files.

## Executive decision

The best design is a deliberately small hybrid, not a new all-purpose orchestration platform:

1. Keep the existing room engine as the live teamwork scheduler and visible source of room activity.
2. Give Claude, Codex, and Antigravity the same lane-scoped local `stdio` MCP server.
3. Keep authority in the Zer0 host. The MCP process is a narrow adapter, never an independent policy or persistence owner.
4. Start with one read-only sentinel/context tool. Preserve the current final-line teammate handoff instead of adding a second handoff protocol.
5. Persist only coordination lifecycle events that need recovery or audit, alongside normalized current-state tables and content-addressed blobs.
6. Do not use Temporal anywhere in the target V2 architecture, do not event-source the whole product, and do not expose write/check tools before worktree, lease, process, and receipt safety exists.

This is the strongest combination because every chosen part has one job and one owner. It also respects the existing product decision that one-hop teamwork should remain small, visible, and skill-taught rather than becoming a hidden orchestration layer.

**Recommendation status: PROCEED AFTER REVISION.** Replace the custom Antigravity JSON bridge and global-ledger-first sequence in the source proposal with the sliced rollout below.

## How I evaluated each part

“Latest” is useful only when it is also compatible and operationally justified. I scored each subsystem against six questions:

- Does it preserve Zer0's visible, operator-led room model?
- Is there one authoritative owner for policy and state?
- Can it recover truthfully after cancellation, crash, or restart?
- Does it work across the three real installed providers?
- Is its security boundary explicit rather than implied?
- Can Zer0 prove it with a small reversible experiment before committing to migration cost?

## Car-parts map

| Car part | Software job | Recommended part | Decision |
| --- | --- | --- | --- |
| Chassis | Product and teamwork contract | Existing visible one-hop room model | **KEEP** |
| Intake manifold | Provider connection | ACP descriptors for Claude/Codex; ephemeral workspace MCP config for Antigravity | **PROVE** |
| Drivetrain | Common agent-to-host path | One lane-scoped `stdio` MCP shim backed by a host broker | **BUILD SMALL** |
| Controls | Tool schemas and semantics | Canonical bounded schemas; context first; shared record only if needed | **BUILD IN SLICES** |
| Ignition and keys | Identity, authorization, provenance | Host-bound lane grants plus OS-local caller validation | **REQUIRED FIRST** |
| Steering | Turn, handoff, cancellation, pause/resume | Existing `RoomEngine` and `AliveRoomHost` | **KEEP** |
| Black box | Durable truth and replay | Selective lifecycle log plus normalized state and blobs | **BUILD SMALL** |
| Axles | Concurrent write isolation | Detached per-lane worktrees, durable leases, fenced integration | **DEFER UNTIL WRITES** |
| Brakes | Checks, process cancellation, receipts | Host allowlist, owned process tree, immutable receipts | **DEFER UNTIL WRITES** |
| Dashboard | Operator-visible activity | One chronological room feed with durable cursor and dedupe | **COMPLETE THE PATH** |
| Diagnostics | Traces, recovery, release proof | OTel-compatible correlation plus provider conformance matrix | **REQUIRED** |

## Recommended system shape

```text
Claude ACP session descriptors ─┐
Codex ACP session descriptors ──┼──> per-lane stdio MCP shim
Antigravity .agents config ─────┘              │
                                               v
                                  host-owned local IPC/broker
                                               │
                                      identity + policy gate
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         v                                           v
                 existing RoomEngine                    host tool registry
                         │                                           │
                         └─────────────────────┬─────────────────────┘
                                               v
                         normalized state + selective lifecycle events
                                               │
                                               v
                                  visible room feed + receipts

The legacy Temporal path is outside the target architecture and should be removed; no replacement workflow engine is required.
Future write tools branch through fenced worktrees, checks, and explicit integration.
```

## Part 1 — Chassis: product and teamwork contract

### Job

Define what teamwork means before selecting infrastructure.

### Observed fit

The authoritative North Star says teammate calls are one-hop, visible in the room, read-only unless explicitly granted, and taught as a skill with no new orchestration layer. The current implementation already has a bounded final-line handoff parser and a FIFO room scheduler.

Local evidence:

- `docs/decisions/2026-07-28-the-room-is-alive.md:39-45,70-77`
- `src/room/room-handoff.ts:10-73`
- `src/room/room-engine.ts:71-190,416-464`
- `src/room/room-host.ts:381-420,507-595`

### Recommended part

Keep the existing room semantics as the chassis:

- The operator remains the authority.
- A teammate call is at most one visible hop.
- `@all` and agent-originated hops remain read-only unless the host has issued a specific grant.
- Tool activity exposes intent, status, outcome, and receipt in the feed; hidden chain-of-thought is neither required nor persisted.
- No durable `agent_private` records in v1. Shared coordination state is visible; transient model reasoning stays transient.

### Reject

Reject autonomous agent-to-agent chains, private durable orchestration transcripts, and a second hidden scheduler behind the room engine. These would change the product contract rather than merely improve its implementation.

### Proof

The existing room suite currently passes 26 files and 124 tests. The missing product proof is a real three-provider room session in which every handoff and tool state transition appears once, in order, after live use and replay.

## Part 2 — Intake manifold: provider transport

### Job

Make the same Zer0 tool catalog discoverable from Claude, Codex, and Antigravity without giving each provider different semantics.

### Observed fit

Claude and Codex already use ACP, but Zer0 currently sends `mcpServers: []` from `src/adapters/acp/acp-lane-connection.ts:168`. The load/resume path must also receive the same descriptors.

Antigravity officially supports local `stdio` MCP servers from workspace-level `.agents/mcp_config.json`. Its changelog also states that headless/one-shot mode waits for MCP startup so the first turn receives the toolset. The existing Antigravity adapter already creates a separate scratch launch directory, which is the correct place for an ephemeral per-run workspace config.

Primary evidence:

- [ACP session setup and MCP descriptors](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
- [Antigravity CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)

### Recommended part

Use one semantic transport:

- Claude: inject the lane server descriptor on ACP new, load, and resume.
- Codex: inject the same descriptor on ACP new, load, and resume.
- Antigravity: create `<launchDir>/.agents/mcp_config.json` for that run, pointing to the identical local server command.
- Persist a server-catalog/configuration fingerprint with the lane binding so resume cannot silently attach a different catalog.
- Use stable, provider-safe canonical tool names and maintain a reversible name map where a client normalizes names.

The Antigravity JSON CLI bridge proposed in the source document should not be built first. Keep it only as a contingency if a real Zer0 MCP experiment exposes an irreducible provider defect.

### Compatibility profile

Build the shim as an isolated process using the stable MCP TypeScript v2 server packages, while keeping the initial tool surface compatible with the conservative object-schema subset accepted by the actual installed clients. Negotiate and fingerprint the provider profile; do not require 2026-era-only features until all three clients pass conformance.

This avoids freezing the new server on an old SDK without assuming that every installed client already implements every current protocol feature.

Primary evidence:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP `stdio` lifecycle](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

### Proof gate

Run one real read-only sentinel through each installed provider and prove:

1. discovery on a fresh session;
2. invocation with identical logical input and output;
3. availability on load and resume;
4. startup failure is explicit, never silent;
5. cancellation and process restart terminate cleanly;
6. two simultaneous lanes cannot cross-read identity or data;
7. Antigravity `--print` discovers and invokes the tool from its ephemeral workspace config.

Official Antigravity support is established. The Zer0-specific end-to-end run is still **UNVERIFIED**.

## Part 3 — Drivetrain: MCP shim and host broker

### Job

Translate provider MCP calls into authoritative host operations without duplicating policy, state, or business logic in the adapter.

### Recommended part

Use one small `stdio` MCP process per lane:

- It owns framing, schema validation, cancellation propagation, and response formatting.
- It connects only to its host-issued lane endpoint.
- The Zer0 host derives project, session, lane, agent, origin, and grants from the authenticated connection.
- The host owns authorization, idempotency, durable commit, feed publication, and receipts.
- The shim cannot open SQLite directly and cannot decide whether a write is allowed.

For local shim-to-host IPC, use an OS-native local endpoint rather than TCP: a Windows named pipe with a restrictive descriptor, and a Unix-domain socket where supported. Do not put a general network service between a local agent and the desktop host.

### Reject

- Direct tool-to-SQLite access.
- A provider-specific broker with different behavior.
- A giant tool that accepts arbitrary action names and untyped payloads.
- A second durable queue owned by the shim.
- Reusing an older permission MCP path whose credential is passed in command-line arguments.

### Failure contract

Every call ends in one of four truthful outcomes: committed, rejected, cancelled, or uncertain. A lost connection after dispatch must never be reported as success unless the host can recover the committed receipt by request ID.

## Part 4 — Controls: tool catalog and schemas

### Job

Expose the smallest useful semantic interface and make it behave identically across providers.

### Recommended rollout

| Tool | First release | Reason |
| --- | --- | --- |
| `zer0_context` | **YES** | Read-only compatibility sentinel and useful bounded room context |
| `zer0_record` | **LATER, if measured need exists** | Shared durable fact/decision only; may duplicate automatic host capture |
| `zer0_handoff` | **NO initially** | Preserve the visible final-line handoff; avoid two competing protocols |
| `zer0_work` | **DEFER** | Requires worktree isolation, durable leases, and fenced integration |
| `zer0_check` | **DEFER** | Requires an allowlisted runner, process-tree ownership, and receipts |
| `zer0_receipts` | **DEFER** | A read projection is useful only after durable work/check records exist |

`zer0_context` should return bounded, explicitly classified state such as room summary, visible shared decisions, current grant, and cursor. It must not expose hidden prompts, credentials, private reasoning, or another project's state.

If dogfooding proves `zer0_record` is necessary, it should store only shared operator-visible facts, decisions, or evidence references. The host supplies all identity fields. The model supplies content and an allowed truth class, not authority.

### Schema rules

- One canonical schema source, generated into each provider-facing descriptor.
- Strict root object; bounded strings and arrays; enums instead of free-form control values; unknown properties rejected.
- Stable structured result plus a short text fallback for clients that render only text.
- Stable error codes separate user rejection, policy rejection, conflict, cancellation, timeout, and uncertainty.
- Tool annotations are presentation hints, never authorization.
- Catalog and schema hashes are recorded with the lane/session binding.

For every side-effecting tool, the adapter or host assigns an idempotency request ID. Reusing the same scoped key with the same input hash returns the original receipt; reusing it with different input is a conflict.

## Part 5 — Ignition and keys: identity, authorization, and provenance

### Job

Ensure a model cannot claim a stronger identity, lane, project, origin, or permission than the host actually granted.

### Recommended part

Create an immutable host grant bound to:

- project and canonical workspace root;
- room session and lane;
- agent/provider and origin (`operator` or `agent`);
- immutable base commit for write work;
- allowed capabilities;
- generation, expiry, and random nonce.

The model never supplies these fields. Every broker operation looks them up from the authenticated lane connection and revalidates scope at the owning host layer.

On Windows, a named-pipe endpoint must use an explicit owner/logon-SID DACL, reject remote access, and validate the connecting process ID and creation identity against the expected provider/shim process tree. A single-use handshake capability should travel through an inherited handle when proven possible; otherwise use an owner-only, exclusively created temporary file outside the model-readable workspace and delete it immediately after connection. Never place a bearer credential in argv or the Antigravity workspace configuration.

Primary evidence:

- [Windows named-pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid)
- [Named-pipe client impersonation](https://learn.microsoft.com/en-us/windows/win32/ipc/impersonating-a-named-pipe-client)
- [MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

### Explicit threat boundary

This design can defend against another OS user/session and accidental cross-lane attachment. It is not a complete hostile same-user-process sandbox. If Zer0 later claims protection against arbitrary malicious code running as the same desktop user, the architecture needs a stronger OS isolation boundary, not a longer token.

### Provenance rule

All text coming from an agent, tool output, retrieved page, or resumed memory remains untrusted content. It can be evidence, but never authorization. Zer0's existing untrusted-framing and truth-class mechanisms should be preserved, and secrets must be redacted before durable prompt/output/error blobs are written.

### Existing adjacent release blocker

`src/tower/adapter-claude-protocol.ts:74-127` currently constructs a token-bearing MCP config and passes the JSON through `--mcp-config` argv. The new synergy path must not copy this pattern. Repairing that separate existing path is outside this document-only task, but a security review should block reuse.

The exact credential carrier that works across all three real provider launches without entering argv or a readable workspace config remains **UNVERIFIED** and belongs in the transport spike.

## Part 6 — Steering: room coordination and lifecycle

### Job

Own queue order, turn state, handoff, pause, cancellation, shutdown, and restart truth.

### Recommended part

Keep `RoomEngine` and `AliveRoomHost` as the single live-room coordinator. They already own FIFO lanes, visible events, hop limits, cancellation, host recovery, and publication.

Add MCP calls as inputs to that owner; do not place another state machine beside it. The broker may validate and enqueue, but the room engine decides the authoritative transition.

Use an explicit lifecycle vocabulary shared by persistence and UI, for example:

```text
accepted -> queued -> running -> succeeded
                            ├-> failed
                            ├-> cancelled
                            └-> uncertain
```

Pause and cancel are requests until the owning process confirms the resulting state. On restart, an in-flight operation with no durable terminal receipt becomes `uncertain` or `failed_interrupted`; it must not be silently retried unless that operation's contract explicitly makes replay safe.

### Reject

Do not add distributed consensus, an autonomous planning graph, or multi-hop delegation to solve a local three-agent room. Those are different products.

## Part 7 — Black box: persistence, delivery, and replay

### Job

Preserve acknowledged coordination truth through crash/restart, rebuild read models, and prevent duplicate logical effects.

### Recommended part

Use a selective lifecycle event log in the existing project SQLite database, alongside normalized current-state tables and content-addressed blobs:

- Append lifecycle facts only for operations that require recovery, audit, or feed replay.
- Keep normalized tables as the efficient current-state source for sessions, lanes, grants, work, and checks.
- Store large output once in content-addressed blobs; events reference it.
- Give each feed/read projection a durable cursor and deterministic rebuild contract.
- Persist the idempotency tuple `(scope, command_type, caller_id, request_id, input_hash)` with the committed receipt.

This is selective event recording, not whole-product event sourcing. Microsoft explicitly describes event sourcing as a pattern with meaningful ordering, consistency, versioning, and operational complexity; it should be applied where its benefits justify those costs.

Primary evidence:

- [Microsoft Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [SQLite transaction behavior](https://www.sqlite.org/lang_transaction.html)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite synchronous modes](https://www.sqlite.org/pragma.html#pragma_synchronous)
- [SQLite online backup API](https://www.sqlite.org/backup.html)

### Writer and durability policy

- One host-owned durable writer queue per project.
- Use `BEGIN IMMEDIATE` for short coordination transactions.
- Use `synchronous=FULL` for acknowledged lifecycle/receipt writes; derived caches may use a weaker policy only because they are rebuildable.
- Make blob durability precede the database reference, and clean orphaned blobs after recovery.
- Monitor database-busy time, WAL size/checkpoints, cursor lag, and backup integrity.

The installed SQLite runtime is 3.49.2. SQLite 3.51.3 fixed a WAL-reset corruption race, so the writer feature must not ship on the current runtime. Upgrade the pinned driver, assert the runtime version at startup, and run migration/backup/recovery tests before enabling durable synergy writes.

Primary evidence:

- [SQLite 3.51.3 release notes](https://www.sqlite.org/releaselog/3_51_3.html)

### Outbox decision

Do not add a generic outbox merely to update an idempotent room projection in the same host. The lifecycle log and durable consumer cursor are sufficient there.

Use a transactional outbox when a committed record must trigger a non-transactional or non-idempotent boundary such as an external service call, telemetry upload, paid API, git push, or a temporary migration relay between different stores. Delivery remains at-least-once, so the consumer still needs idempotency.

Primary evidence:

- [AWS Transactional Outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

### Reject

Reject initial backfill of every legacy store into one canonical global ledger. That migration has no measured requirement yet and would put the riskiest part before the compatibility proof.

## Part 8 — Discarded transmission: remove Temporal

### Job

Remove the abandoned workflow-engine experiment without losing any still-useful domain logic that was filed underneath it.

### Recommended part

Temporal is a rejected legacy dependency, not a retained subsystem and not a future option in this plan. The V2 room already owns queueing, cancellation, recovery, and visible lifecycle state. Keeping a second workflow runtime would preserve duplicate ownership and operational residue from an abandoned direction.

Remove it through a dependency-guided cleanup rather than deleting the directory blindly:

- Inventory every live import, CLI entry point, startup hook, test, script, and package dependency connected to `src/temporal`.
- Move genuinely reusable domain code—such as memory compilation or gate definitions—to the module that owns that behavior.
- Delete Temporal workflows, activities, worker/server startup, test-only runtime setup, configuration, and documentation after their consumers are removed.
- Remove `@temporalio/*` packages and lockfile entries.
- Prove V2 room launch, recovery, agent turns, memory compilation, checks, build, tests, and packaging without Temporal installed.

Do not replace Temporal with another general workflow engine. The existing room engine plus the selective SQLite lifecycle records described in this document are the target V2 coordination architecture.

This is now a product constraint, not an open falsifier. If Zer0 someday develops a genuinely different multi-host workflow product, evaluate that requirement from zero rather than reviving this legacy path by default.

## Part 9 — Axles: worktrees, leases, and integration

### Job

Allow a granted agent to modify code without colliding with another lane or silently integrating stale work.

### Recommended part

Before enabling `zer0_work`:

- Allocate one detached worktree and branch per write lane from an immutable base SHA.
- Issue a durable lease with a random fencing token, project/session/lane binding, canonical root, process identity, generation, and expiry.
- Revalidate the fence on every mutating operation; never fail open because a lock file is old.
- Use TTL only to trigger recovery inspection, not to prove ownership is gone.
- Keep a single host-owned integration writer.
- Require explicit operator acceptance before integration; stale lanes re-present their diff against the new base.
- Never auto-merge because checks passed.

Git worktrees are excellent collision isolation for cooperative agents, but they share repository objects, refs, and some configuration. They are not a hostile-process security sandbox.

Primary evidence:

- [Git worktree documentation](https://git-scm.com/docs/git-worktree)

### Current gap

The current multi-agent turn path shares one checkout, so write-capable `@all` must remain disabled. Mutable dependency directories must not be shared by junction/symlink as if that were isolation.

## Part 10 — Brakes: checks, process ownership, and receipts

### Job

Run only approved verification, stop the complete process tree, bound output, and report an immutable outcome.

### Recommended part

`zer0_check` should accept a host-defined check ID and bounded parameters, never an arbitrary command line. A versioned registry maps IDs to executable, arguments, working-directory policy, timeout, environment allowlist, and output limit.

Persist state before spawning:

```text
accepted -> claimed -> running -> cancel_requested -> cancelled
                                 ├-> timed_out
                                 ├-> succeeded
                                 ├-> failed
                                 └-> uncertain
```

Use one process-ownership abstraction:

- POSIX: new process group/session, then TERM and bounded KILL escalation.
- Windows: Job Object with `KILL_ON_JOB_CLOSE`, with a tested fallback only where job assignment is impossible.

Bound output at the stream edge. Keep a head/tail preview, byte count, SHA-256, and `truncated` flag; persist the full blob only within policy. Never let an unread pipe block termination.

Primary evidence:

- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

Receipts are host-generated read projections over durable work/check state. Agent-authored text cannot claim that a command ran or a check passed.

### Current gaps

The existing verify runner accepts arbitrary executable/arguments, and the legacy Temporal gate activity falls back from an unknown gate name to `npm <gate>`. The latter belongs in the Temporal removal scope, not in the new tool design. Existing parent-only kill paths also do not prove that descendants terminate.

## Part 11 — Dashboard: visible room feed

### Job

Let the operator see what the team is doing, what changed, and what remains uncertain.

### Recommended part

Use one chronological room feed. Every coordination state change is durable and replayable once:

- tool intent and authorization result;
- queued/running/cancel state;
- bounded outcome and receipt link;
- handoff attribution;
- restart/recovery uncertainty;
- integration decision.

Read-only context calls may collapse into a compact activity entry; mutations and failures may not disappear into debug logs. The feed should resume from a durable cursor and deduplicate by event ID.

Do not display or persist hidden chain-of-thought. Visibility means observable action and outcome, not private model reasoning.

### Current gap

The room host publishes `zer0/room/event`, but the current V2 TUI has no verified consumer for the complete event path. Backend tests alone therefore do not prove the operator experience. A release gate must exercise launch, live events, reconnect, replay, and duplicate suppression in the actual room UI.

## Part 12 — Diagnostics: observability, recovery, and proof

### Job

Make failures attributable and enforce the architecture's invariants under real provider and process behavior.

### Recommended part

Use one trace per operator command, with child spans for provider invocation, MCP call, broker authorization, database commit, projection, check process, and recovery. Store W3C/OTel-compatible trace and span IDs, but do not make a remote collector mandatory for the MVP.

Primary evidence:

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry specification](https://opentelemetry.io/docs/specs/otel/)
- [OpenTelemetry Logs](https://opentelemetry.io/docs/specs/otel/logs/)

Measure at least:

- command counts by terminal state, especially `uncertain`;
- queue wait and execution duration;
- database-busy time, WAL size, and checkpoint health;
- projection cursor lag;
- external-outbox age where an outbox exists;
- output truncation and orphan-process count;
- backup, replay, and recovery-integrity failures;
- cross-provider catalog/schema fingerprint mismatches.

The release invariants are stronger than invented latency targets:

1. zero acknowledged lifecycle-event loss after crash/restart;
2. zero duplicate logical side effects for one idempotency key;
3. zero cross-project or cross-lane disclosure;
4. every uncertain outcome is visible and recoverable;
5. no descendant check process survives terminal cancellation;
6. projections rebuild deterministically from committed facts.

Set latency and throughput SLOs only after load tests on representative repositories and provider concurrency. Exact numbers are currently **UNVERIFIED**.

## Assembly order

Each slice has a falsifier and may stop the program before the next investment.

### Slice 0 — Contract and runtime prerequisites

- Freeze the one-hop/visible/host-authoritative invariants in a decision record and tests.
- Define canonical tool schema, error envelope, identity binding, and provider conformance fixture.
- Decouple reusable domain logic from `src/temporal`, then remove the legacy Temporal runtime, entry points, dependencies, and documentation.
- Upgrade and runtime-gate SQLite before any new acknowledged durable writer ships.
- Define the explicit same-user-process threat boundary.

**Exit:** schemas validate; host rejects model-supplied identity; V2 builds and runs with no Temporal dependency or runtime path; database crash/recovery and backup tests pass on the pinned runtime.

### Slice 1 — Read-only transport sentinel

- Launch one lane-scoped `stdio` MCP shim exposing only `zer0_context` with a static sentinel response.
- Inject it into fresh/load/resume Claude and Codex ACP sessions.
- Generate the ephemeral Antigravity workspace config in its existing scratch launch directory.
- Prove discovery, call, cancellation, restart, concurrent isolation, and catalog fingerprinting.

**Stop if:** one provider cannot reliably discover the same semantic server. Diagnose that provider before adding broker or persistence complexity.

### Slice 2 — Real bounded context and visible feed

- Connect the shim to a read-only host broker operation.
- Derive lane identity at the host.
- Return bounded room/project context with truth and freshness metadata.
- Publish activity through the actual room UI and prove replay/dedupe.

**Exit:** a real three-provider room demonstrates identical semantics and no cross-lane leakage.

### Slice 3 — Optional shared record and coordination log

- Dogfood context/handoff first and measure whether agents need explicit shared recording beyond automatic host capture.
- If needed, add shared-only `zer0_record`, selective lifecycle events, durable idempotency, cursor replay, and recovery receipts.
- Do not add agent-private persistence or global backfill.

**Exit:** crash-after-commit, crash-before-commit, duplicate request, and conflicting replay tests all produce truthful outcomes.

### Slice 4 — Write isolation

- Add durable grants, detached per-lane worktrees, fenced leases, and the single integration owner.
- Keep integration operator-approved and stale-work aware.

**Exit:** concurrent lanes cannot touch another lane's workspace or integrate with an expired/stale fence.

### Slice 5 — Checks and receipts

- Add the versioned check registry, owned process trees, timeout/cancellation escalation, bounded output, and immutable receipts.
- Then expose `zer0_check` and receipt reads.

**Exit:** adversarial process-tree, output-flood, timeout, restart, and unknown-check tests pass on Windows and every supported OS.

### Slice 6 — Decide whether more platform is earned

Only after dogfooding should Zer0 consider `zer0_work`, a handoff tool adapter, external outboxes, multi-host execution, or broader event sourcing. Each needs a measured requirement and its own decision record.

## Provider conformance matrix

No provider is “supported” until every required cell is proven against the real installed binary.

| Behavior | Claude ACP | Codex ACP | Antigravity headless |
| --- | --- | --- | --- |
| Fresh-session discovery | Required | Required | Required |
| Load/resume catalog parity | Required | Required | Required where supported |
| Strict input rejection | Required | Required | Required |
| Structured result + text fallback | Required | Required | Required |
| Cancellation propagation | Required | Required | Required |
| Shim crash/restart visibility | Required | Required | Required |
| Concurrent lane isolation | Required | Required | Required |
| Host-derived identity | Required | Required | Required |
| No credential in argv/workspace config | Required | Required | Required |
| Feed event and receipt parity | Required | Required | Required |

## Decision register

### Accept now

- One common lane-scoped `stdio` MCP adapter for all three providers.
- Existing room engine as the live scheduler.
- Host-derived identity and host-owned policy/persistence.
- Read-only context sentinel as the first compatibility proof.
- Selective coordination lifecycle events plus normalized state.
- One chronological visible feed.

### Defer until dependencies exist

- Shared `zer0_record` until dogfooding proves automatic capture is insufficient.
- Write and check tools until isolation, fencing, process ownership, and receipts pass.
- Transactional outbox until an actual non-transactional boundary needs delivery.
- Modern-only MCP features until the installed provider matrix passes them.

### Reject for this architecture

- Custom Antigravity JSON CLI as the primary transport.
- Whole-project event sourcing and legacy backfill in the first release.
- Temporal runtime, workflows, worker/server paths, and package dependencies in V2.
- Direct tool-to-database writes.
- Agent-supplied identity or permission fields.
- Durable `agent_private` coordination records.
- Arbitrary check commands.
- Git worktrees described as a security sandbox.
- Automatic merge/integration after checks.
- Hidden autonomous multi-hop orchestration.

### Still unverified

- Real Antigravity 1.1.13 discovery and invocation from Zer0's ephemeral launch directory.
- A credential carrier that works across all three provider launch paths without entering argv or a model-readable config.
- End-to-end V2 room-feed rendering, reconnect, replay, and duplicate suppression.
- Cross-platform descendant-process termination for every check/provider path.
- Representative latency, throughput, and WAL-growth SLOs.

## Final opinion

The strongest “car” is not the one with the most parts. For Zer0's current job, the right chassis already exists. The valuable new part is a uniform, lane-scoped MCP control surface that lets each provider reach the same host authority. Everything else should be added only when its prerequisite and failure proof exist.

The source proposal has strong invariants—host-derived identity, no direct SQLite access, bounded schemas, idempotency, worktree isolation, visible receipts, and no automatic merge. Keep those. Change its order and scope: prove the common transport first, keep room coordination local, record only necessary lifecycle facts, and defer the platform-sized pieces.

**Confidence: YELLOW (92%).** The architecture choice is supported by current source, installed-package inspection, passing room-focused tests, and current primary documentation. It is below green because the real three-provider MCP run, secure launch credential carrier, complete Temporal-removal dependency inventory, and complete V2 room UI path have not yet been demonstrated.
