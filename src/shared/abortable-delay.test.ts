/**
 * @file src/shared/abortable-delay.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:events, vitest, ./abortable-delay
 * @purpose The sleep a bounded poll can cut short. It was a private function inside
 *   statusline-payload.ts with no test of its own until the codex rollout poll needed the same
 *   behaviour; these are the assertions that make it safe to have two callers.
 *
 *   The one that matters is the LISTENER: a poll that runs for a whole turn calls this dozens of times
 *   against one long-lived signal, and a version that attached a listener per call without removing it
 *   would work perfectly and leak until the signal did.
 */
import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { abortableDelay } from "./abortable-delay.js";

it("resolves after its delay when nothing aborts", async () => {
  const started = Date.now();

  await abortableDelay(40, undefined);

  // Generous in the direction that cannot flake: 40 ms of real waiting cannot finish in under 20, and
  // a loaded machine only makes it longer.
  expect(Date.now() - started).toBeGreaterThanOrEqual(20);
});

it("FALSIFIER: an abort mid-wait cuts the delay short", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const started = Date.now();

  await abortableDelay(30_000, controller.signal);

  // Thirty seconds is the point. A bare setTimeout sleeps through a shutdown it has already been told
  // about, which is the difference between a room that closes and a room that closes after one more
  // interval.
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("PIN: an ALREADY-aborted signal does not wait at all", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();

  await abortableDelay(30_000, controller.signal);

  expect(Date.now() - started).toBeLessThan(1_000);
});

it("FALSIFIER: a completed wait leaves no listener behind on a long-lived signal", async () => {
  const controller = new AbortController();
  // The real shape: one signal owned by the room, many short waits inside one poll.
  for (let i = 0; i < 40; i += 1) await abortableDelay(0, controller.signal);

  // COUNTED, not inferred. Node warns at 11 listeners on one EventTarget and then keeps going, so a
  // leak here is silent in production and surfaces only as a warning nobody reads.
  //
  // ⚠ THIS ASSERTION WAS WRITTEN VACUOUSLY FIRST. It used `signal.listenerCount`, which is NOT a
  // function on AbortSignal in this runtime, and fell through to a fallback that asserted abort() did
  // not throw — which it never would. Green, and observing nothing. `getEventListeners` is the API
  // that can actually see the subject, checked against a real add/remove before being trusted here.
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

  // The positive control, so an empty result is a REAL answer and not a broken instrument: the same
  // measurement DOES see a listener while one is attached.
  const held = new AbortController();
  const waiting = abortableDelay(30_000, held.signal);
  expect(getEventListeners(held.signal, "abort")).toHaveLength(1);
  held.abort();
  await waiting;
  expect(getEventListeners(held.signal, "abort")).toHaveLength(0);
});
