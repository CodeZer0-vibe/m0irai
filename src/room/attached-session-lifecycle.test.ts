// attached-session-lifecycle: ONE attach (both session RPCs, identity frozen from the room itself), ONE
// detach (every trigger shares a single promise, so the room shuts down once and the digest is scheduled
// once), boot catch-up only on session/new and never for the attached session, the memory master switch
// keeping the whole thing inert, and a forced-drain failure that still lets the digest out before it is
// re-thrown. Real fs for the durable close record; the two spawn seams are injected, so no child is forked.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BootCatchUpRequest, DigestRequest } from "../memory/digest-runner.js";
import {
  type AttachableRoom,
  AttachedSessionLifecycle,
  type AttachedSessionLifecycleOptions,
} from "./attached-session-lifecycle.js";

const roots: string[] = [];
const savedMemory = process.env.ZER0_MEMORY;

afterEach(() => {
  if (savedMemory === undefined) delete process.env.ZER0_MEMORY;
  else process.env.ZER0_MEMORY = savedMemory;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Recorded {
  readonly order: string[];
  readonly spawned: DigestRequest[];
  readonly caught: BootCatchUpRequest[];
  readonly failures: unknown[];
}

class FakeRoom implements AttachableRoom {
  public shutdowns = 0;
  public constructor(
    private readonly id: string,
    private readonly project: string,
    private readonly order: string[],
    private readonly failure?: Error,
  ) {}
  public sessionId(): string {
    return this.id;
  }
  public projectId(): string {
    return this.project;
  }
  public async shutdown(): Promise<void> {
    this.shutdowns += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.order.push("room.shutdown");
    if (this.failure !== undefined) throw this.failure;
  }
}

function harness(): {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly recorded: Recorded;
  readonly options: AttachedSessionLifecycleOptions;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), "zer0-lifecycle-"));
  roots.push(repoRoot);
  const dbPath = join(repoRoot, ".zer0", "evidence.db");
  const recorded: Recorded = { order: [], spawned: [], caught: [], failures: [] };
  const options: AttachedSessionLifecycleOptions = {
    repoRoot,
    dbPath,
    spawnDigest: (request) => {
      recorded.order.push("digest.spawn");
      recorded.spawned.push(request);
      return "requested";
    },
    catchUp: async (request) => {
      recorded.caught.push(request);
      return 0;
    },
    onBackgroundFailure: (error) => recorded.failures.push(error),
  };
  return { repoRoot, dbPath, recorded, options };
}

