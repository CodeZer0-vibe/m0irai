/**
 * @file src/adapters/acp/acp-permission.ts
 * @purpose The ACP permission decision seam. autoApproveDecider matches headless bypassPermissions (no
 *   live operator). denyDecider is the interactive lane's FAIL-CLOSED default (W4-3 referee's trap).
 *   W4-B fix round 1 CONCERN 2: a decision is EITHER an offered option or the protocol's own not-
 *   approved {kind:"cancelled"} envelope (schema.json's RequestPermissionOutcome) — never a fabricated
 *   optionId the bridge never offered.
 * @exports PermissionRequest, PermissionOption, PermissionDecision, PermissionDecider, pickOptionByKind, chooseApproveDecision, chooseDenyDecision, autoApproveDecider, denyDecider
 * @depends (none)
 */

/** One option the ACP host may select for a permission ask — verified against the SDK's real wire schema
 *  (@agentclientprotocol/sdk/schema/schema.json's PermissionOption: optionId + a human name + a kind hint
 *  such as allow_once/allow_always/reject_once/reject_always). `name` is optional here (some callers, e.g.
 *  existing tests, construct options without it) — a missing name degrades to a raw optionId label, never a
 *  blank one (the ask-line's own concern, not this file's). */
export interface PermissionOption {
  readonly optionId?: string;
  readonly kind?: string;
  readonly name?: string;
}

/** One ACP permission ask. `toolCall` carries the SDK's ToolCallUpdate title (schema.json) — the human-
 *  readable label of what's being asked about; `null`/absent degrades to a generic label at the render
 *  layer, never a crash. */
export interface PermissionRequest {
  readonly options?: readonly PermissionOption[];
  readonly toolCall?: { readonly title?: string | null };
}

/** W4-B fix round 1 CONCERN 2: a decider's decision — EITHER a concrete OFFERED option was selected, OR
 *  none was, and the caller must respond with the protocol's own not-approved shape
 *  (RequestPermissionOutcome's "cancelled" branch, schema.json) rather than a fabricated optionId. */
export type PermissionDecision =
  | { readonly kind: "selected"; readonly optionId: string }
  | { readonly kind: "cancelled" };

/** Decides which permission option to take for a request; resolves to the PermissionDecision. */
export type PermissionDecider = (request: PermissionRequest) => Promise<PermissionDecision>;

/** Finds the first option whose `kind` matches `pattern` (case-insensitive substring, e.g. /allow/i) —
 *  used by chooseApproveDecision's permissive ladder, where "some allow-shaped option" is an acceptable
 *  match (approving always selects SOMETHING; there is no "cancelled" concept on the approve path). */
export function pickOptionByKind(
  options: readonly PermissionOption[] | undefined,
  pattern: RegExp,
): string | undefined {
  return options?.find((option) => pattern.test(option.kind ?? ""))?.optionId;
}

/** Finds an option whose `kind` is EXACTLY `kind` (case-sensitive equality — ACP's PermissionOptionKind
 *  enum values are fixed lowercase_snake_case constants, schema.json) — used by chooseDenyDecision's
 *  ORDERED preference ladder, where a loose substring match could false-positive against an unrelated
 *  future kind string (e.g. a hypothetical "reject_once_extended") and defeat fail-closed's own intent. */
function pickOptionByExactKind(
  options: readonly PermissionOption[] | undefined,
  kind: string,
): string | undefined {
  return options?.find((option) => option.kind === kind)?.optionId;
}

/** The approve-path decision: the first "allow"-kind option, else the first offered option, else the
 *  protocol's {kind:"cancelled"} envelope. Shared by autoApproveDecider and permission-ask.ts's operator
 *  decider so the approve ladder can never drift between the two callers. */
export function chooseApproveDecision(request: PermissionRequest): PermissionDecision {
  const optionId = pickOptionByKind(request.options, /allow/i) ?? request.options?.[0]?.optionId;
  return optionId === undefined ? { kind: "cancelled" } : { kind: "selected", optionId };
}

/** The deny-path decision (W4-B fix round 1 CONCERN 2): tries the OFFERED reject_once option, else the
 *  OFFERED reject_always option — an EXACT-kind, ORDERED preference, never a substring match and never a
 *  fallback to "the first option" (an unrecognized shape could otherwise land on an allow-kind option and
 *  defeat fail-closed). When NEITHER is offered (e.g. an allow-only options list), returns the protocol's
 *  own {kind:"cancelled"} envelope rather than fabricating an id the bridge never offered. Shared by
 *  denyDecider and permission-ask.ts's operator decider so the deny ladder can never drift between them. */
export function chooseDenyDecision(request: PermissionRequest): PermissionDecision {
  const optionId =
    pickOptionByExactKind(request.options, "reject_once") ??
    pickOptionByExactKind(request.options, "reject_always");
  return optionId !== undefined ? { kind: "selected", optionId } : { kind: "cancelled" };
}

/**
 * The default decider: AUTO-APPROVE (chooseApproveDecision). Matches headless bypassPermissions — the
 * ONLY legitimate use is a context with no live operator to ask (dispatch-acp.ts's headless turns).
 * NEVER the default for the interactive lane path; see denyDecider.
 */
export const autoApproveDecider: PermissionDecider = (request) =>
  Promise.resolve(chooseApproveDecision(request));

/**
 * The FAIL-CLOSED default (chooseDenyDecision): an offered reject_once/reject_always option, else the
 * protocol's {kind:"cancelled"} envelope — never a fabricated id. acp-lane-connection.ts's resolveDecider
 * uses this when no operator decider was wired in — the referee's named trap (an ask-capable interactive
 * lane silently reaching auto-approve) is structurally impossible once this is the ONLY fallback reached.
 */
export const denyDecider: PermissionDecider = (request) =>
  Promise.resolve(chooseDenyDecision(request));
