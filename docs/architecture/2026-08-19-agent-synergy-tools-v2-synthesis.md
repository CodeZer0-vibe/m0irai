# Zer0 Agent Synergy Tools — v2, synthesized

- **Date:** 2026-08-19 · **Author:** claude, synthesizing four inputs · **Status:** decision-complete build contract, awaiting operator go
- **Supersedes:** `2026-08-13-agent-synergy-tool-architecture.md` (base). That document stays readable as the origin of the invariants;
  every place this one contradicts it, this one wins and says why.
- **Synthesizes:** the base doc + three independent reviews written 2026-08-14 —
  `2026-08-14-parts-review-claude.md` (12 parts, evidence-graded),
  `2026-08-14-synergy-subsystems-codex.md` (12 parts, slice rollout),
  `2026-08-14-synergy-subsystems-gemini.md` (6 subsystems, Windows specifics).
- **Baseline:** the post-extraction tree at `D:\m0irai-work` (`src/` = adapters, chat, evidence, memory, room, shared),
  **not** the 08-13 tree the base doc describes. §4 restates what actually exists.
- **Decision owner:** Operator.

## 0. How to read this

Each substantive statement carries a provenance mark:

| Mark | Meaning |
| --- | --- |
| **VERIFIED** | Someone ran it on this machine and quoted the output. |
| **SOURCED** | Primary spec, vendor doc, or paper. |
| **JUDGMENT** | Argued engineering opinion. Disagree freely. |
| **3/3, 2/3, 1/3** | How many of the three reviews reached this independently. |

Where the reviews disagreed I rule explicitly in §3 rather than silently picking one. A 1/3 finding is not weaker for being
single-source — most of the verified findings are 1/3, because only one reviewer ran that particular experiment.

## 1. Executive decision (rewritten)

Build a small, provider-neutral `zer0` tool service that Claude, Codex, and Gemini reach through **one transport**: a lane-scoped
stdio MCP server. The base doc's second transport — a generated `zer0-tool` JSON CLI for the Antigravity lane — **is deleted**; it
was written on the belief that Gemini had no MCP injection seam, and that belief was disproved by live experiment on 2026-08-14.

Keep authority in the host: the shim owns framing and validation, never policy or persistence. Never give an agent raw SQLite
access, never let an agent mark its own work verified, never let the tool service become a hidden orchestrator.

**Order changed.** The base doc built the canonical ledger first and the transport second. Both claude (part 12) and codex
(slice 1) independently inverted that, for the same reason: the ledger is well-understood engineering, the three-provider
transport is the actual unknown, and building a ledger for a catalog shape you then redo is the expensive mistake.
The first release is therefore a read-only walking skeleton, and no durable synergy write ships until it passes.

**Scope cut.** The base doc's Phase 1 backfilled every legacy store into one canonical ledger. Codex rejected that as
"the riskiest part before the compatibility proof," and it is cut from the first release: the first durable writes are a
*selective* coordination lifecycle log alongside normalized state, not whole-product event sourcing and not a migration of
`work_journal` / transcripts / room JSONL. Those remain a later, separately-justified decision.

## 2. Disposition against the 08-13 base

| Base doc | Disposition | Driver |
| --- | --- | --- |
| §1, §5, §14 dual transport (MCP + generated CLI) | **DELETED**, one stdio MCP for all three | 3/3, VERIFIED probe |
| §5 "Gemini support remains UNVERIFIED" | **CLOSED** — discovery and invocation proven | VERIFIED (claude, agy probe) |
| §5 "retain legacy initialization compatibility" | **NAMED** — the mechanism is `server/discover` | 1/3, SOURCED + VERIFIED |
| §8.1 "named pipe protected by the current-user ACL" | **FALSE AS WRITTEN** — must be built, see §7 | 1/3 VERIFIED, 1/3 SOURCED agreement |
| §8.1 token via process environment | **CHANGED** to stdin, fallback ACL'd file, never argv | 2/3 |
| §9.4 transactional outbox for the room feed | **REPLACED** by a consumer cursor; outbox kept for external effects | 2/3 |
| §9.1 `UNIQUE (project_id, source_kind, source_id)` | **FIXED** — partial index; and `trace_id` column misaligned | 1/3 |
| §9.5 terminal states | **EXTENDED** — `uncertain` is a first-class outcome | 1/3 |
| §10 SQLite 3.51.3+ | **TIGHTENED** to pin 3.53.4; assert at startup | 2/3, VERIFIED |
| §10 `synchronous=FULL` | **KEPT** for the ledger, with codex's split for rebuildable caches | ruling, see §3.1 |
| §11 worktree isolation | **KEPT UNCHANGED** — the strongest part of the base doc | 3/3 |
| §13 JSON-Schema bundle as contract owner | **FLIPPED** to Rust-first | 1/3, SOURCED |
| §14 "process-tree termination is required" | **MECHANISM SPECIFIED** — Win32 Job Object | 3/3 |
| §15 hand-written metric names | **MAPPED** to OTel GenAI semconv at export only | 2/3 |
| §3.1 "the operator is the only synthesizer" | **AMENDED** — rotating mechanical arbiter | 1/3, SOURCED |
| §6 all six tools in the first release | **STAGED** — `zer0_context` alone first | 2/3 |
| §6.2 `visibility: agent_private` durable records | **DROPPED** for v1 | 1/3 |
| §17 Phase 1 ledger before Phase 2 transport | **INVERTED** | 2/3 |
| §17 Phase 1 full legacy backfill | **CUT** from the first release | 1/3 |
| §3.2 four truth classes, §14 injection containment, §16 pre-mortem | **KEPT VERBATIM** | 3/3 |

## 3. Where the reviews disagreed — rulings

These are the only places the three inputs actually conflict. Everything else was additive.

### 3.1 `synchronous` — FULL or NORMAL

Gemini specified `PRAGMA synchronous = NORMAL`, arguing it "guarantees 100% ACID durability across application crashes **and power
loss**" while avoiding 15–30 ms per commit. The base doc, claude, and codex all specified FULL.

**Ruling: FULL for the ledger.** Gemini's premise is half right and the half that is wrong is the half that matters. SQLite's own
documentation is explicit: in WAL mode, `synchronous=NORMAL` is safe from *corruption*, and safe across an *application* crash —
but "transactions committed in WAL mode with `synchronous=NORMAL` might roll back following a power loss or system crash."
For a system of record whose entire claim is "an acknowledged event is never lost," a silently rolled-back commit is the failure
mode we are building against. Gemini's latency concern is real, and codex's formulation resolves it exactly:
**FULL for acknowledged lifecycle and receipt writes; a weaker policy is permitted only for derived caches, because they are
rebuildable.** That is the rule adopted.

