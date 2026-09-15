**Root Cause**
The meters vanished because MT7 carrier turns bypass the usage-status emitters. The renderer is behaving as designed: [usage-bar.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/tui/usage-bar.ts:114>) only renders reported metrics, hides stale quota windows, and [status-bar.tsx](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/tui/status-bar.tsx:223>) renders no meter when `status.usage` is absent.

The break is in [headless-carrier.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/headless-carrier.ts:264>): carrier usage capture defaults to `() => Promise.resolve()`. The older non-carrier path defaults to `defaultCaptureUsage` in [headless-turn.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/headless-turn.ts:408>) and emits Claude ACP usage in [headless-turn.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/headless-turn.ts:390>).

Per agent:

| Agent | Root cause | Evidence |
| --- | --- | --- |
| claude | ACP carrier parses `usage_update` only for compaction detection, not `agent.status`; post-lane capture is no-op. | [headless-carrier.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/headless-carrier.ts:123>) calls `usageFromUpdate`, then only `detector.onCtxPercent`. Live `#ac24`: 5 `dispatch.started`, 5 `dispatch.completed`, 6 resume traces, 0 `agent.status`. |
| codex | Same carrier gap. The old rollout scanner exists, but carrier never calls the default capture. ACP usage, if present, is only consumed for detector ctx%. | [codex-rate-limits.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/codex-rate-limits.ts:229>) emits codex status only when invoked; carrier does not invoke it. TeamWork `lane_sessions` shows codex on `@agentclientprotocol/codex-acp` `1.1.2`. |
| gemini | agy statusline payload is fresh and valid, but carrier never reads it because default capture is no-op. | `%TEMP%\zer0-statusline\agy.json` had TeamWork cwd, session `293e1d52...`, ctx `4.62%`, `gemini-5h` and `gemini-weekly`; parser expects those fields in [agy-statusline-payload.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/agy-statusline-payload.ts:100>). |

Live artifact evidence:  
`TeamWork\.zer0\debug\chat-1784100895962-...ac24\trace.ndjson` has dispatch/resume/delta/completed lines, but 0 `agent.status`. Same for `chat-1784095748428-...6261`. The trace sink subscribes to `agent.status`, so if the event were emitted it would be present: [chat-trace.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/chat-trace.ts:27>).

**When It Broke**
Not June 28 ACP alone. `.council/findings.md` records U2dc as operator-confirmed live: “bar shows claude ctx+5h like codex/agy.” The supported break window is July 10, when MT7 native resume became default-on and council was moved onto carrier lanes. Evidence: [memory-flags.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/memory/memory-flags.ts:37>) says native resume defaults ON since July 10, and [controller-council.ts](</C:/Users/mianc/VibeCoding/zer0-agent-ci/src/chat/controller-council.ts:65>) now runs council as `laneClass: "chat"`, which enables carrier use.

**Fix Design**
Put usage reporting inside the carrier path, not as an afterthought in the legacy headless path.

1. Add a single usage reporter used by both `headless-turn` and `headless-carrier`.
2. For Claude/Codex ACP carrier updates, normalize every `usage_update` from `usageFromUpdate` into `agent.status`.
   - Claude uses `acpUsageToStatus(foldClaudeWindows(...))`.
   - Codex should at least emit ACP ctx%; quota should come from ACP metadata if available, otherwise keep the rollout scanner as a post-turn fallback.
3. For Gemini carrier turns, after `runAgyCarrierTurn`, read `readAgyStatusUsageWhenFresh(...)`, but reject stale/global payloads unless cwd/session matches the carrier lane.
4. Remove the carrier no-op default. Missing capture should be explicit and traced, never silent.
5. Add one debug event per agent per turn, for example:
   `{"kind":"usage.payload","agent":"gemini","turn":2,"source":"agy_statusline","outcome":"arrived","fields":["ctx","5h","weekly"]}`
   Also emit `outcome:"missing"|"stale"|"malformed"` after timeout. Then `rg '"kind":"usage.payload"' .zer0/debug/**/trace.ndjson` settles this in one grep.

**Blast Radius**
Main touch points: `src/chat/headless-carrier.ts`, `src/chat/headless-turn.ts`, ACP usage normalization, agy statusline freshness checks, `events.ts` / `event-schemas.ts` / `chat-trace.ts`, and tests around `headless-carrier`.

Ranked falsifiers:

1. Run carrier off: `ZER0_MEMORY=1 ZER0_NATIVE_RESUME=0 ZER0_DEBUG=1 zer0 chat`; if meters return, carrier bypass is confirmed.
2. Add a temporary carrier update trace; if Claude/Codex emit no `usage_update`, adapter wiring also needs repair.
3. Fake ACP carrier test emits `usage_update`; currently should fail to produce `agent.status`.
4. Fresh agy payload test under carrier; currently should fail to produce `agent.status`.
5. Codex quota proof: verify whether codex-acp emits quota metadata or whether rollout scanning still maps to the carried codex lane.

No repo writes were made. Verification was read-only: source inspection, TeamWork debug traces, TeamWork evidence DB, and live agy statusline payload. I did not run tests because this was a root-cause audit, not a patch.

