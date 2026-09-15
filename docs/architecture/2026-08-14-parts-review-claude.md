# Zer0 Synergy Architecture — Parts Review (claude)

- **Author:** claude
- **Date:** 2026-08-14
- **Reviews:** [`2026-08-13-agent-synergy-tool-architecture.md`](./2026-08-13-agent-synergy-tool-architecture.md)
- **Method:** the plan cut into 12 replaceable parts. Each part sourced independently against the 2026 state of the art, then re-assembled.
- **Status:** opinion. Not a decision. Decision owner is the Operator.

## Evidence grades

Every claim below carries one. I do not want this document read as uniformly confident, because it isn't.

| Grade | Meaning |
| --- | --- |
| **VERIFIED** | I ran it on this machine and reproduced the result. Quoted output. |
| **SOURCED** | Primary documentation, spec text, or peer-reviewed paper. URL given. |
| **JUDGMENT** | My engineering opinion. Argued, not proven. Disagree freely. |

---

## Verdict table

| # | Part (car) | Doc's choice | My call | Grade |
| --- | --- | --- | --- | --- |
| 1 | Engine — tool transport | 2 transports: MCP + generated CLI | **Replace.** One stdio MCP for all three | SOURCED |
| 2 | Transmission — schema contract | JSON Schema bundle → Node + Rust | **Flip.** Rust-first serde+schemars → JSON Schema → TS | SOURCED |
| 3 | Fuel system — event ledger | Hand-rolled SQLite append-only log | **Keep.** Nothing off-the-shelf fits | SOURCED |
| 4 | Fuel tank — storage runtime | SQLite 3.51.3+, better-sqlite3 | **Amend.** 3.53.4; `node:sqlite`; `synchronous=FULL` | VERIFIED |
| 5 | Drivetrain — outbox/delivery | Transactional outbox table | **Simplify.** Consumer cursor, not a table | JUDGMENT |
| 6 | Locks — local IPC + identity | Named pipe w/ "current-user ACL" | **BROKEN AS SPECIFIED.** See §6 | **VERIFIED** |
| 7 | Catalytic converter — check runner | `shell:false` + allowlist | **Upgrade.** Windows Job Object | SOURCED |
| 8 | Chassis — write isolation | Worktree + branch lease per lane | **Keep.** Best part in the document | SOURCED |
| 9 | Dashboard — observability | W3C trace + hand-written metrics | **Adopt a standard.** OTel GenAI semconv | SOURCED |
| 10 | Steering — coordination model | Peers, operator-only synthesis | **Half wrong.** Peers OK, synthesis isn't | SOURCED |
| 11 | Airbags — truth classes / injection | 4 truth classes, taint, per-call authz | **Keep.** Independently validated | SOURCED |
| 12 | Assembly order — phasing | Ledger (P1) before transport (P2) | **Invert.** Transport spike first | JUDGMENT |

Three parts are wrong in ways that matter: **#6 is a live security defect**, **#2 is a build-order trap**, **#10 is a design defect the doc doesn't name.** The rest is sound, and #8 is genuinely ahead of the industry.

---

## 1. Engine — tool transport

**Doc:** Gemini has no MCP injection seam, so generate a `zer0-tool` JSON CLI and build a net-new Antigravity tool-calling seam. Gemini support stays `UNVERIFIED`.

**Reality (SOURCED):** Antigravity CLI supports stdio MCP natively, at two documented scopes — global `~/.gemini/config/mcp_config.json` and **workspace-local `.agents/mcp_config.json`** — with `command`/`args`/`env`, plus a permission system using `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)`, defaulting unconfigured tools to **Ask**.

**VERIFIED end-to-end (gemini, 2026-08-14, live `agy.exe` on this machine):** workspace-local `.agents/mcp_config.json` **does** load. A probe stdio server was discovered, `tools/list` returned, and `zer0_probe_ping` was called mid-turn with the structured result consumed. agy issue #60 does **not** apply to the `.agents/` path. Part #1's per-lane binding via worktree-local config is confirmed available.

### Two things the probe wire log proves that change the shim spec

The captured handshake was:

```jsonc
RECV {"id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}
RECV {"id":2,"method":"initialize","params":{"clientInfo":{"name":"antigravity-client"},"protocolVersion":"2025-11-25"}}
SEND {"id":2,"result":{"protocolVersion":"2024-11-05",...}}
```

1. **agy is a 2026-07-28-aware client that probes `server/discover` FIRST**, then falls back to legacy `initialize` when the server doesn't answer it. This is exactly the backward-compat probe path the changelog describes for STDIO — now empirically confirmed against a real provider. **The shim MUST implement `server/discover`** so agy takes the modern stateless path instead of silently degrading to the legacy handshake. The probe server didn't, so it negotiated all the way down to 2024-11-05 and still worked — which is reassuring for compatibility but is *not* the path we want in production.
2. **Version negotiation spans three revisions in one handshake** (2026-07-28 probe → 2025-11-25 offer → 2024-11-05 accepted). The provider-compatibility test in §18 must assert the *negotiated* version per lane, not merely that a call succeeded. A silent downgrade to 2024-11-05 loses `resultType`, `outputSchema` guarantees, and the tasks extension — i.e. several things Part #1 depends on.

