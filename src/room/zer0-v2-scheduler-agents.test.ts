/**
 * @file src/room/zer0-v2-scheduler-agents.test.ts
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./zer0-v2-request-scheduler
 * @purpose Slice A site 11 — the boot readiness RPC must not be serialized behind the operator's first
 *   turn, which is the entire latency argument for having it. Asserted through the REAL path a request
 *   takes: method name → requestDomainFor → schedule.
 *
 *   ⚠ THREE READINGS, and the middle one is the load-bearing one. The spec first instructed slice A to
 *   fix this by classification alone — add the method to isReadOnlyRpcMethod and give it a `read` case.
 *   That is not enough and never was: `schedule` set `start = priorMutation` for EVERY domain, so a
 *   `read` classification only stopped a method EXTENDING the mutation tail, never waiting on one.
 *   Quoting reading (ii) is what stops a future revision reinstating that instruction.
 */
import { expect, it } from "vitest";
import { RoomRequestScheduler, requestDomainFor } from "./zer0-v2-request-scheduler.js";

it("[FALSIFIER] the readiness RPC resolves while a turn is still in flight", async () => {
  const scheduler = new RoomRequestScheduler();
  const order: string[] = [];
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const turn = scheduler.schedule(requestDomainFor("room/submit", "claude", true), async () => {
    order.push("turn-start");
    await blocked;
    order.push("turn-end");
  });
  await Promise.resolve();

  const readiness = scheduler.schedule(
    requestDomainFor("zer0/room/agents", "claude", true),
    async () => {
      order.push("readiness-ran");
    },
  );
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  // WHILE IT IS IN FLIGHT, not merely eventually. A serialized request also eventually resolves, and a
  // test that asserted only that could never fail.
  //
  // reading (i)  — unmodified tree:                    expected [ 'turn-start' ] to deeply equal [ 'turn-start', 'readiness-ran' ]
  // reading (ii) — classifications only, no schedule change: expected [ 'turn-start' ] to deeply equal [ 'turn-start', 'readiness-ran' ]
  // reading (iii) — with the schedule change:          passes
  expect(order).toEqual(["turn-start", "readiness-ran"]);

  release();
  await turn;
  await readiness;
  await scheduler.drain();
});

it("[PIN] the readiness RPC is classified read on BOTH of the scheduler's two lists", () => {
  // The two classifications are independent and a method needs both: isReadOnlyRpcMethod governs
  // whether a request may proceed when the replay cache is full (zer0-v2-host.ts:157-158), and
  // requestDomainFor governs ordering. Adding it to one and not the other produces a boot probe that
  // is refused under load, or one that extends the mutation tail — different failures, both silent.
  expect(requestDomainFor("zer0/room/agents", "claude", true)).toEqual({ kind: "read" });
  expect(requestDomainFor("zer0/room/catalog", "claude", true)).toEqual({ kind: "mutation" });
  // Detached rooms take the conservative path regardless of method.
  expect(requestDomainFor("zer0/room/agents", "claude", false)).toEqual({ kind: "mutation" });
});
