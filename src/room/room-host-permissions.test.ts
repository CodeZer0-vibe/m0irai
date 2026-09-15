/**
 * @file src/room/room-host-permissions.test.ts
 * @purpose Pins decideRoomPermission — the carrier permission decision extracted out of AliveRoomHost so
 *   room-host.ts could stay under its hard clamp. The method had NO direct coverage before the move, so
 *   these are the characterization assertions the move is held to: who delegates, who fails closed, and
 *   the exact shape of the ask pair a denied request publishes.
 * @exports (test suite - no runtime exports)
 * @depends vitest, ../adapters/acp/acp-permission, ../chat/events, ./room-host-permissions
 */
import { expect, it } from "vitest";
import type { PermissionDecider, PermissionRequest } from "../adapters/acp/acp-permission.js";
import { ChatEventBus, type PermissionAskEvent } from "../chat/events.js";
import type { RoomLane } from "./room-engine-contract.js";
import { decideRoomPermission } from "./room-host-permissions.js";
import type { ActivePermissionContext } from "./room-host-support.js";

it("FALSIFIER: an operator lane delegates and publishes NOTHING of its own", async () => {
  const bus = new ChatEventBus();
  const asks = captureAsks(bus);
  const seen: PermissionRequest[] = [];
  const context = laneContext(bus, "operator", async (request) => {
    seen.push(request);
    return { kind: "selected", optionId: "operator-said-yes" };
  });

  const decision = await decideRoomPermission("claude", allowOnly(), context);

  // The operator's own answer comes back verbatim — an implementation that ran the deny ladder anyway
  // and merely FORWARDED the request would return {kind:"cancelled"} here (allowOnly offers no reject).
  expect(decision).toEqual({ kind: "selected", optionId: "operator-said-yes" });
  expect(seen).toHaveLength(1);
  // And it publishes nothing: the interactive decider owns that lane's ask lifecycle (permission-ask.ts),
  // so a second pending/settled pair from here would double-count every operator prompt.
  expect(asks).toEqual([]);
});

it("FALSIFIER: a delegating context needs BOTH an operator origin and a decider", async () => {
  const bus = new ChatEventBus();
  const asks = captureAsks(bus);
  // An agent-origin lane that still carries a decider must NOT delegate: agent hops are unattended, and
  // handing them the operator's interactive decider is how an unwatched hop gets approved.
  const decision = await decideRoomPermission(
    "codex",
    rejectOffered(),
    laneContext(bus, "agent", async () => ({ kind: "selected", optionId: "operator-said-yes" })),
  );

  expect(decision).toEqual({ kind: "selected", optionId: "reject-once-id" });
  expect(asks).toHaveLength(2);
});

it("FALSIFIER: an unattended lane fails closed and publishes one correlated ask pair", async () => {
  const bus = new ChatEventBus();
  const asks = captureAsks(bus);

  const decision = await decideRoomPermission("codex", rejectOffered(), laneContext(bus, "agent"));

  expect(decision).toEqual({ kind: "selected", optionId: "reject-once-id" });
  expect(asks).toHaveLength(2);
  const [pending, settled] = asks;
  if (pending === undefined || settled === undefined) throw new Error("ask pair missing");
  // ONE id across both phases. Two randomUUID() calls — one per emit — is the plausible wrong version,
  // and it leaves every denial permanently pending in any consumer that correlates by askId.
  expect(pending.askId).toBe(settled.askId);
  expect(pending.askId.startsWith("room-denied-")).toBe(true);
  expect(pending).toEqual({
    kind: "permission.ask",
    agent: "codex",
    askId: pending.askId,
    phase: "pending",
    toolTitle: "run the migration",
    options: [
      { optionId: "allow-once-id", kind: "allow_once", name: "Allow once" },
      { optionId: "reject-once-id", kind: "reject_once", name: "Reject once" },
    ],
  });
  expect(settled).toEqual({
    kind: "permission.ask",
    agent: "codex",
    askId: settled.askId,
    phase: "settled",
    outcome: "denied",
    optionId: "reject-once-id",
  });
});

it("FALSIFIER: a cancelled decision carries no optionId key at all", async () => {
  const bus = new ChatEventBus();
  const asks = captureAsks(bus);

  // allow-only options: chooseDenyDecision refuses to fabricate an id and returns the protocol's
  // cancelled envelope. The settled event must then OMIT optionId rather than carry undefined — the
  // wire schema drops unknown/undefined keys silently, so an explicit undefined reads as "no answer".
  const decision = await decideRoomPermission("claude", allowOnly(), laneContext(bus, "agent"));

  expect(decision).toEqual({ kind: "cancelled" });
  expect(Object.keys(asks[1] ?? {})).toEqual(["kind", "agent", "askId", "phase", "outcome"]);
});

it("FALSIFIER: an unparseable request still denies, with a generic title and no options key", async () => {
  const bus = new ChatEventBus();
  const asks = captureAsks(bus);

  const decision = await decideRoomPermission(
    "claude",
    { options: [{ optionId: "" }], toolCall: { title: null } },
    laneContext(bus, "agent"),
  );

  expect(decision).toEqual({ kind: "cancelled" });
  // `options: []` on the wire says "the bridge offered nothing"; an ABSENT key says "we could not read
  // what it offered". normalizePermissionRequest drops the invalid option, so the key must be absent.
  expect(Object.keys(asks[0] ?? {})).toEqual(["kind", "agent", "askId", "phase", "toolTitle"]);
  expect(asks[0]?.toolTitle).toBe("a tool call");
});

it("PIN: with no live lane the decision still fails closed, silently", async () => {
  // No context means no lane is running for this agent, so there is no bus to announce on. The decision
  // still has to be made — a permission request never goes unanswered — and it still fails closed.
  const decision = await decideRoomPermission("codex", rejectOffered(), undefined);
  expect(decision).toEqual({ kind: "selected", optionId: "reject-once-id" });
});

function captureAsks(bus: ChatEventBus): readonly PermissionAskEvent[] {
  const asks: PermissionAskEvent[] = [];
  bus.on("permission.ask", (event) => asks.push(event));
  return asks;
}

function laneContext(
  bus: ChatEventBus,
  origin: "operator" | "agent",
  decider?: PermissionDecider,
): ActivePermissionContext {
  return {
    lane: fixtureLane(origin),
    bus,
    ...(decider === undefined ? {} : { decider }),
  };
}

/** A real RoomLane, not a cast: origin is the only field the decision reads, and a full literal keeps the
 *  fixture honest if the contract grows a field the decision starts caring about. */
function fixtureLane(origin: "operator" | "agent"): RoomLane {
  return {
    agent: "codex",
    turnId: "turn-1",
    text: "run it",
    signal: new AbortController().signal,
    hopIndex: 0,
    origin,
    onChunk: () => undefined,
  };
}

function rejectOffered(): PermissionRequest {
  return {
    options: [
      { optionId: "allow-once-id", kind: "allow_once", name: "Allow once" },
      { optionId: "reject-once-id", kind: "reject_once", name: "Reject once" },
    ],
    toolCall: { title: "run the migration" },
  };
}

function allowOnly(): PermissionRequest {
  return {
    options: [{ optionId: "allow-once-id", kind: "allow_once", name: "Allow once" }],
    toolCall: { title: "run the migration" },
  };
}