**Headless permission gate (VERIFIED, gemini seq 191):** in `--print` mode agy auto-denies any tool needing an unprompted permission. Lane launch must pre-authorize the Zer0 catalog (`mcp(zer0/*)` scoped per the policy table) — *not* `--dangerously-skip-permissions`, which would also disable the read/write split Part #1 relies on.

**Call — one transport, not two:**

| Lane | Injection seam |
| --- | --- |
| Claude, Codex | ACP `session/new` → `mcpServers` stdio descriptor |
| Gemini | host-written `.agents/mcp_config.json` **inside the lane's worktree** |

Part #8 already gives every write lane a unique worktree, so the workspace-local scope *is* per-lane injection. The isolation part pays for itself twice. **Delete:** the generated CLI, the "net-new seam", the dual-shim rules in §14, the separate Gemini row in §18, and the `UNVERIFIED` status.

**Free win:** agy's `mcp(server/tool)` patterns map onto §8.2's policy table. Pre-authorize `mcp(zer0/zer0_context)` and `mcp(zer0/zer0_receipts)`; leave `zer0_check`/`zer0_work` writes in Ask. Provider-layer enforcement *in addition to* host registry.

### MCP 2026-07-28 changed the ground under §5 (SOURCED)

- `initialize`/`notifications/initialized` **removed**. MCP is stateless; protocol version + client capabilities ride in `_meta` per request. The doc's "retain legacy initialization compatibility" instinct is right; the mechanism now has a name — **`server/discover`**, explicitly designed as the STDIO backward-compat probe.
- Protocol sessions and `Mcp-Session-Id` **gone**. Spec now says cross-call state uses "server-minted handles passed as ordinary tool arguments" — that is exactly `invocationId`/receipt IDs. §8.1 goes from local policy to spec-aligned.
- **§6.4 reinvents a standard.** Long checks return a pending receipt polled via `zer0_receipts`. There is now an official `io.modelcontextprotocol/tasks` extension with `tasks/get` polling and `tasks/update`. Build on it; keep receipts as fallback.
- **Missing from the doc entirely:** `resultType` is now **required** on every result; `ttlMs`/`cacheScope` **required** on `tools/list`. Both are shim output-contract changes.
- Roots/Sampling/Logging deprecated. The spec's own logging migration is "log to stderr (stdio)" — already §14's rule.

### SDK policy simplifies

v2 is the stable line and **retires the monolithic `@modelcontextprotocol/sdk`** for `@modelcontextprotocol/server` / `/client`. Your shim is a *server*; the Claude ACP bridge's v1 pin is client-side, already a separate process. The isolation §5 wanted to engineer is a consequence of the package split. Rewrite as: pinned `@modelcontextprotocol/server` v2, no SDK objects across the process boundary.

---

## 2. Transmission — schema contract

**Doc:** one versioned JSON Schema 2020-12 bundle owns tool schemas and room events; generate Node validators and Rust types from it.

**The trap (SOURCED):** JSON-Schema-as-owner dies on the Rust generator. Typify's own maintainer states it handles "basically Draft 7" and struggles with 2020-12; Typify 2 is an unreleased multi-year WIP he classes as "nice-to-have, not hair-on-fire" (tracking issue #579 open since 2024). Every schema-first *and* TS-first option routes Rust through this bottleneck.

**Call — flip to Rust-first.** The official Rust MCP SDK (`rmcp`) already derives tool `inputSchema`/`outputSchema` from `schemars::JsonSchema`, and **schemars 1.x emits 2020-12 by default**. So:

```
Rust types (serde + schemars)  ──emit──>  JSON Schema 2020-12 bundle  ──gen──>  TS types
        │                                          │
        └─ reducer event enum, hand-written        └─ MCP tool schemas, native
```

The reducer's event enum stays idiomatic hand-written Rust; the contract is *derived from* it. Zero Rust codegen. Zero draft-07 bottleneck.

