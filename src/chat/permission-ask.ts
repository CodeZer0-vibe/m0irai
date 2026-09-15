/**
 * @file src/chat/permission-ask.ts
 * @purpose W4-3's async bridge: an ACP requestPermission call happens OUTSIDE React, mid-turn, and must
 *   await an operator keypress that happens LATER, inside React. resolveAsk/invalidatePendingAsk/the
 *   timeout all route through the ONE settleAsk function. W4-B fix round 1 CONCERN 2: resolves with a
 *   PermissionDecision (an offered option, or the protocol's own cancelled envelope) via acp-
 *   permission.ts's shared chooseApproveDecision/chooseDenyDecision — never a fabricated optionId.
 * @exports AskOutcome, OfferedPermissionOption, NormalizedPermissionRequest, normalizePermissionRequest, createOperatorPermissionDecider, resolveAsk, invalidatePendingAsk, resetPermissionAskRegistry
 * @depends ../adapters/acp/acp-permission, ../shared/render-escape, ./events, ./types
 */
import { randomUUID } from "node:crypto";
import {
  type PermissionDecider,
  type PermissionDecision,
  type PermissionRequest,
  chooseApproveDecision,
  chooseDenyDecision,
} from "../adapters/acp/acp-permission.js";
import { escapeUntrusted } from "../shared/render-escape.js";
import type { ChatEventBus } from "./events.js";
import type { AgentName } from "./types.js";

// A human deciding is not a "hung bridge" (the 60s ACP step-timeouts elsewhere in this codebase bound
// THAT failure mode) — this bounds "the operator stepped away and never came back," the FAIL-CLOSED
// timeout case the W4-3 contract names explicitly. Generous on purpose.
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_PERMISSION_OPTIONS = 9;
const MAX_PERMISSION_ID_BYTES = 4096;
const MAX_PERMISSION_LABEL_BYTES = 120;
const MAX_PERMISSION_TITLE_BYTES = 240;

export type AskOutcome = "approved" | "denied" | "timeout" | "invalidated";

interface AskEntry {
  readonly resolve: (decision: PermissionDecision) => void;
  readonly approveDecision: PermissionDecision;
  readonly denyDecision: PermissionDecision;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly bus: ChatEventBus;
  readonly agent: AgentName;
  readonly options: readonly OfferedPermissionOption[];
}

export type OfferedPermissionOption = Readonly<{
  readonly optionId: string;
  readonly kind?: string;
  readonly name?: string;
}>;

export interface NormalizedPermissionRequest {
  readonly options: readonly OfferedPermissionOption[];
  readonly toolCall?: { readonly title?: string | null };
}

const registry = new Map<string, AskEntry>();
function nextAskId(): string {
  return `ask-${randomUUID()}`;
}

// The ONE settlement path for every outcome (operator response, timeout, invalidation): clears the
// timer, removes the entry BEFORE resolving (so a resolve that re-entrantly triggers another settle
// attempt on the same askId is already a safe no-op), resolves the original ACP-side Promise with the
// precomputed optionId, and emits the settled event. Returns false for an unknown/already-settled
// askId (a stale keypress or a double-fire race) — the caller's job, never a throw.
function settleAsk(askId: string, outcome: AskOutcome): boolean {
  const entry = registry.get(askId);
  if (entry === undefined) {
    return false;
  }
  clearTimeout(entry.timer);
  registry.delete(askId);
  entry.resolve(outcome === "approved" ? entry.approveDecision : entry.denyDecision);
  entry.bus.emit({ kind: "permission.ask", agent: entry.agent, askId, phase: "settled", outcome });
  return true;
}

/**
 * Builds a REAL operator-facing PermissionDecider for `agent`, bound to `bus` for the pending/settled
 * `permission.ask` events. Each call the bridge makes registers a new pending ask, computes its
 * approve/deny PermissionDecisions ONCE via acp-permission.ts's shared chooseApproveDecision (this IS the
 * operator choosing to approve — always {kind:"selected"}) / chooseDenyDecision (an offered reject_once/
 * reject_always option, else {kind:"cancelled"} — never a fabricated id, W4-B fix round 1 CONCERN 2),
 * arms the timeout, and returns a Promise that resolves only via settleAsk (resolveAsk, the timeout
 * firing, or invalidatePendingAsk) — never resolved from here directly.
 */
export function createOperatorPermissionDecider(
  agent: AgentName,
  bus: ChatEventBus,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): PermissionDecider {
  return (request) =>
    new Promise<PermissionDecision>((resolve) => {
      const askId = nextAskId();
      const normalized = normalizePermissionRequest(request);
      const approveDecision = chooseApproveDecision(normalized);
      const denyDecision = chooseDenyDecision(normalized);
      const options = normalized.options;
      const timer = setTimeout(() => settleAsk(askId, "timeout"), timeoutMs);
      registry.set(askId, { resolve, approveDecision, denyDecision, timer, bus, agent, options });
      bus.emit({
        kind: "permission.ask",
        agent,
        askId,
        phase: "pending",
        toolTitle: normalized.toolCall?.title ?? "a tool call",
        ...(options.length === 0 ? {} : { options }),
      });
    });
}

