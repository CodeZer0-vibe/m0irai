/**
 * @file src/room/room-session-listing.test.ts
 * @purpose Falsifiers for session/list: work is proportional to the 128 rows returned, and a damaged room is named.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

/** Counts the reads session/list performs, split by kind: a whole transcript vs a bounded probe. */
const reads = {
  fullTranscript: [] as string[],
  openedForProbe: [] as string[],
  marker: [] as string[],
  probeBytes: 0,
};

/**
 * A Windows file-sharing conflict, injected deterministically. A real one needs a second process holding
 * the handle with `FileShare.None`; that is proven once by hand against the real listing. The suite
 * version counts attempts instead of racing a child process, so it can fail for one reason only.
 */
const sharingConflict: { path: string | undefined; remaining: number } = {
  path: undefined,
  remaining: 0,
};

/** A whole corpus held at once, never released — the shape SL2-A is about. */
const allHeldExcept: { paths: Set<string>; attempts: number } = { paths: new Set(), attempts: 0 };

function busyWhileHeld(file: string): NodeJS.ErrnoException | undefined {
  if (allHeldExcept.paths.has(file)) {
    allHeldExcept.attempts += 1;
    return Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), {
      code: "EBUSY",
    });
  }
  if (file !== sharingConflict.path || sharingConflict.remaining <= 0) return undefined;
  sharingConflict.remaining -= 1;
  return Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), {
    code: "EBUSY",
  });
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: async (file: unknown, options?: unknown) => {
      const held = busyWhileHeld(String(file));
      if (held !== undefined) throw held;
      if (String(file).endsWith("transcript.json")) reads.fullTranscript.push(String(file));
      if (String(file).endsWith("zer0-v2-room.json")) reads.marker.push(String(file));
      return actual.readFile(file as string, options as never);
    },
    open: async (file: unknown, flags?: unknown) => {
      const held = busyWhileHeld(String(file));
      if (held !== undefined) throw held;
      if (String(file).endsWith("transcript.json")) reads.openedForProbe.push(String(file));
      const handle = await actual.open(file as string, (flags ?? "r") as never);
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: async (...args: readonly unknown[]) => {
          const result = await (originalRead as (...a: readonly unknown[]) => Promise<unknown>)(
            ...args,
          );
          reads.probeBytes += (result as { bytesRead?: number }).bytesRead ?? 0;
          return result;
        },
      });
      return handle;
    },
  };
});

const { LISTING_SHARING_BUDGET_MS, listRoomSessions } = await import("./room-session-listing.js");
const { SHARING_RETRY_BUDGET_MS } = await import("../shared/atomic-write.js");
const {
  captureStderr,
  listRooms,
  listedRows: rows,
  minifyTranscript,
  plantNestedStamp,
  seedBeyondThePage,
  seedRoom,
} = await import("./room-listing.fixtures.js");
const { createSession, persistSession, appendMessage } = await import("../chat/session-store.js");
const { createUserMessage } = await import("../chat/commands.js");

const roots: string[] = [];
const ROOM_ROW_LIMIT = 128;

afterEach(async () => {
  reads.fullTranscript = [];
  reads.openedForProbe = [];
  reads.marker = [];
  reads.probeBytes = 0;
  sharingConflict.path = undefined;
  sharingConflict.remaining = 0;
  allHeldExcept.paths = new Set();
  allHeldExcept.attempts = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sl-listing-"));
  roots.push(root);
  return root;
}

it("the hand-written room fixture matches the shape the production writer emits", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  await persistSession(appendMessage(created, createUserMessage(1, "Real")));
  const real = await readFile(path.join(created.runDir, "transcript.json"), "utf8");
  const seeded = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Real" });
  const fixture = await readFile(path.join(seeded.runDir, "transcript.json"), "utf8");

  const topLevelKeys = (body: string) =>
    body.split("\n").flatMap((line) => /^ {2}"([^"]+)":/u.exec(line)?.[1] ?? []);
  expect(topLevelKeys(fixture)).toEqual(topLevelKeys(real));
  expect(Object.keys(JSON.parse(fixture).messages[0]).sort()).toEqual(
    Object.keys(JSON.parse(real).messages[0]).sort(),
  );
});