Note the live gap (VERIFIED, claude): `.zer0/evidence.db` currently runs at `synchronous=1` (NORMAL). The base doc said FULL and
the code does not do it. Closing that is Phase 0 work, hours not days.

### 3.2 Outbox table or consumer cursor

Base doc and gemini: a `room_outbox` table committed in the same transaction. claude and codex, independently: don't.

**Ruling: consumer cursor for the room feed; a real outbox only at external boundaries.** An outbox buys atomicity, durable
delivery state, and ordering. Here the log already provides atomicity (the event *is* the message) and ordering (a single writer
means commit order equals `seq` order, with no gaps — genuinely easier than Postgres, where sequences are issued pre-commit and
consumers need a high-water-mark gap detector). That leaves delivery state, which `(consumer_id, last_seq)` encodes isomorphically
and *rebuildably* — reset the cursor and replay, versus a deleted outbox row that is gone forever.

Keep a true outbox for effects that leave the machine or are non-idempotent — telemetry upload, `git push`, paid agent spawns —
because a cursor cannot distinguish "not started" from "done but crashed before ack." That distinction is the outbox's actual job
and it does not apply to publishing into our own room feed. Both dissenting reviews reached this independently.

Two plumbing corrections that come with it (1/3, SOURCED): do not use SQLite commit/update hooks — they fire pre-commit, in
unspecified order, and no Node driver exposes them. `PRAGMA data_version` *does* work cross-process and is a valid cheap change
signal for the Rust UI, but it is documented as unchanged for same-connection commits, so it cannot notify the host of its own
writes.

### 3.3 Schema contract ownership

Gemini: MCP TS SDK v2 with Zod v4 Standard Schema. Base doc: a JSON Schema 2020-12 bundle owns everything, generate Node and Rust
from it. claude: flip to Rust-first — `rmcp` already derives schemas from `schemars`, and schemars 1.x emits 2020-12 natively,
whereas JSON-Schema-as-owner dies on the Rust generator (Typify's maintainer states it handles "basically Draft 7"; Typify 2 is an
unreleased multi-year WIP).

**Ruling: Rust-first, and decide it now, before any schema is hand-authored.** Gemini's Zod point is about *authoring the shim's
tool schemas in Node*, which is fine as far as it goes but does not address the binding constraint — the Rust reducer needs
generated event types, and that is where every schema-first and TS-first path bottlenecks. The pipeline is:

```
Rust types (serde + schemars) ──emit──> JSON Schema 2020-12 bundle ──gen──> TS types
        │                                          │
        └─ reducer event enum, hand-written        └─ MCP tool schemas, native
```

TS validation is **Ajv 8.20 (`ajv/dist/2020`) with standalone codegen** — full 2020-12 including `prefixItems`, compiled at build
time, no eval, CSP-safe. `json-schema-to-typescript` for ergonomic types only; it is stale (last publish 15.0.4, Jan 2025), so
treat its output as convenience and Ajv as truth. Rust-side CI parity via the `jsonschema` crate.

Catalog hash: JCS (RFC 8785), with two rules that matter more than the algorithm — **bundle and dereference first, then
canonicalize** (so `$ref` refactors don't churn the hash; MCP forbids auto-dereferencing external `$ref` anyway), and
`sha256(JCS({name → sha256(JCS(schema))}))` sorted by name.

Honest cost (JUDGMENT): TS becomes downstream and schema shape couples to Rust type shape. Mitigate with `#[schemars(...)]`
overrides and golden fixtures. This is the single decision that gets most expensive to reverse — it hardens the moment fixtures
exist.

### 3.4 Shared `node_modules` via NTFS junctions

Gemini proposed junctioning each worktree's `node_modules` to the root workspace copy — "instant sub-millisecond dependency
resolution with zero disk overhead." Codex explicitly wrote the opposite: "mutable dependency directories must not be shared by
junction/symlink as if that were isolation."

**Ruling: not in the first release; permitted later only under a stated invariant.** The performance problem gemini identifies is
real — `npm install` per worktree is a genuine bottleneck and worktrees deliberately don't copy `node_modules`. But a junction
makes every lane's dependency tree the *same mutable directory*: one lane running an install, a postinstall patch, or a native
rebuild corrupts its siblings mid-turn, and the failure is silent and cross-lane, which is the exact class this architecture
exists to prevent. If it is adopted later it needs an enforced invariant — **no lane may mutate `node_modules`** — plus a check
that fails the lane if the tree's hash changed during the turn. Until that check exists, per-worktree install or a copy-on-write
clone. Recorded as **OPEN-3** in §17.

Gemini's two adjacent Windows findings are adopted unchanged and are not affected by this ruling: `GIT_OPTIONAL_LOCKS=0` for
background status calls (prevents transient `index.lock` collisions), and `.git/info/exclude` rather than `.gitignore` for
per-lane config — which claude reached independently, 2/3.

### 3.5 How much of the catalog ships first

Gemini specified all six tools in Phase 2. Codex staged them hard: `zer0_context` yes, `zer0_record` later *if measured need*,
`zer0_handoff` **no** initially (keep the existing final-line parser rather than run two handoff protocols), work/check/receipts
deferred behind isolation and process ownership. Claude's walking skeleton is `zer0_context` alone.

**Ruling: codex's staging.** It is the same shape as claude's skeleton with a sharper argument for each deferral, and it matches
the base doc's own §6.6 note that the final-line `@agent:` syntax is a compatibility parser into one handler — so the handler is
what gets built, not a competing tool. See §9.

## 4. What actually exists today (restated for `D:\m0irai-work`)

The base doc's §4 inventory is stale: it describes a tree that has since been cut. Current state, verified 2026-08-19:

- `src/` is now **adapters, chat, evidence, memory, room, shared**. `tower`, `temporal`, `cli`, `tui`, `loop`, `observability`,
  `gates`, `security` are gone.
- **Consequences for the reviews:** codex's release blocker at `src/tower/adapter-claude-protocol.ts:74-127` (a token-bearing MCP
  config passed through `--mcp-config` argv) is **moot — the file no longer exists**. Its *lesson* is retained as a hard rule in
  §7. Claude's note about `src/temporal/` as a non-migration-source is likewise moot; Temporal is gone from the tree, not merely
  rejected on paper. Codex's Part 8 (Temporal removal) is **complete** and drops out of this plan.
- **Observability is now net-new.** `src/observability` was deleted in the extraction, so §14's tracing work has no existing
  scaffold to extend — budget it as new code, not as an upgrade.
