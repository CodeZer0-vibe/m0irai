/**
 * @file src/room/room-host-contract.test.ts
 * @purpose Locks the public room submit, control, and mode-cycle command shapes.
 * @exports (test suite)
 * @depends vitest, ./room-host-contract
 */
import { expect, it } from "vitest";
import type { RoomControl, RoomModeCycle, RoomSubmit } from "./room-host-contract.js";

it("keeps submit and mode-cycle text owned by one request identity", () => {
  const submit = { requestId: "request-1", text: "@codex inspect" } satisfies RoomSubmit;
  const cycle = { requestId: "request-2", text: "@codex inspect" } satisfies RoomModeCycle;

  expect(submit).toEqual({ requestId: "request-1", text: "@codex inspect" });
  expect(cycle).toEqual({ requestId: "request-2", text: "@codex inspect" });
});

it("keeps pause/resume distinct from scoped cancellation", () => {
  const pause = { requestId: "request-1", command: "pause" } satisfies RoomControl;
  const cancel = {
    requestId: "request-2",
    command: "cancel",
    scope: "agent",
    agent: "gemini",
  } satisfies RoomControl;

  expect(pause).toEqual({ requestId: "request-1", command: "pause" });
  expect(cancel).toMatchObject({ command: "cancel", scope: "agent", agent: "gemini" });
});