/**
 * The exact cost of one listing over N rooms, stated as what it is rather than as a headline. Round 2's
 * name ("301 rooms cost 128 whole-transcript reads") was true only of the whole-transcript reads on the
 * fast path, and the codex cross-check measured the rest: 200 marker reads and 200 prefix probes beside
 * them, 328 whole reads once the transcripts were minified, 129 with one damaged candidate.
 *
 * What holds for EVERY corpus: one marker read and one bounded prefix probe per room, and never more
 * whole-transcript reads than there are rooms. What holds when every transcript is in m0irai's own
 * pretty layout: exactly `limit` whole reads. Both are asserted below.
 */
it("one listing costs one marker read and one bounded probe per room, and 128 whole reads on the fast path", async () => {
  const root = await freshRoot();
  const ROOMS = 301;
  for (let index = 0; index < ROOMS; index += 1) {
    await seedRoom(root, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), {
      title: `Room ${String(index).padStart(3, "0")}`,
      padBytes: 2_000,
    });
  }
  reads.fullTranscript = [];
  reads.openedForProbe = [];
  reads.marker = [];
  reads.probeBytes = 0;

  const listed = rows(await listRooms(root));

  expect(listed).toHaveLength(ROOM_ROW_LIMIT);
  expect(reads.fullTranscript).toHaveLength(ROOM_ROW_LIMIT);
  expect(reads.fullTranscript.length).toBeLessThanOrEqual(ROOMS);
  expect(reads.marker).toHaveLength(ROOMS);
  expect(reads.openedForProbe).toHaveLength(ROOMS);
  // Each probe is capped, so the probe cost cannot scale with transcript size the way a full load does.
  expect(reads.probeBytes).toBeLessThanOrEqual(ROOMS * 8_192);
});

it("falsifier: the newest 128 match a reference full sort, including a tie broken by session id", async () => {
  const root = await freshRoot();
  const seeded: { id: string; updatedAt: string }[] = [];
  for (let index = 0; index < 130; index += 1) {
    // Two rooms deliberately share one timestamp so the id tie-break is exercised inside the cut.
    const updatedAt = new Date(
      Date.UTC(2026, 0, 1, 0, 0, index === 129 ? 128 : index),
    ).toISOString();
    seeded.push({ id: (await seedRoom(root, updatedAt)).id, updatedAt });
  }
  const reference = [...seeded]
    .sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? right.id.localeCompare(left.id)
        : right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, ROOM_ROW_LIMIT)
    .map((room) => room.id);

  expect(rows(await listRooms(root)).map((row) => row.sessionId)).toEqual(reference);
});

// SL-2 (review round 1): the write path retries EPERM/EACCES/EBUSY for two seconds; the read path
// treated the identical codes as permanent damage and told the operator so. A backup agent, an antivirus
// scanner or an editor holding a transcript for a moment must cost the listing a wait, not a false alarm.
it("falsifier: a healthy room held open by another process lists normally and is never called damaged", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const held = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Held open" });
  // Six refusals, then the holder lets go — well inside the shared two-second budget.
  sharingConflict.path = path.join(held.runDir, "transcript.json");
  sharingConflict.remaining = 6;

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(sharingConflict.remaining).toBe(0);
  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id, held.id]);
  expect(listed.find((row) => row.sessionId === held.id)?.title).toBe("Held open");
  expect(stderr.filter((line) => line.includes(held.id))).toEqual([]);
});

it("falsifier: a room held open past the budget is named as a sharing conflict, not as damage", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const held = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Never released" });
  sharingConflict.path = path.join(held.runDir, "transcript.json");
  sharingConflict.remaining = Number.MAX_SAFE_INTEGER;

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id]);
  const named = stderr.filter((line) => line.includes(held.id));
  expect(named).toHaveLength(1);
  // The wording is the finding: a held file is a sharing conflict whose file is untouched, never damage.
  expect(named[0]).toMatch(/file-sharing conflict/u);
  expect(named[0]).toMatch(/untouched/u);
});

// Round 3, finding 4 (codex P: TORN_MARKER — result {sessions:[]}, stderr []). A marker that cannot be
// read made the room vanish with nothing said, because the marker read answers only yes or no.
it("falsifier: a room whose marker cannot be read is named, not silently dropped", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const torn = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Marker torn" });
  // Cut mid-key, the way a half-finished write leaves it. Built by slicing a real marker rather than
  // written as a literal, so this file carries no unbalanced brace for the clamp gate to count.
  const halfWritten = JSON.stringify({ version: 1 }).slice(0, 5);
  await writeFile(path.join(torn.runDir, "zer0-v2-room.json"), halfWritten, "utf8");

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id]);
  const named = stderr.filter((line) => line.includes(torn.id));
  expect(named).toHaveLength(1);
  expect(named[0]).toMatch(/marker/u);
});

