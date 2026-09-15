/**
 * @file src/room/zer0-v2-request-scheduler.test.ts
 * @purpose Proves slow picker discovery cannot block room mutations while model selection remains ordered.
 * @exports (test suite)
 * @depends vitest, ./zer0-v2-request-scheduler
 */
import { expect, it } from "vitest";
import { RoomRequestScheduler } from "./zer0-v2-request-scheduler.js";

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("lets submit progress while a model catalog is still loading", async () => {
  const scheduler = new RoomRequestScheduler();
  const catalog = deferred();
  const order: string[] = [];
  const listing = scheduler.schedule({ kind: "model-read", agent: "claude" }, async () => {
    order.push("models-start");
    await catalog.promise;
    order.push("models-end");
  });
  await Promise.resolve();
  await scheduler.schedule({ kind: "mutation" }, async () => {
    order.push("submit");
  });

  expect(order).toEqual(["models-start", "submit"]);
  catalog.release();
  await listing;
  await scheduler.drain();
});

it("orders same-agent list then selection then following submit", async () => {
  const scheduler = new RoomRequestScheduler();
  const catalog = deferred();
  const order: string[] = [];
  const listing = scheduler.schedule({ kind: "model-read", agent: "codex" }, async () => {
    order.push("models-start");
    await catalog.promise;
    order.push("models-end");
  });
  const selecting = scheduler.schedule({ kind: "model-mutation", agent: "codex" }, async () =>
    order.push("select"),
  );
  const submit = scheduler.schedule({ kind: "mutation" }, async () => order.push("submit"));
  await Promise.resolve();
  expect(order).toEqual(["models-start"]);

  catalog.release();
  await Promise.all([listing, selecting, submit]);
  expect(order).toEqual(["models-start", "models-end", "select", "submit"]);
});

it("allows different provider catalogs to load concurrently", async () => {
  const scheduler = new RoomRequestScheduler();
  const gate = deferred();
  const started: string[] = [];
  const loads = ["claude", "codex"].map((agent) =>
    scheduler.schedule({ kind: "model-read", agent }, async () => {
      started.push(agent);
      await gate.promise;
    }),
  );
  await Promise.resolve();
  expect(started.sort()).toEqual(["claude", "codex"]);
  gate.release();
  await Promise.all(loads);
});
