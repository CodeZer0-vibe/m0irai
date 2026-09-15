<!-- M2 research (documents only — operator rule 2026-08-18). Produced by a researcher agent 2026-08-19;
     topic T6 of the M2 research brief; sources opened directly by the agent (curl), quotes verified by it.
     No code change before checkpoint 2. -->

# T6 — stdio-rpc-transport-failure (FL-035, FL-047)

## 1. The problem as it exists in this repo

The room host talks JSON-RPC to its parent over stdin/stdout, one line per message. Two related gaps sit in that stdio plumbing. First: when a write to stdout fails (the classic case is the parent process closing its end of the pipe), the host stops accepting new lines but does not stop the input loop itself — it just sits there refusing to answer until the parent also closes stdin. `handleLine` guards on the failure (`if (this.stopping || this.writer.failed() !== undefined) return;`, `src/room/zer0-v2-host.ts:118`), but `consumeRpcStdin`'s `for await (const chunk of stdin)` loop (`src/room/zer0-v2-request-scheduler.ts:78-90`) only exits when `server.isStopping()` is true (checked at `zer0-v2-request-scheduler.ts:106`) — and a writer failure alone never sets `stopping`. So the process can be fully deaf (can't answer anything) while still technically alive and holding a room attached, until EOF arrives. This is FL-035. Second: when the host does shut down explicitly (`zer0/room/shutdown`), any request still in flight at that moment gets its result computed but its response is silently dropped — `if (!this.stopping) await this.writer.write(entry.response);` (`zer0-v2-host.ts:218`) — with no error sent back either. FINDINGS records this as a deliberate design choice, not a bug (FL-047, "response suppression after `stopping` is deliberate").

## 2. Prior art

**LSP (Language Server Protocol) 3.17, the spec used by rust-analyzer, gopls, pyright, clangd, tsserver, etc.** Defines a two-step shutdown (`shutdown` request, then `exit` notification) precisely so "the response might not be delivered correctly" isn't a problem, and separately makes the server responsible for noticing its parent died: "The process Id of the parent process that started the server... If the parent process is not alive then the server should exit (see exit notification) its process." Quote source: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ (Shutdown Request / Exit Notification, and `InitializeParams.processId`). Evidence class: published normative standard, adopted by a large, mature ecosystem. Label: verified (read the raw spec page directly).

**vscode-jsonrpc**, Microsoft's own JSON-RPC-over-stream library, shipped inside VS Code and used as the reference transport for the whole LSP/DAP world. It wires BOTH the reader's and the writer's close/error callbacks into one connection state machine, and on dispose it actively rejects every pending in-flight response rather than dropping it: `messageWriter.onClose(closeHandler); messageWriter.onError(writeErrorHandler);` and `dispose: () => { state = ConnectionState.Disposed; ...const error = new ResponseError(ErrorCodes.PendingResponseRejected, 'Pending response rejected since connection got disposed'); for (const promise of responsePromises.values()) { promise.reject(error); }`. Source: https://raw.githubusercontent.com/microsoft/vscode-languageserver-node/main/jsonrpc/src/common/connection.ts, lines 678-679 and 1539-1549. Evidence class: production library. Label: verified.

**ACP (Agent Client Protocol)**, Zed's agent-over-stdio protocol — structurally the closest sibling to this host (it IS an agent-over-JSON-RPC-over-stdio design). Its transport diagram makes shutdown client-owned: "Client->>Agent Process: Close stdin, terminate subprocess" (https://agentclientprotocol.com/protocol/v1/transports). More directly on point: ACP's `$/cancel_request` handling is a hard MUST — a receiver "MUST send one of these responses for the original request: Valid response with appropriate data (partial results or cancellation marker) [or] Error response with code `-32800` (Cancelled)" — silently dropping the response is not an allowed option. And its `session/close` method requires the agent to "cancel any ongoing work for that session as if `session/cancel` had been called, then free the resources" before it's considered closed. Source: https://agentclientprotocol.com/protocol/v1/schema (verified directly via curl, confirmed in the aggregated docs export). Evidence class: published normative spec, backed by a real shipping ecosystem (Zed + SDKs), newer and less battle-tested than LSP. Label: verified.