it("falsifier: a marker held open past the budget is named as a sharing conflict", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const held = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Marker held" });
  sharingConflict.path = path.join(held.runDir, "zer0-v2-room.json");
  sharingConflict.remaining = Number.MAX_SAFE_INTEGER;

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id]);
  const named = stderr.filter((line) => line.includes(held.id));
  expect(named).toHaveLength(1);
  expect(named[0]).toMatch(/file-sharing conflict/u);
});

// Round 3, finding 5 (codex P: NESTED_STAMP_INPUT — schema-valid, same room, real updatedAt
// 2026-01-01T00:03:19.000Z; the listing took a 1900 stamp and dropped the newest room silently).
it("falsifier: a nested two-space updatedAt cannot drop the newest room off the page", async () => {
  const root = await freshRoot();
  const seeded = await seedBeyondThePage(root, 130);
  const newest = seeded[129];
  if (newest === undefined) throw new Error("fixture needs 130 rooms");
  await plantNestedStamp(newest.runDir, "1900-01-01T00:00:00.000Z");

  const listed = rows(await listRooms(root));

  expect(listed).toHaveLength(ROOM_ROW_LIMIT);
  expect(listed[0]?.sessionId).toBe(newest.id);
  expect(listed[0]?.updatedAt).toBe("2026-01-01T00:02:09.000Z");
});

it("falsifier: a nested stamp NEWER than the real one cannot promote a room onto the page", async () => {
  const root = await freshRoot();
  const seeded = await seedBeyondThePage(root, 130);
  const oldest = seeded[0];
  if (oldest === undefined) throw new Error("fixture needs 130 rooms");
  await plantNestedStamp(oldest.runDir, "2099-01-01T00:00:00.000Z");

  const listed = rows(await listRooms(root));

  expect(listed).toHaveLength(ROOM_ROW_LIMIT);
  // The oldest of 130 rooms belongs outside a 128-row page, whatever a nested member claims.
  expect(listed.map((row) => row.sessionId)).not.toContain(oldest.id);
});

// Round 3, finding 6 (codex P: LIST_200_MINIFIED — 328 whole-transcript reads for 200 rooms, because
// the stamp fallback loads the transcript, throws it away, and the page then loads it again).
it("falsifier: a transcript read for its stamp is never read a second time for its title", async () => {
  const root = await freshRoot();
  // Minified: no header the prefix probe can reconstruct, so every room takes the whole-file fallback.
  for (const room of await seedBeyondThePage(root, 200)) await minifyTranscript(room.runDir);
  reads.fullTranscript = [];

  const listed = rows(await listRooms(root));

  expect(listed).toHaveLength(ROOM_ROW_LIMIT);
  // The bound this listing can actually prove: never more whole reads than there are rooms.
  expect(reads.fullTranscript.length).toBeLessThanOrEqual(200);
  // And no transcript is read twice in one listing.
  expect(new Set(reads.fullTranscript).size).toBe(reads.fullTranscript.length);
});

// Round 3, finding 7 (codex P: UNREADABLE_DIRECTORY — EISDIR returned in 18 ms with no retry, while
// stderr claimed "even after retrying a file-sharing conflict" and promised the holder would release).
it("falsifier: a permanent read error is not described as a sharing conflict that was retried", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const broken = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Directory" });
  const transcript = path.join(broken.runDir, "transcript.json");
  await rm(transcript, { force: true });
  await mkdir(transcript, { recursive: true });

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id]);
  const named = stderr.filter((line) => line.includes(broken.id));
  expect(named).toHaveLength(1);
  expect(named[0]).toMatch(/EISDIR/u);
  expect(named[0]).not.toMatch(/file-sharing conflict/u);
  expect(named[0]).not.toMatch(/releases it/u);
});

it("falsifier: a room truncated mid-write is named on stderr, and its neighbours still list", async () => {
  const root = await freshRoot();
  const healthy = await seedRoom(root, "2026-01-03T00:00:00.000Z", { title: "Still here" });
  const damaged = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Torn" });
  const alsoHealthy = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Also here" });
  const torn = path.join(damaged.runDir, "transcript.json");
  const whole = await readFile(torn, "utf8");
  await writeFile(torn, whole.slice(0, Math.floor(whole.length * 0.6)), "utf8");

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([healthy.id, alsoHealthy.id]);
  const named = stderr.filter((line) => line.includes(damaged.id));
  expect(named).toHaveLength(1);
  expect(named[0]).toMatch(/transcript/u);
});

