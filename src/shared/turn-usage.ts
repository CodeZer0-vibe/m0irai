/**
 * @file src/shared/turn-usage.ts
 * @purpose The ACP transport's per-turn context-window usage — the shape carried from the adapter's
 *   `usage_update` session notification to the chat lane that renders ctx%. Lives in shared (NOT in the
 *   full 600-line types.ts, and NOT in chat) because an adapter may not import chat: both the ACP adapter
 *   (producer) and the headless chat lane (consumer) depend on it, so it sits under both.
 * @exports TurnUsage, AgentResultWithUsage, ClaudeRateWindow, ClaudeRateWindows
 * @depends ./types
 */
import type { AgentResult } from "./types.js";

/**
 * One claude.ai subscription rate-limit window, captured from either adapter forwarding: the
 * rate_limit_event (`_meta["_claude/rateLimit"]`, dist/acp-agent.js:1791-1794, SDKRateLimitInfo — carries a
 * `status` verdict, utilization only near limits) or the u2d-c patch's /usage plan windows
 * (`_meta["_claude/usageWindows"]` — utilization at ANY usage level, no status: knowledge, not a
 * verdict). Both confirmed against REAL logged turns. `utilization` is USED % 0-100, carried only when
 * the source reports it — never fabricated. `resetsAt` is unix SECONDS (converted at render).
 */
export interface ClaudeRateWindow {
  readonly status?: "allowed" | "allowed_warning" | "rejected";
  readonly utilization?: number;
  readonly resetsAt?: number;
}

/** The per-window accumulation of {@link ClaudeRateWindow}s a session has learned — keys are the SDK's
 *  displayable rateLimitType values. 'overage' (a credit-spend state, not a quota window) is deliberately
 *  not captured. Events arrive ONE window at a time; the session folds them into this map. */
export interface ClaudeRateWindows {
  readonly five_hour?: ClaudeRateWindow;
  readonly seven_day?: ClaudeRateWindow;
  readonly seven_day_opus?: ClaudeRateWindow;
  readonly seven_day_sonnet?: ClaudeRateWindow;
}

/**
 * One turn's context-window usage from @agentclientprotocol/claude-agent-acp's `usage_update` session
 * notification (acp-agent.js:1081-1096): `used` tokens of the model's `size` context window
 * (ctx% = used/size), plus the optional turn `cost`, plus the session's accumulated subscription
 * rate-limit windows when any rate_limit_event has been forwarded (U2d-b). The pty/registry transports do
 * NOT report this — the pty path writes a statusLine payload file the post-turn reader polls instead. The
 * smallest honest surface for carrying ACP usage; the render-ready status shape is derived in the chat layer.
 */
export interface TurnUsage {
  readonly used: number;
  readonly size: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
  readonly rateLimits?: ClaudeRateWindows;
}

/**
 * An {@link AgentResult} that MAY additionally carry the ACP transport's per-turn context usage. Widens the
 * result only for the ACP dispatch chain (adapter → dispatch-acp → dispatch-headless → headless lane) instead
 * of putting an ACP-only field on the shared AgentResult that the pty/registry/Temporal paths never populate.
 * `usage` is absent on the pty/registry path (a plain AgentResult is assignable here — usage is optional).
 */
export type AgentResultWithUsage = AgentResult & { readonly usage?: TurnUsage };