function closeLog(repoRoot: string): string[] {
  const file = join(repoRoot, ".zer0", "journal", "room-close.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

it("both session RPCs attach through the one path and freeze the room's own identity", () => {
  for (const origin of ["session/new", "session/load"] as const) {
    const { repoRoot, dbPath, options } = harness();
    const lifecycle = new AttachedSessionLifecycle({ ...options, repoRoot, dbPath });
    lifecycle.attach(new FakeRoom("chat-attached", "project-42", []), origin);
    expect(lifecycle.attachedSession()).toEqual({
      sessionId: "chat-attached",
      projectId: "project-42",
      dbPath,
      repoRoot,
    });
    expect(lifecycle.isAttached()).toBe(true);
  }
});

it("a second attach is a programming error, and a room without an identity is refused", () => {
  const { options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  lifecycle.attach(new FakeRoom("chat-one", "p1", recorded.order), "session/new");
  expect(() =>
    lifecycle.attach(new FakeRoom("chat-two", "p1", recorded.order), "session/new"),
  ).toThrow("already owns a room");

  const fresh = new AttachedSessionLifecycle(harness().options);
  expect(() => fresh.attach(new FakeRoom("room-1", "p1", []), "session/new")).toThrow(
    "non-chat session id",
  );
  expect(() => fresh.attach(new FakeRoom("chat-x", "", []), "session/new")).toThrow(
    "empty project id",
  );
});

it("boot catch-up runs at session/new EXCLUDING the attached session, and never at session/load", async () => {
  const created = harness();
  const createdLifecycle = new AttachedSessionLifecycle(created.options);
  createdLifecycle.attach(new FakeRoom("chat-new", "p-new", created.recorded.order), "session/new");

  const loaded = harness();
  const loadedLifecycle = new AttachedSessionLifecycle(loaded.options);
  loadedLifecycle.attach(new FakeRoom("chat-old", "p-old", loaded.recorded.order), "session/load");

  await new Promise((resolve) => setTimeout(resolve, 20)); // the catch-up is scheduled, never awaited
  expect(created.recorded.caught).toEqual([
    {
      repoRoot: created.repoRoot,
      dbPath: created.dbPath,
      projectId: "p-new",
      exclude: "chat-new",
    },
  ]);
  expect(loaded.recorded.caught).toEqual([]);
  expect(created.recorded.failures).toEqual([]);
});

it("concurrent shutdown and EOF triggers share ONE close: one room shutdown, one digest, one record", async () => {
  const { repoRoot, options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  const room = new FakeRoom("chat-once", "p1", recorded.order);
  lifecycle.attach(room, "session/new");

  const explicit = lifecycle.detach("zer0/room/shutdown");
  const eof = lifecycle.detach("stdin-eof");
  await Promise.all([explicit, eof]);
  await lifecycle.detach("stdin-eof"); // a third, after the close already settled

  expect(room.shutdowns).toBe(1);
  expect(recorded.spawned).toEqual([
    { sessionId: "chat-once", repoRoot, dbPath: options.dbPath, projectId: "p1" },
  ]);
  // Order is the contract: the transcript is complete on disk BEFORE the digest child is allowed to read it.
  expect(recorded.order).toEqual(["room.shutdown", "digest.spawn"]);
  const lines = closeLog(repoRoot);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(
    "session=chat-once reason=zer0/room/shutdown digest=requested drain=ok",
  );
  expect(lifecycle.attachedRoom()).toBeUndefined();
});

it("a forced-drain failure still lets the digest out, then reaches every caller of the close", async () => {
  const { repoRoot, options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  const room = new FakeRoom(
    "chat-hung",
    "p1",
    recorded.order,
    new Error("room lanes did not terminate"),
  );
  lifecycle.attach(room, "session/load");

  const first = lifecycle.detach("zer0/room/shutdown");
  const second = lifecycle.detach("stdin-eof");
  await expect(first).rejects.toThrow("room lanes did not terminate");
  await expect(second).rejects.toThrow("room lanes did not terminate");

  expect(recorded.spawned.map((request) => request.sessionId)).toEqual(["chat-hung"]);
  expect(room.shutdowns).toBe(1);
  const lines = closeLog(repoRoot);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("digest=requested drain=room lanes did not terminate");
});

it("the memory master switch keeps the whole unit inert: no digest, no catch-up, close still recorded", async () => {
  process.env.ZER0_MEMORY = "0";
  const { repoRoot, options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  lifecycle.attach(new FakeRoom("chat-off", "p1", recorded.order), "session/new");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lifecycle.detach("zer0/room/shutdown");

  expect({ spawned: recorded.spawned, caught: recorded.caught }).toEqual({
    spawned: [],
    caught: [],
  });
  expect(closeLog(repoRoot)[0]).toContain("digest=skipped(memory-off)");
});

it("closing a host that never attached is a no-op: nothing forked, nothing recorded", async () => {
  const { repoRoot, options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  await lifecycle.detach("stdin-eof");
  expect({
    spawned: recorded.spawned,
    log: closeLog(repoRoot),
    attached: lifecycle.isAttached(),
  }).toEqual({ spawned: [], log: [], attached: false });
});

it("an attach after the close has begun is refused — one host process spends exactly one attach", async () => {
  const { options, recorded } = harness();
  const lifecycle = new AttachedSessionLifecycle(options);
  lifecycle.attach(new FakeRoom("chat-spent", "p1", recorded.order), "session/new");
  await lifecycle.detach("zer0/room/shutdown");
  expect(lifecycle.isAttached()).toBe(true);
  expect(() =>
    lifecycle.attach(new FakeRoom("chat-next", "p1", recorded.order), "session/new"),
  ).toThrow("already owns a room");
});

it("the close record carries the SEAM's own word: handed-off, and a failed handoff says failed", async () => {
  const { repoRoot, options, recorded } = harness();
  const handed = new AttachedSessionLifecycle({
    ...options,
    spawnDigest: (request) => {
      recorded.spawned.push(request);
      return "handed-off"; // what the F10 writer reports when it queued a request for the parent
    },
  });
  handed.attach(new FakeRoom("chat-handed", "p1", recorded.order), "session/new");
  await handed.detach("zer0/room/shutdown");
  expect(closeLog(repoRoot)[0]).toContain(
    "session=chat-handed reason=zer0/room/shutdown digest=handed-off",
  );

  // A request that cannot be made durable must not be reported as a scheduled digest, and must not turn the
  // close into a crash: the close completes, the record says so, and the failure reaches the diagnostic.
  const broken = harness();
  const failing = new AttachedSessionLifecycle({
    ...broken.options,
    spawnDigest: () => {
      throw new Error("ENOTDIR: not a directory, mkdir");
    },
  });
  failing.attach(new FakeRoom("chat-nowrite", "p1", broken.recorded.order), "session/new");
  await expect(failing.detach("stdin-eof")).resolves.toBeUndefined();
  expect(closeLog(broken.repoRoot)[0]).toContain("digest=failed(ENOTDIR: not a directory, mkdir)");
  expect(broken.recorded.failures.map((error) => (error as Error).message)).toEqual([
    "ENOTDIR: not a directory, mkdir",
  ]);
});
