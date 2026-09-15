/**
 * @file src/room/room-host-permissions.ts
 * @purpose The room's carrier permission decision, extracted verbatim from AliveRoomHost so the host
 *   file stays under its hard clamp (FL-034: the next change to room-host.ts must extract, never raise).
 *   An OPERATOR lane delegates to its interactive decider; every other lane fails closed and publishes
 *   the pending/settled ask pair so a denial the operator never saw is still on the wire.
 * @exports decideRoomPermission, roomPermissionDeciderFactory
 * @depends node:crypto, ../adapters/acp/acp-permission, ../chat/permission-ask, ../chat/types, ./room-host-support
 */
import { randomUUID } from "node:crypto";
import {
  type PermissionDecider,
  type PermissionDecision,
  type PermissionRequest,
  chooseDenyDecision,
} from "../adapters/acp/acp-permission.js";
import { normalizePermissionRequest } from "../chat/permission-ask.js";
import type { AgentName } from "../chat/types.js";
import type { ActivePermissionContext } from "./room-host-support.js";

/** Decides one carrier permission request for `agent`, using the lane context the host has open for it
 *  (absent when no lane is running — the decision is still made and still fails closed, it just has no
 *  bus to announce itself on). Moved out of AliveRoomHost unchanged; `context` is the single value the
 *  method previously read off `this`. */
export function decideRoomPermission(
  agent: "claude" | "codex",
  request: PermissionRequest,
  context: ActivePermissionContext | undefined,
): Promise<PermissionDecision> {
  if (context?.lane.origin === "operator" && context.decider !== undefined)
    return context.decider(request);
  const normalized = normalizePermissionRequest(request);
  const decision = chooseDenyDecision(normalized);
  if (context !== undefined) {
    const askId = `room-denied-${randomUUID()}`;
    const optionId = decision.kind === "selected" ? decision.optionId : undefined;
    context.bus.emit({
      kind: "permission.ask",
      agent,
      askId,
      phase: "pending",
      toolTitle: normalized.toolCall?.title ?? "a tool call",
      ...(normalized.options.length === 0 ? {} : { options: normalized.options }),
    });
    context.bus.emit({
      kind: "permission.ask",
      agent,
      askId,
      phase: "settled",
      outcome: "denied",
      ...(optionId === undefined ? {} : { optionId }),
    });
  }
  return Promise.resolve(decision);
}

/** The factory setCarrierDecider wants: the OUTER arrow runs once per lane open, the INNER one per
 *  request — so the context map is read at REQUEST time, exactly as the host method it replaced did.
 *  Lives here rather than inline at the call site because AliveRoomHost.create sits one line under its
 *  50-line function clamp, and this is permission wiring rather than lifecycle. */
export function roomPermissionDeciderFactory(
  contexts: ReadonlyMap<AgentName, ActivePermissionContext>,
): (agent: "claude" | "codex") => PermissionDecider {
  return (agent) => (request) => decideRoomPermission(agent, request, contexts.get(agent));
}
