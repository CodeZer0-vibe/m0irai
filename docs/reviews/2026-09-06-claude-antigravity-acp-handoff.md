# Claude handoff: Antigravity ACP with subscription authentication

Date: 2026-09-06

Status: Research verified; m0irai compatibility UNVERIFIED. No ACP server was installed or executed, no authentication settings were changed, and no product code was modified for this investigation.

## Outcome and next action

Evaluate replacing m0irai's Antigravity `agy` PTY transport with Google's separately distributed Antigravity ACP server. Preserve the operator's existing subscription-based usage, account ownership, permissions, room history, and memory continuity.

The recommended next step is a bounded compatibility probe before a production migration. Follow the operator's current instruction for execution authority; this document records evidence and acceptance requirements and is not a claim that implementation or live testing has already been approved or completed.

This supplements the [CTO audit](2026-09-06-astra-cto-audit.md) and [remediation handoff](2026-09-06-claude-remediation-handoff.md). It corrects the old assumption that Antigravity has no ACP integration. It does not close any of the audit's eight findings.

## Verified external evidence

The following primary sources were opened on 2026-09-06. Recheck the live manifest before choosing a version for implementation.

| Evidence | Observed fact | Source |
| --- | --- | --- |
| Official ACP registry manifest | Agent ID `antigravity-acp`, name Google Antigravity, author Google LLC, version `1.1.1`, license marked proprietary. | [Registry manifest](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) |
| Binary distribution | Windows x86_64 and ARM64 entries both launch `./agy_acp_server.exe`; archives are hosted on `dl.google.com`. macOS ARM64 and Linux x86_64/ARM64 entries use `agy_acp_server.par`; Linux entries include `--uid=`. | [Raw manifest](https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json) |
| Zed integration | Zed lists Google Antigravity as an ACP agent installed through the registry. | [Zed listing](https://zed.dev/acp/agent/antigravity-acp) |
| Google installation guidance | Google's Zed guide directs users to install Antigravity from the external-agent registry. | [Google Zed guide](https://antigravity.google/docs/ide/extensions/zed) |
| Subscription authentication | The Google Zed guide documents `oauth-personal` for individual Free, Pro, and Ultra plans. API-key authentication is a separate documented choice. | [Google Zed authentication](https://antigravity.google/docs/ide/extensions/zed#authentication--licensing) |
| Account entitlements | Google describes unified authentication across IDE extensions, CLI, and desktop. The signed-in account determines model entitlements, credits, and limits. | [Google authentication overview](https://antigravity.google/docs/ide/extensions#authentication--licensing) |
| Existing CLI sign-in | The CLI attempts local OS keyring authentication, including Windows Credential Manager, then offers browser sign-in if no saved session is found. This documents CLI behavior, not proof that the ACP binary reuses the identical saved token. | [CLI installation and auth](https://antigravity.google/docs/cli/install/) |

The registry confirms a separate downloadable server artifact. Merely updating the interactive `agy` CLI is not evidence that this server is installed. Use the Google-owned distribution in the manifest; do not substitute a similarly named community/npm adapter without verifying its identity.

## Subscription requirements: preserve these throughout the migration

1. Use the operator's existing Google account and personal subscription authentication. Google's documented configuration expresses this as `auth.type = "oauth-personal"`. Discover the actual server authentication contract; do not assume that this configuration value is an ACP `authenticate` method ID or invent a configuration-file path.
2. Preserve m0irai's subscription-first child environment. Do not forward provider API keys or fall back to Gemini API-key authentication when subscription login fails.
3. Keep authentication provider-owned. m0irai must not collect account passwords, copy OAuth tokens, maintain its own login service, or log credentials. If another Google sign-in is needed, use the provider's supported flow.
4. Confirm the active authentication mode and entitled model access through supported provider surfaces before switching the production lane. Do not infer subscription authentication merely because one model response succeeds.
5. Treat the existing plan's credits and limits as applicable. ACP is not evidence of an additional quota allocation, identical per-model availability, or unlimited usage.
6. Leave the working CLI installation and account settings intact while evaluating the server. Do not run logout, clear credential stores, or rewrite global authentication settings as a diagnostic shortcut.

**What can be promised now:** Google documents a subscription-compatible ACP path. **What cannot be promised yet:** automatic reuse of this machine's current login, complete feature parity, or a migration that cannot regress behavior. Those need local evidence.

## Current repository fit

Source snapshot: branch `overnight/2026-08-21`, HEAD `dc6b721b87eba82b2aea09d85bcee8aedc618c56`. Re-establish the current branch, dirty state, and worktrees before implementation; this snapshot will age.

| Current surface | Observation and migration implication |
| --- | --- |
| [ACP server definitions](../../src/adapters/acp/acp-servers.ts#L19) | `AcpAgent` currently includes only Claude and Codex. The comment that Gemini has no ACP is now stale. Server resolution and adapter identity currently depend on npm package manifests. A native binary needs explicit executable resolution and a reliable identity/version binding. |
| [ACP subprocess launcher](../../src/adapters/acp/acp-turn-session.ts#L336) | `spawnServer` runs `process.execPath` with `spec.entry`. A Windows `.exe` cannot simply be substituted as that Node entry. Preserve command/argument separation, hermetic refusal, bounded lifecycle, and the shared child environment when adding binary support. |
| [Persistent ACP connection](../../src/adapters/acp/acp-lane-connection.ts#L149) | Existing wiring has initialization, session creation, `resumeSession`, modes, and models. Compatibility must follow the new server's advertised methods; an ACP listing alone does not prove support for these exact calls. |
| [Room carrier routing](../../src/chat/headless-carrier.ts#L128) | The Gemini branch currently uses `dispatchAgyCarrier`; ACP helpers narrow agents to Claude/Codex. Provider transport and capability selection require changes beyond a configuration entry. |
| [Adapter registry](../../src/adapters/registry.ts#L57) | Gemini also maps to `dispatchAgy` here. Inventory all production callers so migration does not leave split transport ownership. |
| [Shared child environment](../../src/shared/child-env.ts#L3) | Subscription-first environment filtering already has a shared owner. Reuse it rather than creating a second allowlist or inheriting the entire process environment. |
| [Current PTY spawn](../../src/adapters/pty/agy-pty-spawn.ts#L33) | agy already consumes the shared filtered environment; its [tests](../../src/adapters/pty/agy-pty-spawn.test.ts#L23) explicitly reject provider API keys. Preserve this invariant for ACP. |
| [agy carrier continuity](../../src/chat/agy-carrier.ts) | This owns more than text extraction: conversation identity, acceptance, and memory cursor behavior. Map the existing contract before replacing it with ACP session identity. |

Read current `AGENTS.md`, `docs/STATE.md`, `docs/HANDOFF-m0irai.md`, and the relevant source before editing. STATE records an unmerged `ag-agy-transcript` candidate at `9352853`; verify its actual current state and coordinate overlapping continuity/cancellation work. Do not overwrite or duplicate another lane's work.

## Bounded compatibility probe

Run a live provider probe only within the operator's authorized scope; it may use subscription credits and open Google's sign-in flow. Use a disposable workspace and bounded timeouts. Retain sanitized results, not credentials or full private transcripts.

1. Resolve the correct Windows architecture and acquire the official server separately from the existing CLI. Record the manifest version, source URL, and downloaded artifact hash. A locally computed hash records identity; it is not independent publisher verification. Confirm acquisition/redistribution terms before any packaging decision.
2. Launch the executable directly over stdio using m0irai's filtered environment. Confirm ACP framing, protocol negotiation, authentication requirements, and capabilities. Capture actionable stderr separately from protocol stdout.
3. Establish personal subscription authentication with the same account. Determine whether the existing sign-in is reused or another provider login is required. Never switch authentication providers to make the probe pass.
4. Create a session and send one small prompt. Confirm streamed text, terminal outcome, tool updates when exercised, and correct workspace scope.
5. Exercise a permission request in the disposable workspace. Verify that rejection prevents the action and that any approval remains specific to what was offered. An absent permission handler must not silently approve.
6. Cancel an active turn, including a turn with no visible text yet. Confirm the provider settles, no child process is orphaned, and cancellation is not misreported as successful completion or generic empty-output failure.
7. Test a second turn and continuation after server process restart. Record the exact supported continuation method and response. Do not assume `resumeSession`, `session/load`, and new-session replay are interchangeable.
8. Discover available models/modes and exercise selection if supported. Verify the semantics of the selected mode, especially the existing read-only boundary; mode labels alone are insufficient proof.
9. Check what usage information is actually returned. Keep context usage distinct from subscription limits, and mark absent quota information as unavailable rather than inventing a zero or additional allowance.

Return a capability matrix with PASS, FAIL, or UNVERIFIED for each item, the tested binary version, and sanitized evidence. A successful handshake proves only connectivity.

## Migration shape if the probe establishes compatibility

- Extend the existing ACP machinery for native executable command/args and artifact identity, keeping provider-specific authentication and capability differences explicit. Do not build a second generic ACP client without a demonstrated need.
- Preserve the existing `gemini` room identity and explicit operator routing. Changing transport does not authorize renaming agents, changing defaults, or redirecting Claude/Codex requests.
- Inventory all Gemini consumers: carrier dispatch, adapter registry, eager startup, readiness checks, models/modes, usage reporting, version binding, cancellation, memory, and packaging. Use current references to establish scope.
- Define the persisted-session transition. Do not feed an old agy conversation ID to ACP and assume compatibility. Preserve existing room transcripts and memory; determine whether native history can be resumed, and surface any intentional new native session explicitly.
- Preserve acceptance and cursor ordering so failed/cancelled submissions cannot silently advance memory state or lose accepted work. Cover restart, expired/invalid session, and provider-version changes.
- Make unsupported required capabilities visible. If the server cannot preserve subscription use, permission enforcement, or required continuity, report that gap before production cutover. Do not conceal it with an automatic API-key or PTY fallback.
- Keep the working transport available during the isolated evaluation. Once an authorized cutover is proven, remove obsolete callers and parsing paths within the accepted scope rather than retaining two accidental runtime owners.
- Correct stale ACP assumptions in the owning documentation/source as part of an authorized migration. Generated root instruction files must be regenerated from `docs/agents/` if their source changes.

## Acceptance and evidence required before calling the migration complete

| Area | Required proof |
| --- | --- |
| Subscription | Personal OAuth with the intended account is confirmed through supported surfaces; no provider API keys reach the child; failure does not change authentication mode. |
| Authentication usability | Existing-login reuse or the supported sign-in requirement is documented and exercised; unauthenticated state produces a clear, actionable result. |
| Permissions and workspace | Deny/approve flows, missing handler, intended working directory, and the existing read-only boundary are exercised. |
| Conversation continuity | Multiple turns, process restart, invalid/expired session, and old agy room history have explicit, tested behavior. |
| Cancellation and lifecycle | Empty and partially streamed cancellation, crash, timeout, shutdown, and cleanup preserve truthful room outcomes. |
| Memory and persistence | Acceptance, cursor advancement, durable transcript replay, and failure paths preserve their existing contracts. |
| Models and usage | Discovery/selection uses supported capabilities; absent usage data is represented honestly; subscription quota is not conflated with context consumption. |
| Adjacent providers | Claude and Codex retain their existing account authentication, launch behavior, routing, and session behavior. |
| Packaging and hermetic proof | The staged application locates the intended server or reports its absence clearly; hermetic gates still refuse real provider startup. |

Add focused tests that can catch the migration's failure modes, then run the repository's required static, integration, and full verification for the changed surface. Existing mock tests cannot establish Google's live authentication or model entitlements. Keep live-provider evidence separate from hermetic gate receipts.

Obtain the applicable independent correctness and risk review for material authentication, subprocess, and persistence changes. Follow the repo's exact staged-tree receipt procedure only when staging/committing is authorized. Do not stage, commit, push, or deploy because an old handoff contains such instructions.

## Evidence limits and delivery

This handoff is based on the primary sources above and read-only inspection of current routing, subprocess, session, and environment code. No live ACP handshake, sign-in, prompt, permission interaction, quota measurement, session migration, or packaged runtime test was performed. No product tests were run for this Markdown-only addition.

When returning the implementation or probe, report: actual changed files, exact commands and outcomes, capability matrix, subscription-authentication evidence without account secrets, remaining gaps, and whether production routing changed. Mark anything not exercised UNVERIFIED.

The core correction is durable: verify the separately distributed official server before concluding that the interactive CLI's missing ACP switch means the provider has no ACP support.