- Still true from the base doc's inventory: the room engine owns FIFO lanes, visible one-hop handoff, cancellation and recovery;
  ACP sessions still pass `mcpServers: []`; Gemini still runs through the one-shot `agy` adapter (`src/adapters/agy.ts`); the V2
  JSON-RPC host still exposes room lifecycle methods only; multi-agent write attribution is still unsolved because lanes share a
  checkout.
- The evidence schema (`src/evidence/`) with its v13/v15/v16 migrations survived the cut and remains the storage foundation.

Anyone starting Phase 0 should re-verify this list against the tree rather than trusting it — it is nine days younger than the
base doc's and will age the same way.

## 5. Invariants (unchanged, and one amendment)

§3.1 equal-agent, §3.2 four truth classes, §3.3 visibility, §3.4 project isolation, §3.5 acknowledge-after-commit carry over
**verbatim**. All three reviews independently endorsed the truth classes; claude noted Claude Code's own agent teams arrived at
the same conclusions from a different direction (file-locking claims, peer messages treated as untrusted input that cannot grant
a permission, no nested teams) — convergent evolution on the hardest invariants is signal.

One amendment, to §3.1 clause 6. **"The operator is the only synthesizer" is dropped** (1/3, SOURCED). The peer topology itself is
sound at N=3 and stays. But removing a lead also removes the component that owns termination detection, stall→replan, and
cross-agent verification. MAST (NeurIPS 2025, 1,642 annotated traces, κ=0.88) puts *step repetition* at 15.7% and *unaware of
termination conditions* at 12.4% — roughly 36% of known failure mass lands on a human in real time. And "The Specification Gap"
(arXiv 2603.24284) measured two-agent integration accuracy falling 58% → 25% as specs degraded to bare signatures, with a
persistent 25–39pp coordination gap — while an AST conflict detector at 97% precision **did not improve outcomes when agents saw
the reports**.

Read against §6.3: CAS claims and file leases are correct-by-construction and are **not** the bottleneck. The leverage is in
work-item *specification richness* — `objective`, `acceptance[]`, interface contracts. The base doc caps `objective` at 4096 chars
and treats acceptance as a bounded list; that is the highest-leverage field in the schema and currently an afterthought.

Replacement: a **rotating mechanical arbiter**, a per-work-item role rather than a standing lead, owning exactly three things —
(1) a progress ledger with a stall counter, (2) explicit termination/done criteria per work item, (3) cross-lane verification
before the operator sees anything. All three are host-owned and mechanical; no agent judges another, so §3.2 is untouched and
§3.1's "no lead agent" survives intact. Add "operator decisions required per turn" to the metrics (§15) so the bottleneck is
visible before it arrives. Reconciliation is pairwise — N=3 is 3 pairs, N=4 is 6, N=5 is 10 — and this holds at 3, barely.

## 6. Transport — one stdio MCP (rewrite of base §5 and §14)

### 6.1 The seam, per lane

| Lane | Injection seam |
| --- | --- |
| Claude, Codex | ACP `session/new` → `mcpServers` stdio descriptor (also on `load` and `resume`) |
| Gemini | host-written `.agents/mcp_config.json` **inside the lane's worktree / launch dir** |

Antigravity supports stdio MCP at two documented scopes — global `~/.gemini/config/mcp_config.json` and workspace-local
`.agents/mcp_config.json` — with `command`/`args`/`env` and an `mcp(server/tool)` permission system defaulting unconfigured tools
to **Ask**. Because §11 already gives every write-capable lane a unique worktree, the workspace-local scope *is* per-lane
injection, semantically equivalent to an ACP `session/new` descriptor. The isolation subsystem pays for itself twice.

Codex's independent addition: the existing `agy` adapter already creates a separate scratch launch directory, which is the correct
home for an ephemeral per-run config. And Antigravity's changelog states headless/one-shot mode waits for MCP startup, so the
first turn receives the toolset.

**Deleted from the base doc:** the generated `zer0-tool` CLI, the "net-new Antigravity command/tool-calling seam," the dual-shim
rules in §14, the separate Gemini row in §18, and the `UNVERIFIED` status. Codex's caveat is kept: retain the CLI bridge as a
*contingency* only if a real experiment later exposes an irreducible provider defect.

### 6.2 What the probe proved, and what it changes

**VERIFIED 2026-08-14T06:17, live `agy.exe`, log at `.zer0/mcp-probe-test/probe-server.log`.** Workspace-local
`.agents/mcp_config.json` loads; a probe stdio server was discovered, `tools/list` returned, and `zer0_probe_ping` was called
mid-turn with the structured result consumed. **agy issue #60 does not apply to the `.agents/` path** — it names the legacy
`.antigravitycli/` location.

The captured handshake changes the shim spec in two ways:

```jsonc
RECV {"id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}
RECV {"id":2,"method":"initialize","params":{"clientInfo":{"name":"antigravity-client"},"protocolVersion":"2025-11-25"}}
SEND {"id":2,"result":{"protocolVersion":"2024-11-05",...}}
```

1. **agy probes `server/discover` first**, then falls back to legacy `initialize` when the server doesn't answer it — the
   backward-compat path the MCP changelog describes for stdio, now confirmed against a real provider. **The shim MUST implement
   `server/discover`** so agy takes the modern stateless path. The probe server didn't, negotiated all the way down to 2024-11-05,
   and still worked — reassuring for compatibility, but not the production path.
2. **Version negotiation spanned three revisions in one handshake.** The compatibility test must assert the *negotiated version
   per lane*, not merely that a call succeeded. A silent downgrade to 2024-11-05 loses `resultType`, `outputSchema` guarantees,
   and the tasks extension — several things this design depends on.

**Headless permission gate (VERIFIED):** in `--print` mode agy auto-denies any tool needing an unprompted permission. Lane launch
must pre-authorize the Zer0 catalog scoped per the §8.2 policy table — pre-authorize `mcp(zer0/zer0_context)` and
`mcp(zer0/zer0_receipts)`, leave writes in Ask. **Not** `--dangerously-skip-permissions`, which would also disable the read/write
split. Free win: provider-layer enforcement *in addition to* the host registry, defense in depth at no cost.

### 6.3 MCP 2026-07-28 moved the ground under base §5 (SOURCED)

- `initialize` / `notifications/initialized` **removed**; MCP is stateless, protocol version and client capabilities ride in
  `_meta` per request. The base doc's instinct to "retain legacy initialization compatibility" was right; the mechanism has a
  name — `server/discover`.
- Protocol sessions and `Mcp-Session-Id` **gone**. The spec now says cross-call state uses "server-minted handles passed as
  ordinary tool arguments" — which is exactly `invocationId` and receipt IDs. Base §8.1 goes from local policy to spec-aligned.