/** The keymap's approve ('y')/deny ('n') keypress handler calls this directly (mirrors use-native-mode-
 *  handlers.ts's onCycleMode -> setLaneMode direct-call precedent — no bus round trip needed for THIS
 *  direction). Returns false for a stale/already-settled askId — a harmless no-op, never a throw. */
export function resolveAsk(askId: string, approve: boolean): boolean {
  return settleAsk(askId, approve ? "approved" : "denied");
}

/** Protocol-only exact selector. It accepts only a live provider-offered option ID. */
export function resolveAskOption(askId: string, optionId: string): boolean {
  const entry = registry.get(askId);
  if (entry === undefined || !entry.options.some((option) => option.optionId === optionId))
    return false;
  clearTimeout(entry.timer);
  registry.delete(askId);
  entry.resolve({ kind: "selected", optionId });
  const option = entry.options.find((candidate) => candidate.optionId === optionId);
  entry.bus.emit({
    kind: "permission.ask",
    agent: entry.agent,
    askId,
    phase: "settled",
    optionId,
    outcome: selectedOutcome(option),
  });
  return true;
}

/** Called from lane-transport.ts's sendHeld `finally` block: the ACP prompt() call this ask (if
 *  any) was born during has just settled — an ask still open at that point has, BY DEFINITION, outlived
 *  its turn (a permission ask can only ever be raised WHILE a prompt() call is in flight), so it is
 *  force-denied here rather than left to the timeout. Keyed by `agent` alone (never a turn number — see
 *  events.ts's PermissionAskEvent comment) since at most one ask can be open per agent at a time (the
 *  ACP protocol serializes tool calls within a single prompt turn). Returns false when there was nothing
 *  pending for this agent — the ordinary case for the vast majority of prompt() calls. */
export function invalidatePendingAsk(agent: AgentName): boolean {
  for (const [askId, entry] of registry) {
    if (entry.agent === agent) {
      return settleAsk(askId, "invalidated");
    }
  }
  return false;
}

/** Process-owner reset: clears every pending timer when the room carrier is replaced or shut down. */
export function resetPermissionAskRegistry(): void {
  for (const entry of registry.values()) {
    clearTimeout(entry.timer);
  }
  registry.clear();
}

function selectedOutcome(option: OfferedPermissionOption | undefined): AskOutcome {
  if (option?.kind?.startsWith("allow") === true) return "approved";
  if (option?.kind?.startsWith("reject") === true || option?.kind?.startsWith("deny") === true)
    return "denied";
  return "denied";
}

export function normalizePermissionRequest(
  request: PermissionRequest,
): NormalizedPermissionRequest {
  const options: OfferedPermissionOption[] = [];
  const seen = new Set<string>();
  for (const option of request.options ?? []) {
    if (options.length >= MAX_PERMISSION_OPTIONS) break;
    const normalized = normalizePermissionOption(option);
    if (normalized === undefined || seen.has(normalized.optionId)) continue;
    seen.add(normalized.optionId);
    options.push(normalized);
  }
  const title = request.toolCall?.title;
  return {
    options,
    ...(typeof title === "string" && title.length > 0
      ? { toolCall: { title: safeProviderText(title, MAX_PERMISSION_TITLE_BYTES) } }
      : {}),
  };
}

function normalizePermissionOption(
  option: NonNullable<PermissionRequest["options"]>[number],
): OfferedPermissionOption | undefined {
  if (!validOpaqueId(option.optionId)) return undefined;
  if (!validOptionalLabel(option.kind) || !validOptionalLabel(option.name)) return undefined;
  return {
    optionId: option.optionId,
    ...(option.kind === undefined
      ? {}
      : { kind: safeProviderText(option.kind, MAX_PERMISSION_LABEL_BYTES) }),
    ...(option.name === undefined
      ? {}
      : { name: safeProviderText(option.name, MAX_PERMISSION_LABEL_BYTES) }),
  };
}

function validOpaqueId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PERMISSION_ID_BYTES
  );
}

function validOptionalLabel(value: string | undefined): boolean {
  return (
    value === undefined ||
    (value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_PERMISSION_LABEL_BYTES)
  );
}

function safeProviderText(value: string, maxBytes: number): string {
  const escaped = escapeUntrusted(value, { maxLen: maxBytes });
  const characters: string[] = [];
  let bytes = 0;
  for (const character of escaped) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes) break;
    characters.push(character);
    bytes += next;
  }
  return characters.join("");
}
