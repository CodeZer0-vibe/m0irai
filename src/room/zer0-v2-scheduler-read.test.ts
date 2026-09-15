/**
 * @file src/room/zer0-v2-scheduler-read.test.ts
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./zer0-v2-request-scheduler
 * @purpose THE READ DOMAIN, WHICH NOTHING ELSE IN THIS TREE CAN SEE.
 *
 *   A `read` classification does NOT bypass the mutation tail, and believing it did is what put slice
 *   A's boot readiness probe behind the operator's first turn on paper. `schedule` set
 *   `start = priorMutation` for EVERY domain, so classifying a method as `read` only stopped it
 *   EXTENDING the tail — it never stopped it waiting on one.
 *
 *   ⚠ WHY THIS FILE EXISTS AT ALL, which is the part worth keeping: the three pre-existing scheduler
 *   tests use `model-read`, `model-mutation` and `mutation`, and NOT ONE uses `kind: "read"`
 *   (zer0-v2-request-scheduler.test.ts:22, :28, :42, :47, :50, :64). That suite is structurally blind
 *   to this domain: it passed 16/16 both before and after the change, and would have passed identically
 *   had the change been wrong. A test whose reason for existing is a gap in another test has to say so,
 *   or it reads as redundant and the next tidier deletes it.
 *
 *   Its RED was produced against `c6d1e95` BEFORE any lane was dispatched, and is quoted at the
 *   assertion below rather than re-derived here.
 */ import { expect, it } from "vitest";
import { RoomRequestScheduler, requestDomainFor } from "./zer0-v2-request-scheduler.js";

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("[FALSIFIER] a read is not chained behind a pending mutation", async () => {
  const scheduler = new RoomRequestScheduler();
  const blocked = deferred();
  const order: string[] = [];

  // A mutation that will not finish until we say so.
  const mutating = scheduler.schedule({ kind: "mutation" }, async () => {
    order.push("mutation-start");
    await blocked.promise;
    order.push("mutation-end");
  });

  await Promise.resolve();

  // A read issued while that mutation is still in flight.
  const reading = scheduler.schedule({ kind: "read" }, async () => {
    order.push("read-ran");
  });

  // Give the microtask queue several turns to run the read if it is free to run.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  // RED against the unchanged tree, verbatim:
  //   - Expected
  //   + Received
  //     [
  //       "mutation-start",
  //   -   "read-ran",
  //     ]
  // The read never ran while the mutation was pending.
  expect(order).toEqual(["mutation-start", "read-ran"]);

  blocked.release();
  await mutating;
  await reading;
  await scheduler.drain();
});

it("[PIN] session/list is still classified as a read", () => {
  // If this ever stops being a `read`, the change above silently stops applying
  // to the only method it was written for.
  expect(requestDomainFor("session/list", "claude", true)).toEqual({ kind: "read" });
  expect(requestDomainFor("session/new", "claude", true)).toEqual({ kind: "mutation" });
});