- **Base §6.4 reinvents a standard.** Long checks returning a pending receipt polled via `zer0_receipts` is now the official
  `io.modelcontextprotocol/tasks` extension with `tasks/get` and `tasks/update`. Build on it; keep receipts as fallback.
- **Absent from the base doc entirely:** `resultType` is now required on every result; `ttlMs`/`cacheScope` required on
  `tools/list`. Both are shim output-contract changes.
- Roots/Sampling/Logging deprecated; the spec's own logging migration is "log to stderr (stdio)" — already base §14's rule.

### 6.4 SDK policy (simplified)

v2 is the stable line and **retires the monolithic `@modelcontextprotocol/sdk`** in favour of `@modelcontextprotocol/server` and
`/client`. Our shim is a *server*; the Claude ACP bridge's v1 pin is client-side and already a separate process. The isolation the
base doc wanted to engineer is a consequence of the package split. So: pinned `@modelcontextprotocol/server` v2, and **no SDK
objects cross the process boundary** — only validated wire data. Codex's tempering is adopted: keep the initial tool surface
inside the conservative object-schema subset the installed clients actually accept, and do not *require* 2026-era-only features
until all three pass conformance.

## 7. Identity and local IPC — the security rewrite (base §8.1) 🔴

**This is the finding to act on first.**

Base §8.1 states the shim "connects to a random named pipe protected by the current-user ACL." **VERIFIED: that ACL does not
exist.** libuv calls `CreateNamedPipeW(..., lpSecurityAttributes = NULL)`, so Node pipes get Windows' default security descriptor.
A `net.createServer()` pipe on this machine, read via `CreateFileW(READ_CONTROL)` + `GetSecurityInfo(SE_KERNEL_OBJECT)`:

```
D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-3668660514-27240486-2574848101-1001)(A;;FR;;;WD)(A;;FR;;;AN)
```

`WD` = **Everyone** and `AN` = **ANONYMOUS LOGON**, both holding `FILE_GENERIC_READ`. libuv also omits
`PIPE_REJECT_REMOTE_CLIENTS`, so the pipe is reachable over SMB as `\\host\pipe\name`. And pipe names are enumerable by anyone —
`[System.IO.Directory]::GetFiles("\\.\pipe\")` lists live pipes in one call — so "random name" is not a control either. Node's
only public knob (`readableAll`/`writableAll`) can *only widen* access; there is no narrowing API, and `fd()` returns `-1` on
Windows so the handle is unreachable from JS.

Codex reached the same requirement from the spec side without running the experiment (2/3 agreement on the fix, 1/3 on the proof):
an explicit owner/logon-SID DACL, remote access rejected, connecting process identity validated.

**Fix:** after `listen()`, one FFI call via **koffi** — `CreateFileW(name, WRITE_DAC|READ_CONTROL)` then
`SetSecurityInfo(SE_KERNEL_OBJECT, DACL)` — applying `D:P(A;;FA;;;SY)(A;;FA;;;<logonSID>)`. Use the **logon SID**, not merely the
user SID; Microsoft documents this as the way to exclude other terminal-services sessions and remote users. There is a small race
between `listen` and tighten: treat it as a known window and rotate tokens. ~80 lines; koffi is prebuilt, no node-gyp.

**Token channel — the base doc's choice is the worst of three.** Ranked worst to best:

1. **argv** — readable by same-user code via `Win32_Process.CommandLine`, *and* mirrored into Sysmon/ETW/EDR logs and crash dumps.
   The secret leaves the machine. This is also the pattern codex flagged in the now-deleted tower adapter; the rule outlives the file.
2. **env** — needs `PROCESS_VM_READ` (same-user only), but silently inherited by every descendant. This was gemini's choice and
   the base doc's; it is second-best, not adequate.
3. **stdin** — the parent spawns the shim, so write the token to the shim's stdin. Not enumerable, not logged, not inherited.
   **Preferred.** Fallback where a seam can't do stdin: a per-lane token *file* with an explicit SID ACL inside the worktree,
   excluded via `.git/info/exclude`, deleted immediately after connection. **Never argv, never the Antigravity workspace config.**

⚠️ This reverses claude's own earlier advice in the room, which proposed the token in `args` because agy's `env` handling is
reportedly flaky. That was wrong on security grounds.

**Honest assessment of the token (JUDGMENT):** against the *Node default* ACL it is genuinely load-bearing — it blocks other users
and remote SMB. Once the DACL is tightened to the logon SID on a single-user box it buys little: same-user code can already open
the pipe, read argv, `ReadProcessMemory` the env, and inject into the host. Keep it (near-free; gives rotation hygiene and
misrouting protection), but **the ACL is the control, and the base doc currently has neither.**

**Explicit threat boundary** (codex, adopted verbatim as doc text): this design defends against another OS user or session, and
against accidental cross-lane attachment. It is **not** a complete hostile same-user-process sandbox. If Zer0 ever claims
protection against arbitrary malicious code running as the same desktop user, that needs a stronger OS isolation boundary, not a
longer token.

**Two things that are not available:** peer credential checks (`GetNamedPipeClientProcessId`) need the accepted pipe *handle*,
which Node never exposes — unreachable from JS even with FFI, so without a native addon the ACL *is* the peer check. And the MCP
spec is **silent** on authenticating a local socket peer (it assumes stdio, where the client spawns the server and the OS user
account is the trust boundary). This design is outside the spec; Zer0 owns it.