it("falsifier: an unreadable runs directory is an error, never an empty room list", async () => {
  const root = await freshRoot();
  await seedRoom(root, "2026-01-01T00:00:00.000Z");
  // A file where the runs directory belongs is the readable stand-in for a directory that cannot be
  // enumerated: readdir fails with a non-ENOENT code exactly as a permission failure does.
  await rm(path.join(root, ".council", "runs"), { recursive: true, force: true });
  await writeFile(path.join(root, ".council", "runs"), "not a directory", "utf8");

  const frame = await listRooms(root);
  expect(frame.result).toBeUndefined();
  expect(JSON.stringify(frame.error)).toMatch(/runs/u);
});

// SL2-A (delta review): the per-room retry was bounded but the listing was not — 16 rooms at a time,
// each waiting up to 2 s, so 128 held rooms took 16,261 ms on this box and blew past the Rust picker's
// 15 s timeout, leaving the operator with a failure instead of the rooms that were fine.
it("falsifier: a listing whose rooms are all held still returns the healthy ones, on a budget", async () => {
  const root = await freshRoot();
  const seeded = await seedBeyondThePage(root, 40);
  const healthy = seeded[39];
  if (healthy === undefined) throw new Error("fixture needs 40 rooms");
  // Every room but the newest is held and never released.
  allHeldExcept.paths = new Set(
    seeded.slice(0, 39).map((room) => path.join(room.runDir, "transcript.json")),
  );

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    listRoomSessions({
      repoRoot: root,
      roomVersion: 1,
      limit: 128,
      report: (line) => process.stderr.write(`${line}\n`),
      // A tiny budget stands in for the derived one: the assertion is that the listing STOPS waiting
      // and answers, not how long it waited. Timing belongs in the probe, never in an assertion.
      sharingBudgetMs: 40,
    }),
  );

  expect(listed.map((row) => row.sessionId)).toEqual([healthy.id]);
  expect(stderr.filter((line) => line.includes("file-sharing conflict"))).toHaveLength(39);
  // Uncapped, 39 held rooms across 3 waves would retry for thousands of attempts; the budget caps it.
  expect(allHeldExcept.attempts).toBeLessThan(39 * 10);
});

it("the listing budget leaves the Rust picker's own timeout room to spare", () => {
  // SESSION_PICKER_TIMEOUT is 15 s at rust/crates/zer0-v2-bin/src/pager_room.rs:29, used at :663.
  // This is a ratchet: raising the budget toward the client's timeout fails here.
  const SESSION_PICKER_TIMEOUT_MS = 15_000;
  expect(LISTING_SHARING_BUDGET_MS * 3).toBeLessThanOrEqual(SESSION_PICKER_TIMEOUT_MS);
  expect(LISTING_SHARING_BUDGET_MS).toBeGreaterThanOrEqual(SHARING_RETRY_BUDGET_MS);
});

// N2-1 (delta review): the marker retry was pinned by no test at all — the reviewer deleted it outright
// and the whole suite stayed green. This one fails if the retry is removed.
it("falsifier: a marker released inside the budget lists its room, with nothing on stderr", async () => {
  const root = await freshRoot();
  const neighbour = await seedRoom(root, "2026-01-02T00:00:00.000Z", { title: "Neighbour" });
  const held = await seedRoom(root, "2026-01-01T00:00:00.000Z", { title: "Marker released" });
  // Six refusals on the MARKER, then the holder lets go — the retry is the only thing that can win here.
  sharingConflict.path = path.join(held.runDir, "zer0-v2-room.json");
  sharingConflict.remaining = 6;

  const { value: listed, lines: stderr } = await captureStderr(async () =>
    rows(await listRooms(root)),
  );

  expect(sharingConflict.remaining).toBe(0);
  expect(listed.map((row) => row.sessionId)).toEqual([neighbour.id, held.id]);
  expect(listed.find((row) => row.sessionId === held.id)?.title).toBe("Marker released");
  expect(stderr.filter((line) => line.includes(held.id))).toEqual([]);
});