**Node.js core docs** — the substrate underneath our own `JsonRpcWriter`. A Writable's `'error'` event is documented as terminal: "The stream is closed when the 'error' event is emitted... After 'error', no further events other than 'close' should be emitted." (https://nodejs.org/api/stream.html, Writable Event: 'error'). Separately, stdout write behavior differs by platform: "Pipes (and sockets): synchronous on Windows, asynchronous on POSIX" (https://nodejs.org/api/process.html, "A note on process I/O"). Evidence class: primary vendor docs. Label: verified.

## 3. Options for M2

**Option A — writer failure actively latches shutdown.** On the first write failure, immediately flip `stopping` and make the stdin-consuming loop react to it instead of only checking it between already-arrived lines. Smallest diff (touches `zer0-v2-host.ts` + `zer0-v2-request-scheduler.ts`), zero new dependencies, no Windows-specific code. The real cost: `for await (const chunk of stdin)` blocks on the next chunk, so a flag alone doesn't wake it up — this needs an explicit race between "next stdin chunk" and "writer just failed," or the fix is cosmetic and FL-035 stays open in practice.

**Option B — self-terminate on parent death (LSP-style).** Pass the Rust parent's PID at spawn and have the host verify it's alive. This solves a different problem than FL-035 states (an orphaned-but-writer-healthy host), and the repo's own comment (`zer0-v2-host.ts:106-107`) notes a child here already dies with the parent's Windows job object — so this mostly duplicates protection that already exists on this platform. Worth naming, not worth building for M2.

**Option C — answer-or-cancel every in-flight request at shutdown (ACP-style).** Instead of silently dropping the response at `zer0-v2-host.ts:218` when `stopping` is already true, send an explicit "shutting down" JSON-RPC error for anything still in flight. Closes FL-047 directly. Moderate blast radius (touches `executeRequest`'s suppression branch and the `RoomRequestScheduler`/`inFlight` bookkeeping that assumes a suppressed write is fine); needs a decision about whether subprocess-backed reads (e.g. model discovery) can be cancelled cheaply or must be awaited before answering.

## 4. Recommendation

Do A and C together as one change: route both triggers (an explicit `zer0/room/shutdown` and a writer failure) through a single `beginStopping(reason)` path that (1) latches `stopping` and races the stdin loop against that latch instead of waiting for the next chunk or EOF, and (2) answers every request still in `inFlight` with an explicit error before the process exits — matching the MUST-answer discipline ACP defines for `$/cancel_request` and `session/close`, rather than the current silent-drop. Falsifier: a test that starts a slow in-flight request (e.g., a stalled model-listing read), then forces the writer's underlying stream to emit `'error'` before that request resolves, and asserts (a) the stdin loop stops consuming within the same tick — not waiting on the next chunk or EOF — and (b) the slow request's caller receives an explicit error rather than nothing. If either assertion fails, the fix isn't real.

## 5. What could not be verified

- Node's docs never use the literal string "EPIPE" on the pages read: `grep -c "EPIPE"` → 0 in both. The 'error'-then-'close' ordering is documented; the specific POSIX errno is not named on either page.
- ACP has no method literally named "session/shutdown" as the brief's phrasing assumed: `grep -n "session/shutdown"` across the full docs export returned no matches (exit code 1). What exists is `session/close` (per-session, not per-process) plus transport-level process termination (client closes stdin / kills the subprocess) — reported above as what's actually there.
- No ACP text addresses "the agent's own stdout pipe breaks while the client is still alive," the exact FL-035 scenario: `grep -n -i "epipe\|broken pipe"` across the docs export returned no matches. ACP's transport diagram only documents the client-initiated close.

## 6. Sources

- https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- https://raw.githubusercontent.com/microsoft/vscode-languageserver-node/main/jsonrpc/src/common/connection.ts
- https://raw.githubusercontent.com/Microsoft/vscode-languageserver-node/main/README.md
- https://agentclientprotocol.com/protocol/v1/transports
- https://agentclientprotocol.com/protocol/v1/schema (and its raw .md form)
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/README.md
- https://nodejs.org/api/stream.html
- https://nodejs.org/api/process.html
- In-repo: src/room/zer0-v2-host.ts, src/room/zer0-v2-request-scheduler.ts, src/room/zer0-v2-rpc.ts, src/room/attached-session-lifecycle.ts, src/room/room-host.ts, src/room/zer0-v2-host.test.ts, docs/FINDINGS.md (FL-035, FL-047)