**Reject loopback TCP outright** — no peer identity, any local process at any integrity level can connect, port discoverable; the
"loopback == trusted" pattern behind CVE-2026-25253. AF_UNIX is also out: Node maps all `net` paths to named pipes on Windows
(nodejs/node#55979 still open).

## 8. Storage (base §9, §10)

Keep the hand-rolled append-only log. The survey confirms rather than undermines it (1/3, SOURCED): **Emmett** is the only
credible contender but has **no LICENSE file at all** and an open RFC proposing AGPLv3/SSPL — disqualifying twice for a shipped
desktop app. **LiveStore** is Apache-2.0 and well-designed but beta, requires a sync backend for ordering we get free, and rebasing
rewrites the log, invalidating a hash chain. **XTDB v2** means a JVM sidecar over Postgres wire to get what a `truth_class` column
gives. **Rejected outright:** CRDTs (Automerge/Yjs/Jazz) — they *merge*, destroying disputed-claim semantics, which is the entire
point of §3.2; Electric/PowerSync/Zero need Postgres and a server; **cr-sqlite is abandoned** (last release 2024-01); LiteFS dead;
Replicache archived; SQLite's session extension is physical row diffs, not semantic events, and isn't compiled into
better-sqlite3 anyway.

Performance is a non-issue at this scale (SOURCED): 200k events appended in 962 ms, full hash-chain verification in 968 ms. Skip
Merkle trees.

**Scope, per §1:** first durable release is a *selective* coordination lifecycle log plus normalized current-state tables and
content-addressed blobs — not whole-product event sourcing, and not the base doc's §9.3 legacy backfill. Append lifecycle facts
only for operations that need recovery, audit, or feed replay. When and if full event sourcing is earned, base §9.3's cutover
gates (source cursors, dual-read parity, deterministic tie-breaks, rollback) are already written and stand as-is.

**Schema corrections to base §9.1** (1/3): the `trace_id` column has a stray space breaking alignment — this is a build contract
and people will paste it. And `UNIQUE (project_id, source_kind, source_id)` contradicts the adjacent sentence "IDs are `NOT NULL`;
ordinary SQLite primary-key null behavior is not relied on" — natively-generated events have no source, so it works only because
SQLite treats NULLs as distinct in UNIQUE, i.e. it relies on exactly the behaviour the sentence disclaims. Make it a partial
index: `... WHERE source_kind IS NOT NULL`.

**Enforce append-only** with `BEFORE UPDATE` / `BEFORE DELETE` triggers raising `ABORT`. Use `BEGIN IMMEDIATE` on anything that may
write — `busy_timeout` does **not** retry `SQLITE_BUSY_SNAPSHOT`.

**Runtime (VERIFIED on this machine):**

```
better-sqlite3 11.10.0  →  SQLite 3.49.2
Node v24.18.0           →  node:sqlite present
```

3.49.2 sits **inside the WAL-reset corruption window** — the bug spans 3.7.0 (2010) through 3.51.2, first fixed in 3.51.3
(2026-03-13), backports 3.44.6 / 3.50.7. It hid for 16 years and is behind 19 Tailscale corruptions in six months. The base doc's
non-waivable gate is correct and is tightened:

1. **Pin 3.53.4**, not the 3.51.3 minimum — the fix plus four patch releases of 3.53.0 fallout. Assert the runtime version at
   startup and refuse to admit tool writes below it (codex).
2. **better-sqlite3 latest is 13.0.3** — an 11→13 two-major jump. Budget an API-break audit in Phase 0, not a version bump.
3. **Evaluate `node:sqlite`** — already present on this machine's Node, exposes `backup`, `setAuthorizer`, `enableDefensive`,
   `createSession`. Dropping the native module removes node-gyp/ABI/antivirus-flagging pain from a Windows installer, which is
   real cost on this platform. Stability 1.2 (RC), so pin the Node version. **(JUDGMENT — a genuine trade; see OPEN-2.)**
4. **Set `synchronous=FULL`** per §3.1. Currently NORMAL.
5. Never place the DB on OneDrive, UNC, or mapped drives — WAL needs shared memory and all processes on one host. Worth an
   explicit startup check given this tree lives under `D:\`.
6. Ship `sqlite3_rsync.exe` (in `sqlite-tools-win-x64`) for hot consistent snapshots, alongside the Online Backup API.

Retained from the base doc unchanged: one host-owned writer connection and FIFO queue per project, one checkpoint owner
(agents and shims never checkpoint), `foreign_keys = ON`, bounded `busy_timeout` with classified `SQLITE_BUSY` telemetry, short
read transactions, WAL/checkpoint/queue-depth metrics, startup recovery and integrity checks before admitting tool writes, and
the OS-level project-writer lease with epoch fencing from §9.5.

## 9. Tool catalog and staged rollout (base §6)

The six tools' *schemas* stand as written in base §6 — bounded strings and arrays, `additionalProperties: false`, declared output
schema, host-minted `invocationId`, host-supplied identity fields. What changes is **when each ships**.

| Tool | First release | Reason |
| --- | --- | --- |
| `zer0_context` | **YES** | Read-only compatibility sentinel and the useful bounded view |
| `zer0_record` | **Later, if dogfooding shows a measured need** | May duplicate automatic host capture (base §7) |
| `zer0_handoff` | **No** | The visible final-line handoff already works; don't run two protocols |
| `zer0_work` | **Deferred** | Needs worktree isolation, durable leases, fenced integration |
| `zer0_check` | **Deferred** | Needs the allowlisted runner and process-tree ownership |
| `zer0_receipts` | **Deferred** | A read projection is useful only once durable work/check records exist |

`zer0_record`'s `visibility: agent_private` durable record is **dropped for v1**: shared coordination state is visible, transient
model reasoning stays transient. If `zer0_record` is later earned, it stores shared operator-visible facts, decisions, and
evidence references only.

**Context budget (adopted from gemini, fills a gap claude flagged in base §15):** the base doc's targets measure context read
*latency*, but the risk in §6.1 is context **size**. `zer0_context` gets a hard token budget — **1500 tokens** as the starting
number — enforced by deterministic compaction: prune superseded notes and obsolete proposals, fold closed tasks into one-line
milestone summaries, truncate git status to modified paths plus tree hashes. Truncate only at item boundaries, and always return
the exact `asOfProjectSeq` plus a continuation cursor. Add a p95 context-payload *token* metric to §15.

**Failure contract (codex, adopted):** every call ends in exactly one of four truthful outcomes — **committed, rejected,
cancelled, or uncertain**. A connection lost after dispatch is never reported as success unless the host can recover the committed
receipt by request ID. This makes `uncertain` a first-class terminal state, which base §9.5's state machine lacks; it is added
there too. Persist the idempotency tuple `(scope, command_type, caller_id, request_id, input_hash)` with the committed receipt:
same key and same input hash returns the original receipt, same key and different input is a conflict.

Stable error codes must separate user rejection, policy rejection, conflict, cancellation, timeout, and uncertainty. Tool
annotations are presentation hints, never authorization. Record the catalog and schema hash with the lane/session binding so a
resume cannot silently attach a different catalog.

## 10. Check runner and process ownership (base §6.4, §14)

The policy in the base doc is right — named allowlist, `shell: false`, env/cwd/network policy, timeout, output cap, no model-
supplied shell text. The *mechanism* was unspecified, and on Windows that is where it fails. All three reviews named the same fix.

**Node core still has nothing (SOURCED):** `subprocess.kill()` explicitly leaves descendants alive; `timeout`/`AbortSignal`/
`killSignal` only signal the direct child; the `killDeep` request (nodejs/node#40438, 2021) never landed.

**Use a Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.** Children created by `CreateProcess` auto-join; closing the
last handle terminates the tree atomically; nested jobs (Win8+) mean it works even when the app is already jobbed. The same object
gives real bounds — job memory cap, CPU rate control, `ActiveProcessLimit`, end-of-job time. This is what Cargo and Bun do, and
end-user setup burden is zero. No maintained npm package wraps it, so call it through **koffi** — which is already needed for §7.

**Kill the assign race properly (1/3, additive):** `spawn()` returns a PID, not a suspended handle, so `OpenProcess` + assign
happens milliseconds late. Instead create a **named** job and spawn a thin runner that `OpenJobObject`s and self-assigns *before*
exec'ing the real argv. Zero window.

**`taskkill /T /F` is a belt-and-braces fallback only** — it enumerates the live tree at kill time, so it misses reparenting and
mid-sweep spawns, and is PID-reuse racy. Gemini listed it as an equal alternative; it is not. **Do not use the `tree-kill`
package** — effectively unmaintained and carrying GHSA-j7fq-p9q7-5wfv (command injection on Windows); pnpm hit exactly this class
of failure in June 2026.

**Output capture:** `stdio: ['ignore','pipe','pipe']`, attach `data` handlers **immediately** — never leave a piped fd unread or
the OS buffer fills and the child blocks forever. Count bytes into a fixed ring, keep head/tail preview plus byte count and
SHA-256, set `truncated`, close the job. Don't rely on `exec`'s `maxBuffer`, which buffers everything and then kills after the fact.

**Rejected sandboxes (SOURCED):** Windows Sandbox and Windows Containers are **not available on Windows 11 Home** — a non-starter
for a consumer desktop app. WSL2 needs a feature install, reboot, and second toolchain. Docker violates the no-setup constraint.
AppContainer's low integrity level breaks compilers and npm caches. microsandbox/E2B/Firecracker are Linux-native or cloud.

Check state persists **before** spawning, with CAS transitions keyed by invocation ID, and reconciles on restart: an in-flight
operation with no durable terminal receipt becomes `uncertain` or `failed_interrupted` — never silently retried, never promoted to
passed.

## 11. Write isolation (base §11) — unchanged

**Keep as written. This is the strongest part of the base document and it is ahead of the field.** Claude Code's own agent teams —
a shipping multi-agent product — has *no* write isolation; its documented best practice is literally "avoid file conflicts: two
teammates editing the same file leads to overwrites." Cursor runs 8 agents in worktrees but its own docs caveat that worktrees
stop *filesystem* conflicts, not semantic ones.

Three additions, no subtractions:

1. **`.git/info/exclude`, not `.gitignore`,** for the per-lane `.agents/mcp_config.json` and any token file — per-worktree, never
   committed. `.gitignore` is committed, pollutes every integration candidate, and could commit a credential (2/3).
2. **`GIT_OPTIONAL_LOCKS=0`** on background status calls, to keep watchers from generating transient `index.lock` collisions (1/3).
3. **Say the limit honestly in the doc:** worktrees prevent write collisions, not conflicting design decisions, and they are not a
   hostile-process security sandbox — they share repository objects, refs, and some configuration. §5's arbiter is where the
   semantic half gets addressed.

Codex's lease hardening is folded in: a durable lease carries a random **fencing token** plus project/session/lane binding,
canonical root, process identity, generation and expiry; revalidate the fence on every mutating operation; never fail open because
a lock file looks old; use TTL only to trigger recovery *inspection*, not to prove ownership is gone. One host-owned integration
writer, explicit operator acceptance before integration, stale lanes re-present their diff against the new base, and **never
auto-merge because checks passed.**

## 12. Observability (base §15)

**Keep an internal model; map to OpenTelemetry GenAI semantic conventions at export time.** Emitting `gen_ai.*` over OTLP means
Datadog, Grafana, Honeycomb, Jaeger, Langfuse and Phoenix read the traces with no custom mapping — but every `gen_ai.*` field is
still **Development** status, and in semconv v1.42.0 (June 2026) GenAI content moved to a separate `semantic-conventions-genai`
repo with **no tagged release yet**, so schema URLs are unpinnable. `gen_ai.system` → `gen_ai.provider.name` already split the
ecosystem once. **Pin the semconv commit you tested against and never couple internals to it.**

The attributes that replace the base doc's hand-written list: `gen_ai.tool.name|type|call.id|call.arguments|call.result`;
`gen_ai.agent.id|name|version`, `gen_ai.conversation.id`, `gen_ai.workflow.name`; spans `invoke_agent {name}`, `execute_tool`;
metrics `gen_ai.client.operation.duration`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_agent.tool_calls`. The
`gen_ai.evaluation.result` event (with `name` / `score.value` / `explanation`) is the natural carrier for host-observed check
results, parented to the span being evaluated.

**Cross-process correlation is spec-supported:** SEP-414 is Final, and trace context rides in `_meta` as **bare, un-prefixed**
`traceparent` / `tracestate` / `baggage` — an explicit documented exception to MCP's DNS-prefix rule. Agent → shim → broker
correlation is not something we invent.

**Local stack, no daemon and no network:** OTel SDK in-process → `BatchSpanProcessor` → **OTLP file exporter** (`.jsonl`) under
`.zer0/traces/`. Viewer: otel-desktop-viewer (Apache-2.0). Optional opt-in deep dive: Arize Phoenix (ELv2, single process, SQLite,
no API key, no phone-home). **Never** default to LangSmith / Braintrust / Langfuse Cloud. A remote collector is never mandatory
for the MVP (2/3).

Multi-agent correlation has no standard beyond W3C Trace Context — the agentic-systems semconv proposal is open with no merged
PRs, and A2A v1.0 only *recommends* traceparent. Model handoffs as parent/child spans and don't wait.

**Release invariants beat invented latency numbers** (codex, adopted): zero acknowledged lifecycle-event loss after crash/restart;
zero duplicate logical effects per idempotency key; zero cross-project or cross-lane disclosure; every uncertain outcome visible
and recoverable; no descendant check process surviving terminal cancellation; projections rebuild deterministically. The base
doc's latency table stays explicitly labelled *proposed*, to be set after load tests on representative repositories — plus the new
context-token budget from §9.

If receipts ever leave the machine, adopt the *shape* of Agent Receipts / in-toto / SLSA — signed, hash-chained, referencing
`trace_id`/`span_id` — not the ecosystems, which are all pre-standard. The base doc's own note that "a local hash chain alone is
not proof against a machine owner rewriting the database" is exactly right and stays.

## 13. Build sequence (merged; replaces base §17)

Each phase has a **stop gate**: a falsifier that halts the program before the next investment.

### Phase 0 — prerequisites (small, parallelizable, none should wait)

1. Pin SQLite **3.53.4**; decide better-sqlite3 13 vs `node:sqlite` (OPEN-2); assert the runtime version at startup.
2. Set `synchronous=FULL` on the ledger connection. Currently NORMAL.
3. **Land the pipe DACL fix** (§7). ~80 lines of koffi; closes a verified Everyone + Anonymous read.
4. Land the Job Object process-ownership abstraction (§10) — same koffi dependency.
5. Write down the same-user threat boundary (§7) as a decision record, not a paragraph in an architecture doc.
6. Session-ID grammar and path containment; secret redaction universal for every durable prompt and tool payload; bounded and
   fingerprinted JSON-RPC replay cache. *(These overlap the m0irai M2 hardening list — do them once, in whichever plan executes
   first, and cross-reference rather than duplicating.)*

**Exit:** schemas validate; the host rejects model-supplied identity; crash/recovery and backup tests pass on the pinned runtime.

### Phase 1 — walking skeleton (the inversion; ~1 week)

`zer0_context` **only**, read-only, returning a static then bounded response. Stdio MCP shim + named-pipe broker **with the
tightened DACL**. Host-minted caller binding, token over stdin. All three lanes: Claude/Codex via ACP descriptors on new *and*
load *and* resume; Gemini via worktree-local `.agents/mcp_config.json`. Writes nothing durable — reads through the existing
journal store.

**Exit:** identical catalog hash observed from all three providers; the *negotiated protocol version* asserted per lane;
`server/discover` taken (not the 2024-11-05 fallback); a forged-identity attempt failing closed; startup failure explicit, never
silent; two simultaneous lanes unable to cross-read identity or data.

**Stop if:** any one provider cannot reliably discover the same semantic server. Diagnose that provider before adding broker or
persistence complexity.

### Phase 2 — real context and a visible feed

Connect the shim to a read-only host broker operation; derive lane identity at the host; return bounded room/project context with
truth-class and freshness metadata under the token budget; publish activity **through the actual Rust room UI** and prove replay
and dedupe.

**This is where codex found a gap worth naming:** the room host publishes `zer0/room/event`, but there is no verified consumer for
the complete event path in the V2 TUI. Backend tests alone do not prove the operator experience. The gate must exercise launch,
live events, reconnect, replay, and duplicate suppression in the real UI.

**Exit:** a real three-provider room shows identical semantics and no cross-lane leakage.

### Phase 3 — selective lifecycle log and durable writes

Migration for the lifecycle event table, blobs, projection cursors. One `ProjectEventWriter` with idempotency and strict
commit-before-ack. Deterministic reducers and a rebuild comparator. Consumer cursor for the feed (§3.2). No legacy backfill.

**Exit:** crash-after-commit, crash-before-commit, duplicate request, and conflicting-replay tests all produce truthful outcomes,
including `uncertain`.

### Phase 4 — write isolation

Durable grants, detached per-lane worktrees from an immutable base SHA, fenced leases, one integration owner, operator-approved
integration, stale-work awareness.

**Exit:** concurrent lanes cannot touch another lane's workspace or integrate with an expired or stale fence; three real write
lanes editing the same file stay isolated and yield attributable base/head/tree and explicit conflicts.

### Phase 5 — checks and receipts

Versioned check registry, owned process trees, timeout/cancel escalation, bounded output, immutable receipts. Then expose
`zer0_check` and `zer0_receipts`.

**Exit:** adversarial process-tree, output-flood, timeout, restart, and unknown-check tests pass on Windows.

### Phase 6 — decide whether more platform is earned

Only after dogfooding: `zer0_work`, a handoff tool adapter, the arbiter's stall counter, external outboxes, broader event
sourcing, legacy backfill. Each needs a measured requirement and its own decision record.

## 14. Provider conformance matrix

No provider is "supported" until every cell is proven against the real installed binary. This replaces the base doc's §18 Gemini
row, which assumed a separate CLI catalog.

| Behaviour | Claude ACP | Codex ACP | Antigravity headless |
| --- | --- | --- | --- |
| Fresh-session discovery | Required | Required | **Proven 2026-08-14** |
| Load/resume catalog parity | Required | Required | Required where supported |
| Negotiated protocol version asserted | Required | Required | Required |
| `server/discover` path taken | Required | Required | Required |
| Strict input rejection | Required | Required | Required |
| Structured result + text fallback | Required | Required | Required |
| Cancellation propagation | Required | Required | Required |
| Shim crash/restart visibility | Required | Required | Required |
| Concurrent lane isolation | Required | Required | Required |
| Host-derived identity | Required | Required | Required |
| No credential in argv or workspace config | Required | Required | Required |
| Feed event and receipt parity | Required | Required | Required |

Base §18's other rows — equal agents, natural fallback, identity, project isolation, truth, durability, idempotency, rebuild,
architecture facts, SQLite, work isolation, checks, check races, handoffs, prompt injection, observability, UX, end-to-end
synergy — carry over unchanged. So does §16's pre-mortem, which all three reviews called the best-written section; nothing is cut
from it.

## 15. Rejected (base §19, extended)

Everything in base §19 stands. Added by this synthesis:

| Alternative | Why rejected |
| --- | --- |
| Generated `zer0-tool` JSON CLI as the Gemini transport | Disproved premise — agy loads workspace-local stdio MCP (VERIFIED) |
| `--dangerously-skip-permissions` to get past agy's headless auto-deny | Also disables the provider-layer read/write split we rely on |
| Lane token in argv | Readable via `Win32_Process.CommandLine` and mirrored into EDR/Sysmon telemetry — the secret leaves the machine |
| Loopback TCP for the broker | No peer identity; any local process at any integrity level can connect (CVE-2026-25253 pattern) |
| `tree-kill` npm package | Unmaintained; GHSA-j7fq-p9q7-5wfv command injection on Windows |
| Windows Sandbox / Containers / WSL2 / Docker / AppContainer | Unavailable on Win11 Home or violate the zero-setup constraint |
| `synchronous=NORMAL` for the ledger | Safe across app crash, **not** across power loss — wrong for a system of record |
| Outbox table for in-process room delivery | The log is the message; a consumer cursor is isomorphic and rebuildable |
| JSON Schema as contract owner | Rust generation bottlenecks on Typify's draft-07 support |
| Junctioned shared `node_modules` (first release) | One lane's install silently corrupts siblings; see OPEN-3 |
| Temporal | Operator decision 2026-08-14, and now removed from the tree entirely |
| CRDTs / cr-sqlite / Emmett / LiveStore / XTDB | Licence, abandonment, or merge semantics that destroy disputed-claim truth |

## 16. Risks this synthesis does not remove

- **The transport is proven for one provider, not three.** agy is VERIFIED; Claude and Codex ACP descriptor injection is
  SOURCED-but-unrun in this harness. Phase 1 exists precisely to fail here cheaply if it is going to.
- **The DACL fix has a race** between `listen()` and tighten. Known window, mitigated by token rotation, not eliminated.
- **`node:sqlite` is Stability 1.2 (RC).** Choosing it trades native-module pain for API churn risk.
- **The arbiter is a design response to measured failure modes, not a measured fix.** It is the least-proven recommendation here.
- **Rust-first schemas couple TS shape to Rust shape.** Cheap now, expensive after fixtures exist — which is why §3.3 asks for the
  decision before any schema is hand-authored.
- **Nothing here has been implemented.** Every phase exit is a claim about tests that do not yet exist.

## 17. Open decisions (operator)

| ID | Decision | Recommendation | Blocks |
| --- | --- | --- | --- |
| **OPEN-1** | Can the agy MCP seam pass a secret on the shim's **stdin**? | Probe it in Phase 0; fallback is an ACL'd per-lane token file | Completes the §7 fix |
| **OPEN-2** | `node:sqlite` vs better-sqlite3 13 | Spike against the real schema before committing | Phase 0 |
| **OPEN-3** | Junctioned `node_modules` for worktree performance | Not in v1; revisit with a no-mutation invariant + hash check | Phase 4 |
| **OPEN-4** | Adopt the rotating arbiter, or keep operator-only synthesis | Adopt; it is mechanical and preserves §3.1 | Phase 6 |
| **OPEN-5** | Does `zer0_record` earn its place, or does automatic host capture cover it? | Decide from dogfooding data, not now | Phase 6 |

None of OPEN-3/4/5 block Phase 0–2. OPEN-1 and OPEN-2 are Phase 0 work.

## 18. Provenance and honesty notes

- The three 2026-08-14 reviews were written **independently**; codex states explicitly it did not read the other two. Agreement
  counts in this document are therefore meaningful, not echo.
- **Gemini's review is the shortest (16 KB vs 40 and 36) and was overruled on two of its distinctive positions** —
  `synchronous=NORMAL` (§3.1) and junctioned `node_modules` (§3.4). Its transport diagram, the `.git/info/exclude` credential
  rule, `GIT_OPTIONAL_LOCKS=0`, the 1500-token context budget, and the Job Object requirement were adopted. Recording this so the
  disagreement is visible rather than smoothed over.
- **Claude's review contains the only self-reversal** in the set: it had earlier advised putting the lane token in `args`, then
  disproved that on security grounds. §7 carries the corrected position.
- Two findings from the reviews **expired** between then and now because the extraction deleted their subject matter: codex's
  tower-adapter argv blocker and claude's Temporal-residue note. Their rules survive; their file references do not.
- Everything in §14 remains **UNVERIFIED** except the one cell marked proven. This document is a build contract, not a completion
  claim.

## 19. Sources

**Protocol / providers:** [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) ·
[MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) ·
[MCP stdio lifecycle](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) ·
[SEP-414 request `_meta`](https://modelcontextprotocol.io/seps/414-request-meta.md) ·
[MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) ·
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [rmcp Rust SDK](https://github.com/modelcontextprotocol/rust-sdk) ·
[ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup) ·
[Antigravity CLI MCP docs](https://antigravity.google/docs/cli/mcp) · [Antigravity MCP overview](https://antigravity.google/docs/mcp) ·
[agy issue #60](https://github.com/google-antigravity/antigravity-cli/issues/60) ·
[Codex MCP](https://developers.openai.com/codex/mcp) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) ·
[Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)

**Storage:** [SQLite changelog](https://www.sqlite.org/changes.html) · [SQLite WAL](https://sqlite.org/wal.html) ·
[synchronous pragma](https://sqlite.org/pragma.html#pragma_synchronous) · [Online Backup API](https://www.sqlite.org/backup.html) ·
[3.51.3 release notes](https://www.sqlite.org/releaselog/3_51_3.html) · [sqlite3_rsync](https://sqlite.org/rsync.html) ·
[Tailscale WAL-reset writeup](https://tailscale.com/blog/sqlite-wal-reset-bug) · [node:sqlite](https://nodejs.org/api/sqlite.html) ·
[Emmett](https://github.com/event-driven-io/emmett) · [LiveStore project state](https://docs.livestore.dev/evaluation/state-of-the-project/) ·
[cr-sqlite](https://github.com/vlcn-io/cr-sqlite) · [Marten async daemon](https://martendb.io/events/projections/async-daemon.html) ·
[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) ·
[AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) ·
[Azure event sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)

**Schema:** [schemars](https://github.com/GREsau/schemars) · [Typify](https://github.com/oxidecomputer/typify) ·
[Typify 2 WIP](https://ahl.dtrace.org/2026/05/10/typify2-wip/) · [Ajv standalone](https://ajv.js.org/standalone.html) ·
[jsonschema crate](https://docs.rs/jsonschema/latest/jsonschema/) · [RFC 8785 JCS](https://datatracker.ietf.org/doc/html/rfc8785) ·
[JSON Schema 2020-12](https://json-schema.org/draft/2020-12)

**Windows platform:** [Named pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) ·
[GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid) ·
[libuv win/pipe.c](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c) · [nodejs/node#55979](https://github.com/nodejs/node/issues/55979) ·
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) ·
[Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) ·
[nodejs/node#40438 killDeep](https://github.com/nodejs/node/issues/40438) · [koffi](https://koffi.dev/) ·
[GHSA-j7fq-p9q7-5wfv](https://github.com/advisories/GHSA-j7fq-p9q7-5wfv) ·
[Hard links and junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions) ·
[Git worktree](https://git-scm.com/docs/git-worktree) · [Git env vars](https://git-scm.com/docs/git)

**Coordination research:** [MAST — Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657)](https://arxiv.org/abs/2503.13657) ·
[The Specification Gap (arXiv 2603.24284)](https://arxiv.org/abs/2603.24284) ·
[Magentic-One (arXiv 2411.04468)](https://arxiv.org/html/2411.04468v1) · [AgentNet (arXiv 2504.00587)](https://arxiv.org/abs/2504.00587) ·
[Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)

**Observability:** [OTel GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) ·
[GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) ·
[GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md) ·
[OTLP file exporter](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/) ·
[otel-desktop-viewer](https://github.com/CtrlSpice/otel-desktop-viewer) · [Arize Phoenix](https://github.com/Arize-ai/phoenix) ·
[W3C Trace Context](https://www.w3.org/TR/trace-context/) · [OpenTelemetry spec](https://opentelemetry.io/docs/specs/otel/)

---

**Status: INCOMPLETE, by design.** Zer0 does not yet expose these tools, isolate write lanes, or keep a coordination lifecycle
log. The recommended next action is Phase 0 — four small independent items, of which the pipe DACL fix is the one that closes a
verified security defect — followed by the Phase 1 walking skeleton, which is the cheapest possible way to find out whether this
architecture is buildable at all.