**TS side:** split types from validation. **Ajv 8.20 (`ajv/dist/2020`) with standalone codegen** is the load-bearing piece — full 2020-12 including `prefixItems`, compiled at build time, no eval, CSP-safe. `json-schema-to-typescript` for ergonomic types only (it's stale — last publish 15.0.4, Jan 2025 — so treat its output as convenience, Ajv as truth). Rust-side CI parity via the `jsonschema` crate.

**Catalog hash:** JCS (RFC 8785), and two rules that matter more than the algorithm — **bundle/dereference first, then canonicalize** (so `$ref` refactors don't churn the hash; MCP forbids auto-dereferencing external `$ref` anyway), and `sha256(JCS({name → sha256(JCS(schema))}))` sorted.

**Cost to be honest about (JUDGMENT):** TS becomes downstream, and schema shape couples to Rust type shape. Mitigate with `#[schemars(...)]` overrides and golden fixtures. I still think this is clearly right — the alternative is hand-writing Rust types forever and testing conformance instead of generating it.

---

## 3. Fuel system — event ledger

**Doc:** hand-rolled append-only `project_events` with hash chain, projections, cursors.

**Call: keep it.** This is one of the cases where hand-rolling is correct, and the survey confirms it rather than undermining it.

- **Emmett** is the only credible contender — actively developed, SQLite store — but has **no LICENSE file at all** (both `LICENSE` and `LICENSE.md` 404; GitHub API reports `license: null`), and its open dual-licensing RFC proposes AGPLv3/SSPL. Disqualifying twice for a shipped desktop app.
- **LivestStore**: Apache-2.0 and well-designed, but beta, storage format may break across minors, *requires* a sync backend for ordering you already get free, and rebasing rewrites the log — which invalidates a hash chain.
- **XTDB v2**: genuine bitemporality and reified transaction metadata, but from Node it's a JVM sidecar over Postgres wire. A fourth heavyweight process to get what a `truth_class` column gives you.
- **Rejected outright:** CRDTs (Automerge/Yjs/Jazz) — they *merge*, which destroys disputed-claim semantics, i.e. the entire point of §3.2. Electric/PowerSync/Zero need Postgres + server. **cr-sqlite is abandoned** (last release 2024-01, author moved on). LiteFS dead. Replicache archived. SQLite's session extension is physical row diffs, not semantic events — wrong tool, and not compiled into better-sqlite3 anyway.

**Performance is a non-issue (SOURCED, measured by research agent):** 200k events appended in 962 ms; full hash-chain verification in 968 ms. Skip Merkle trees — O(n) verify at ~1s for 200k is fine at your scale.

**Add:** enforce append-only with `BEFORE UPDATE`/`BEFORE DELETE` triggers raising `ABORT`. `BEGIN IMMEDIATE` on anything that may write — `busy_timeout` does **not** retry `SQLITE_BUSY_SNAPSHOT`.

---

## 4. Fuel tank — storage runtime

**VERIFIED on this machine:**

```
better-sqlite3 11.10.0  →  SQLite 3.49.2
Node v24.18.0           →  node:sqlite present (typeof === "object")
```

3.49.2 is **inside the WAL-reset corruption window**. The bug spans 3.7.0 (2010) → 3.51.2; first fixed **3.51.3 (2026-03-13)**; backports 3.44.6 / 3.50.7; also in 3.53.0 (3.52.0 was withdrawn, folded in). Latest **3.53.4**. This is the bug behind 19 Tailscale corruptions in six months that hid for 16 years. The doc's non-waivable gate is correct.

**Amendments:**

1. **Pin 3.53.4, not the minimum 3.51.3** — you get the fix plus four patch releases of 3.53.0 fallout.
2. **better-sqlite3 latest is 13.0.3** — an 11→13 two-major jump. The doc budgets a version bump; this is an API-break audit. Budget it in Phase 0.
3. **Seriously consider `node:sqlite` instead** — already present on this machine's Node v24.18.0, exposes `backup`, `setAuthorizer`, `enableDefensive`, `createSession`. Dropping the native module removes node-gyp/ABI/antivirus-flagging pain from a Windows installer, which is real cost on this platform. It's Stability 1.2 (RC), so pin the Node version. **(JUDGMENT — this is a genuine trade, not a slam dunk.)**
4. **`synchronous=FULL` is not currently set.** `.zer0/evidence.db` is at `synchronous=1` (NORMAL). In WAL mode that can lose recently committed transactions on power loss. Wrong for a system of record. The doc says FULL; the code doesn't do it. Close the gap.
5. Never place the DB on OneDrive/UNC/mapped drives — WAL requires shared memory and all processes on one host. Worth an explicit startup check given this repo lives under `D:\`.
6. Ship `sqlite3_rsync.exe` (in the official `sqlite-tools-win-x64` bundle) for hot consistent snapshots.

---

## 5. Drivetrain — outbox and delivery

**Doc:** transactional outbox table, committed in the same transaction, relayed to the room at least once.

**Call: replace the table with a consumer cursor (JUDGMENT, moderately confident).**

An outbox buys three things: atomicity, durable undelivered-state, and ordering. Here the log already gives atomicity (**the event *is* the message**) and ordering (single writer ⇒ commit order == `seq` order, **with no gaps** — this is genuinely easier than Postgres, where Marten needs a high-water-mark gap detector because sequences are issued pre-commit). That leaves delivery state, which `(consumer_id, last_seq)` encodes isomorphically — and *rebuildably*: set cursor to 0 and replay, versus a deleted outbox row that's gone forever. This is what Marten's async daemon and Kafka consumers actually do; microservices.io itself lists event sourcing as the alternative to outbox for this reason.

Emit-on-commit for latency; the cursor is the correctness mechanism.

**Keep a real outbox only for effects that leave the machine or are non-idempotent** — telemetry upload, `git push`, paid agent spawns — because a cursor cannot distinguish "not started" from "done but crashed before ack." That distinction is the outbox's actual job, and it doesn't apply to publishing into your own room feed.

**Two plumbing corrections:** don't use SQLite commit/update hooks (fire pre-commit, order unspecified, no Node driver exposes them). `PRAGMA data_version` **does** work cross-process and is a valid cheap change-signal for the Rust UI — but it is documented as unchanged for same-connection commits, so it cannot notify the host of its own writes.

---

## 6. Locks — local IPC and identity 🔴

**This is the finding I would escalate first.**

**Doc §8.1:** "the per-lane shim … connects to a random named pipe protected by the current-user ACL."

**VERIFIED — that ACL does not exist.** libuv calls `CreateNamedPipeW(..., lpSecurityAttributes = NULL)`, so Node pipes get Windows' *default* security descriptor. I created a `net.createServer()` pipe on this machine and read its DACL via `CreateFileW(READ_CONTROL)` + `GetSecurityInfo(SE_KERNEL_OBJECT)`:

```
D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-3668660514-27240486-2574848101-1001)(A;;FR;;;WD)(A;;FR;;;AN)
```

- `SY` LOCAL SYSTEM — full
- `BA` BUILTIN\Administrators — full
- current user (`…-1001`, confirmed = my SID) — full
- **`WD` = Everyone — `FILE_GENERIC_READ`**
- **`AN` = ANONYMOUS LOGON — `FILE_GENERIC_READ`**

Any local account can open the broker pipe for read. libuv also omits `PIPE_REJECT_REMOTE_CLIENTS`, so it is reachable over SMB as `\\host\pipe\name`. And pipe names are **enumerable by anyone** — I listed live pipes with one call:

```
[System.IO.Directory]::GetFiles("\\.\pipe\")   →   \\.\pipe\InitShutdown, lsass, ntsvcs, …
```

So "random pipe name" is not a control either. Node's only public knob (`readableAll`/`writableAll`) can *only widen* access to the World SID; there is no narrowing API, and `fd()` returns `-1` on Windows so the handle is unreachable from JS.

**Fix (SOURCED, verified working by research agent):** after `listen()`, one FFI call via **koffi** — `CreateFileW(name, WRITE_DAC|READ_CONTROL)` then `SetSecurityInfo(SE_KERNEL_OBJECT, DACL)` — applying `D:P(A;;FA;;;SY)(A;;FA;;;<logonSID>)`. Use the **logon SID**, not merely the user SID; Microsoft documents this as the way to exclude other terminal-services sessions and remote users. There remains a small race between `listen` and tighten; treat it as a known window and rotate tokens.

**Secret channel — the doc's choice is the worst of the three.** Ranked worst → best:

1. **argv** — readable by same-user code via `Win32_Process.CommandLine`, *and* mirrored into Sysmon/ETW/EDR logs and crash dumps. It escapes the machine.
2. **env** — needs `PROCESS_VM_READ` (same-user only), but silently inherited by every descendant.
3. **file with explicit SID ACL + DPAPI**, or best of all: **the CLI spawns the shim, so write the token to the shim's stdin.** Not enumerable, not logged, not inherited.

⚠️ **This directly reverses my own earlier advice in this thread.** In the previous message I proposed putting the lane token in `args` because agy's MCP-config `env` handling is reportedly flaky. That was wrong on security grounds — argv lands in EDR telemetry. Correct answer: **token over stdin**; if the agy MCP seam cannot do stdin, use a per-lane token *file* inside the worktree with an explicit SID ACL and `.git/info/exclude`, never `args`.

**Honest assessment of the token (JUDGMENT):** against the *Node default* ACL, the token is genuinely load-bearing — it blocks other users and remote SMB. Once the DACL is tightened to the logon SID on a single-user box, the token buys very little: same-user code can already open the pipe, read argv, `ReadProcessMemory` the env, and inject into the host. Keep it (near-free, gives rotation hygiene and misrouting protection), but **the ACL is the control, and the doc currently has neither.**

**Also:** peer credential checks (`GetNamedPipeClientProcessId`) need the accepted pipe *handle*, which Node never exposes — unreachable from JS even with FFI. Without a native addon, the ACL is your peer check. And the MCP spec is **silent** on authenticating a local socket peer (it assumes stdio, where the client spawns the server and the OS user account is the trust boundary). This design is outside the spec; Zer0 owns it.

**Reject loopback TCP outright** — no peer identity, any local process at any integrity level can connect, port discoverable. That is the "loopback == trusted" pattern behind CVE-2026-25253. AF_UNIX is also out: Node maps all `net` paths to named pipes on Windows (#55979 still open).

---

## 7. Catalytic converter — check runner

**Doc:** named allowlist, `shell:false`, env/cwd/network policy, timeout, output cap, "process-tree termination required."

The policy is right. The *mechanism* is unspecified, and on Windows that's where it fails.

**Node core still has nothing (SOURCED).** `subprocess.kill()` explicitly leaves descendants alive; `timeout`/`AbortSignal`/`killSignal` only signal the direct child; the `killDeep` request (nodejs/node#40438, 2021) never landed.

**Call: Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.** Children created by `CreateProcess` auto-join; closing the last handle terminates the whole tree atomically; nested jobs (Win8+) mean it works even when your app is already jobbed. The same object gives real bounds — job memory cap, CPU rate control, `ActiveProcessLimit`, end-of-job time. This is what Cargo and Bun do. **End-user setup burden: zero.**

No maintained npm package wraps it, so call it through **koffi** (prebuilt binaries, no node-gyp — and you already need koffi for part #6). ~80 lines.

**Kill the assign race properly:** `spawn()` returns a PID, not a suspended handle, so `OpenProcess`+assign happens milliseconds late. Instead create a **named** job and spawn a thin runner that `OpenJobObject`s and self-assigns *before* exec'ing the real argv. Zero window.

**Keep `taskkill /T /F` as a belt-and-braces fallback only.** It enumerates the live tree at kill time, so it misses reparenting and mid-sweep spawns, and is PID-reuse racy. Do **not** use the `tree-kill` package — effectively unmaintained and carries GHSA-j7fq-p9q7-5wfv (command injection on Windows). pnpm hit exactly this class of failure in June 2026.

**Rejected:** Windows Sandbox and Windows Containers are **not available on Windows 11 Home** — non-starter for a consumer desktop app. WSL2 needs a feature install + reboot + second toolchain. Docker violates the no-setup constraint. AppContainer's low integrity level breaks compilers and npm caches. microsandbox/E2B/Firecracker are Linux-native or cloud.

**Output capture:** `stdio: ['ignore','pipe','pipe']`, attach `data` handlers **immediately** — never leave a piped fd unread or the OS buffer fills and the child blocks forever. Count bytes yourself into a fixed ring, set `truncated`, close the job. Don't rely on `exec`'s `maxBuffer` (buffers everything, then kills after the fact).

---

## 8. Chassis — write isolation

**Keep as written. This is the best part of the document and it is genuinely ahead of the field.**

Claude Code's own agent teams — Anthropic's shipping multi-agent product — has **no write isolation**. Its documented best practice is literally "avoid file conflicts: two teammates editing the same file leads to overwrites," with task-status lag and no session resumption as known limitations. Cursor runs 8 agents in worktrees but its own docs caveat that worktrees stop *filesystem* conflicts, **not semantic ones**.

So §11 is not gold-plating; it's the differentiator. Two additions:

1. **`.git/info/exclude`, not `.gitignore`,** for the per-lane `.agents/mcp_config.json` (and any token file). `.git/info/exclude` is per-worktree and never committed; `.gitignore` is committed and would pollute every integration candidate — and could commit a credential.
2. Note the limit honestly in the doc: worktrees prevent write collisions, not conflicting design decisions. Part #10 is where that gets addressed.

---

## 9. Dashboard — observability

**Doc:** W3C Trace Context, one root per operator turn, plus a hand-written metrics list.

**Call: adopt OpenTelemetry GenAI semantic conventions instead of inventing names (SOURCED).** Emitting `gen_ai.*` over OTLP means Datadog, Grafana, Honeycomb, Jaeger, Langfuse and Phoenix all read your traces with no custom mapping.

Concretely, the attributes that replace the doc's hand-written list:

- **Tool calls:** `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`
- **Agent/correlation:** `gen_ai.agent.id|name|version`, `gen_ai.conversation.id`, `gen_ai.workflow.name`
- **Spans:** `invoke_agent {name}`, `execute_tool`, `{operation} {model}`
- **Metrics:** `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.invoke_agent.tool_calls`, `gen_ai.execute_tool.duration`
- **Evaluation:** the `gen_ai.evaluation.result` event with `gen_ai.evaluation.name|score.value|explanation` — **this is the natural carrier for host-observed check results**, parented to the span being evaluated.

**Caveat that must go in the doc (SOURCED):** every `gen_ai.*` field is still **Development** status, and in semconv v1.42.0 (June 2026) GenAI content moved to a separate `semantic-conventions-genai` repo with **no tagged release yet** — schema URLs are unpinnable. `gen_ai.system` → `gen_ai.provider.name` already split the ecosystem once. So: **keep your own internal model, map to `gen_ai.*` at export time, and pin the semconv commit you tested against.** Do not couple internals to a moving target.

**MCP side confirmed:** SEP-414 is Final. Trace context rides in `_meta` as **bare, un-prefixed** `traceparent` / `tracestate` / `baggage` — an explicit documented exception to MCP's DNS-prefix rule. So cross-process correlation from agent → shim → broker is spec-supported, not something you invent.

**Local stack for a privacy-respecting desktop app:** OTel SDK in-process → `BatchSpanProcessor` → **OTLP file exporter** (`.jsonl`) under `.zer0/traces/`. Zero network, zero daemon. Viewer: **otel-desktop-viewer** (Apache-2.0, Go+DuckDB, OTLP in, local UI). Optional opt-in deep dive: **Arize Phoenix** (ELv2, single process, SQLite, no API key, no phone-home). **Never** default to LangSmith/Braintrust/Langfuse Cloud.

**Multi-agent correlation:** there is no standard beyond W3C Trace Context. The agentic-systems semconv proposal (genai repo issue #35) is open with no merged PRs; A2A v1.0 only *recommends* traceparent. Model handoffs as parent/child spans yourself and don't wait for a standard.

**Attestation:** if receipts ever leave the machine, adopt the *shape* used by Agent Receipts / in-toto / SLSA — signed, hash-chained, referencing `trace_id`/`span_id` — not the ecosystems, which are all pre-standard. The doc's own note that "a local hash chain alone is not proof against a machine owner rewriting the database" is exactly right and should stay.

---

## 10. Steering — coordination model

**Doc §3.1:** no lead agent, all three equal, operator is the only synthesizer.

I asked for evidence that this is wrong. Here is what came back — it splits.

**The peer choice is defensible at N=3. The "operator is the only synthesizer" clause is the actual defect.**

**What SOTA ships (SOURCED):** overwhelmingly orchestrator-worker. Claude Code agent teams has a fixed lead that decomposes, assigns, *and synthesizes*. Anthropic's own research system (lead + 3–5 subagents) beat single-agent Opus 4 by 90.2% at ~15x tokens. Magentic-One's Orchestrator keeps a Task Ledger **and** a Progress Ledger with a **stall counter (>2 → replan)** — a dedicated convergence organ. OpenAI deprecated Swarm (true peer) in 2025 in favour of supervisor-routing handoffs. Survey data puts orchestrator-worker at ~70% of production deployments, and rates *independent* (parallel, non-communicating) MAS as the **weakest** variant — 17.2x trace-level error amplification.

Note though: Codex `--attempts 3`, Jules `--parallel`, and Cursor's 8-agent worktrees are **not** peer coordination — they're fan-out with the **human as selector**, which is precisely Zer0's model. So the model has company; it just isn't usually called multi-agent.

**The measured failure mode (SOURCED):** MAST (NeurIPS 2025, 1,642 annotated traces, κ=0.88) attributes failures to system design 43.8%, inter-agent misalignment 32.2%, verification 24.1%. Largest individual modes: **step repetition 15.7%** (duplicated work — the predicted risk, confirmed), reasoning-action mismatch 13.2%, **unaware of termination conditions 12.4%**. Deadlock on claims is *not* a top mode; "ignored other agent's input" is only 1.9%. Role clarification buys +9.4pp, task-objective verification +15.6pp — real but insufficient.

**Implication:** removing the lead removes the component that owns termination detection, stall→replan, and cross-agent verification — roughly **36% of known failure mass** now lands on a human, in real time.

**The most damning paper for this design (SOURCED):** "The Specification Gap" (arXiv 2603.24284) — two agents implementing one class, integration accuracy fell **58% → 25%** as specs degraded to bare signatures. A persistent **25–39pp coordination gap**. Critically: an AST conflict detector hit 97% precision, and **giving agents the conflict reports did not improve outcomes.**

Read that against §6.3. **CAS claims and file leases are correct-by-construction and are not the bottleneck.** They prevent write collisions you'd catch anyway. The leverage is entirely in **work-item specification richness** — `objective`, `acceptance[]`, and interface contracts. The doc caps `objective` at 4096 chars and treats acceptance as a bounded list; that is the highest-leverage field in the whole schema and it's currently an afterthought.

**Is operator-only synthesis a scalability trap? Yes, and you're at the edge.** Reconciliation is pairwise: N=3 → 3 pairs, N=4 → 6, N=5 → 10. Human review capacity doesn't scale — AI-assisted teams merged 98% more PRs but review time rose 91%; agentic PRs run 2.5x larger with 5.3x pickup time. **It breaks at N=4–5.** At N=3 it holds, barely, and only because heterogeneous vendors give genuine diversity — the one thing peers provide that a lead cannot.

**Recommendation (JUDGMENT):** keep the peer topology and the equal-agent invariant. **Kill "the operator is the only synthesizer."** Add a **rotating mechanical arbiter** — a per-work-item role, not a standing lead, so §3.1 survives intact — owning exactly the three things Magentic-One's orchestrator owns:

1. a progress ledger with a **stall counter** (you already have the event stream to compute it),
2. explicit **termination/done criteria** per work item (directly attacks FM "unaware of termination conditions", 12.4%),
3. **cross-lane verification** before the operator sees anything.

All three are mechanical, host-owned, and *do not* require an agent to judge another agent — so §3.2's truth invariant is untouched. Then add "operator decisions required per turn" to §15's metrics, so you can see the bottleneck arriving instead of discovering it.

---

## 11. Airbags — truth classes and injection containment

**Keep. Independently validated by convergent evolution.**

Claude Code agent teams arrived at the same three conclusions from a different direction: shared task list with **file-locking claims** (= §6.3 CAS), and — notably — messages from another agent are explicitly treated as **untrusted input that cannot grant a permission or relay an approval**, with no nested teams (= the one-hop rule). When two independent teams converge on your hardest invariants, that's signal.

§3.2's four truth classes remain the most valuable idea in the document. §16's pre-mortem, with a *falsifying test* per row, is the best-written section and I would cut nothing from it.

**Two small corrections in §9.1:**

- `trace_id` has a stray space breaking column alignment. This is a build contract; people will paste it.
- `UNIQUE (project_id, source_kind, source_id)` contradicts "IDs are `NOT NULL`; ordinary SQLite primary-key null behavior is not relied on" — natively-generated events have no source. It happens to work because SQLite treats NULLs as distinct in UNIQUE, i.e. it relies on exactly the behaviour the sentence disclaims. Make it a partial index: `... WHERE source_kind IS NOT NULL`.

**One gap in §15:** the targets measure latency, but the actual risk in §6.1 is context **size**. "Context read p95 < 250 ms" is not the number that will hurt. A p95 context-payload *token* budget is, and it's missing.

---

## 12. Assembly order — phasing

**Doc:** Phase 0 gates → Phase 1 canonical ledger + backfill → Phase 2 MCP broker → … → Phase 7.

**Call: invert Phases 1 and 2 (JUDGMENT, high confidence).**

Seven phases with a full event-sourced ledger, backfill, dual-read parity, rebuild comparator, worktree service and Rust reducer changes — all before a single provider has called a single tool.

The biggest unknown is not the ledger. The ledger is well-understood engineering with a known-good design (part #3). **The unknown is part #1: can all three providers actually discover and call one catalog under host-minted identity, in this harness, on Windows?** That's roughly a one-week spike, and it currently sits behind a full data migration. If Gemini's `.agents/` scope turns out not to load, or the DACL fix in part #6 doesn't hold, §6's entire catalog shape changes — and you'd have built a ledger for a design you then redo.

**Insert Phase 0.5 — walking skeleton:**

- `zer0_context` only. Read-only. Zero durability risk.
- stdio MCP shim + named-pipe broker **with the tightened DACL from part #6**.
- host-minted caller binding, token over stdin.
- all three lanes: Claude/Codex via ACP descriptors, Gemini via worktree-local `.agents/mcp_config.json`.
- writes nothing durable — reads through the *existing* journal store.
- **Exit criterion:** identical catalog hash observed from all three providers, and a forged-identity attempt failing closed.

Then Phase 1. The doc already orders `zer0_context` before `zer0_record` correctly; this just moves the pair in front of the migration.

**Phase 0 additions** (from parts #4, #6, #7): pin SQLite 3.53.4 and decide better-sqlite3 13 vs `node:sqlite`; set `synchronous=FULL`; land the pipe DACL fix; land the Job Object runner. The first three are small. None should wait.

---

## What I'd do Monday

Ranked by (risk removed) ÷ (effort):

1. **Fix the pipe DACL** (part #6). It's ~80 lines of koffi and it closes a verified Everyone/Anonymous read on the broker. Nothing else in Phase 0 matters more.
2. **Set `synchronous=FULL` and pin SQLite 3.53.4** (part #4). Hours, not days. Currently NORMAL, and 3.49.2 is inside the corruption window.
3. **Run the walking skeleton** (part #12). One week. De-risks the entire §6 catalog.
4. **Decide Rust-first vs schema-first now** (part #2), before any schema is hand-authored. This decision gets expensive to reverse the moment fixtures exist.
5. **Rewrite §5 and §14 for one transport** (part #1). Deletes a whole workstream from Phase 2.
6. **Add the rotating arbiter and richer work-item specs** (part #10). This is where the measured 25–39pp lives — more than every lease refinement combined.

## What I would not change

§3 truth classes. §11 worktree isolation. §14 injection containment. §16 pre-mortem. Those four are the reason this document is worth building from rather than restarting.

---

## Open questions

1. ~~Does `.agents/mcp_config.json` actually load?~~ **CLOSED 2026-08-14** — verified end-to-end against live `agy.exe`; workspace-local config loads, tool discovered and called. Part #1 gets clean per-lane binding. See §1.
2. Can the agy MCP seam pass a secret on the shim's **stdin**? Decides whether part #6's preferred token channel is available, or whether we fall back to an ACL'd token file inside the worktree. **Still open — and now the highest-value unknown**, because it's the last thing blocking a complete Part #6 fix.
3. `node:sqlite` vs better-sqlite3 13 — needs a real spike against this schema before committing (part #4).

## Explicitly out of scope

**Temporal is rejected** (Operator, 2026-08-14 — previously tried, not returning). The existing `src/temporal/` tree (~5,860 LOC of workflows/activities from the older build-pipeline architecture) is legacy and is not a migration source for this design.

The consequence to own: **§9.5's long-running-operation state machine is the job a durable-execution engine would have done.** Rejecting Temporal means the ledger owns pending→running→terminal CAS, cancellation races, and restart reconciliation of orphaned checks. Parts #3 and #5 are sized for exactly this — single writer, gapless `seq`, replay-from-cursor — so it's a few hundred lines of reducer, not a service. But it must be built deliberately rather than assumed, and §16's "check races" pre-mortem row is the test that proves it.

Note also that §9.3's backfill inventory does not currently mention Temporal-era state at all. If any of it is still live, it needs either a migration entry or an explicit written-off status.

## Sources

**Protocol / providers:** [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) · [SEP-414 request _meta](https://modelcontextprotocol.io/seps/414-request-meta.md) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [rmcp Rust SDK](https://github.com/modelcontextprotocol/rust-sdk) · [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup) · [Antigravity CLI MCP docs](https://antigravity.google/docs/cli/mcp) · [agy issue #60](https://github.com/google-antigravity/antigravity-cli/issues/60) · [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)

**Storage:** [SQLite changelog](https://www.sqlite.org/changes.html) · [SQLite WAL](https://www.sqlite.org/wal.html) · [Tailscale WAL-reset writeup](https://tailscale.com/blog/sqlite-wal-reset-bug) · [Antithesis: Breaking the WAL](https://antithesis.com/blog/2026/wal-reset-bug/) · [node:sqlite](https://nodejs.org/api/sqlite.html) · [sqlite3_rsync](https://sqlite.org/rsync.html) · [Emmett](https://github.com/event-driven-io/emmett) · [Emmett licensing PR #260](https://github.com/event-driven-io/emmett/pull/260) · [LiveStore project state](https://docs.livestore.dev/evaluation/state-of-the-project/) · [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) · [Marten async daemon](https://martendb.io/events/projections/async-daemon.html) · [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)

**Schema:** [schemars](https://github.com/GREsau/schemars) · [Typify](https://github.com/oxidecomputer/typify) · [Typify 2 WIP](https://ahl.dtrace.org/2026/05/10/typify2-wip/) · [Ajv standalone](https://ajv.js.org/standalone.html) · [jsonschema crate](https://docs.rs/jsonschema/latest/jsonschema/) · [RFC 8785 JCS](https://datatracker.ietf.org/doc/html/rfc8785)

**Windows platform:** [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) · [libuv win/pipe.c](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c) · [nodejs/node#55979 AF_UNIX](https://github.com/nodejs/node/issues/55979) · [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) · [nodejs/node#40438 killDeep](https://github.com/nodejs/node/issues/40438) · [koffi](https://koffi.dev/) · [GHSA-j7fq-p9q7-5wfv tree-kill](https://github.com/advisories/GHSA-j7fq-p9q7-5wfv) · [Windows container requirements](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/system-requirements)

**Coordination research:** [MAST — Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657)](https://arxiv.org/abs/2503.13657) · [The Specification Gap (arXiv 2603.24284)](https://arxiv.org/abs/2603.24284) · [Magentic-One (arXiv 2411.04468)](https://arxiv.org/html/2411.04468v1) · [AgentNet (arXiv 2504.00587)](https://arxiv.org/abs/2504.00587) · [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)

**Observability:** [OTel GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) · [GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) · [GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md) · [OTLP file exporter](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/) · [otel-desktop-viewer](https://github.com/CtrlSpice/otel-desktop-viewer) · [Arize Phoenix](https://github.com/Arize-ai/phoenix) · [W3C Trace Context](https://www.w3.org/TR/trace-context/)
