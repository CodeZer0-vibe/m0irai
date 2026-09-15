/**
 * @file src/room/room-session-listing.ts
 * @purpose Build the session/list page with work proportional to the rows returned, naming every room it cannot read.
 * @exports RoomSessionRow, RoomListingInput, RoomMarkerOutcome, LISTING_SHARING_BUDGET_MS, listRoomSessions, isRoomMarked, readRoomMarker
 * @depends node:fs/promises, node:path, ../chat/session-store, ../chat/transcript-read, ../shared/atomic-write, ./room-host-support, ./zer0-v2-rpc
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listSessionDirs, readSession, readSessionUpdatedAt } from "../chat/session-store.js";
import type { TranscriptFailure } from "../chat/transcript-read.js";
import {
  SHARING_RETRY_BUDGET_MS,
  isTransientReplaceError,
  retryOnSharingViolation,
} from "../shared/atomic-write.js";
import { roomSessionTitle } from "./room-host-support.js";
import { internalError } from "./zer0-v2-rpc.js";

const ROOM_MARKER = "zer0-v2-room.json";
const COUNCIL_RUNS_DIR = ".council/runs";
/**
 * How many rooms are touched at once. The listing used to fan out over EVERY room simultaneously, which
 * on a 301-room repo meant 301 open transcripts at once; a fixed width keeps the open-handle count flat
 * as history grows, and 16 is wide enough that the pass stays I/O-bound rather than round-trip-bound.
 */
const READ_WIDTH = 16;

/**
 * How long ONE listing may spend waiting out file-sharing conflicts, across every room together.
 *
 * The per-room retry was bounded but the listing was not, and the two compose badly: 16 rooms run at a
 * time and each may wait 2 s, so the cost grows by about 2 s per wave of 16 held rooms. Measured on
 * this box with 128 held transcripts: 16,261 ms — past the point where the caller has given up.
 *
 * The caller's own limits are the ceiling this must sit under. The Rust picker calls `session/list`
 * with SESSION_PICKER_TIMEOUT = 15 s (`rust/crates/zer0-v2-bin/src/pager_room.rs:29`, used at :663),
 * and `--continue` startup shares STARTUP_TIMEOUT = 20 s (`rust/crates/zer0-v2-bin/src/cli.rs:10`)
 * with the host spawn and `session/load`. 5 s is one third of the tighter of those two, leaving 10 s
 * for the page's own reads, the JSON-RPC round trip and a box under load — and it still lets the
 * common case of one or two held rooms spend the full per-room 2 s twice over.
 *
 * Spending it stops the WAITING, not the listing: the rooms that are fine are returned and the rooms
 * still held are reported. Returning the healthy rooms late is worse than returning them on time;
 * returning nothing at all, which is what the caller's timeout produces, is worse than both.
 */
export const LISTING_SHARING_BUDGET_MS = 5_000;

export interface RoomSessionRow {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface RoomListingInput {
  readonly repoRoot: string;
  readonly roomVersion: number;
  readonly limit: number;
  /** Called once per room that exists but cannot be read. The host writes these to stderr. */
  readonly report: (line: string) => void;
  /** Overrides {@link LISTING_SHARING_BUDGET_MS}; only a test needs a budget other than the derived one. */
  readonly sharingBudgetMs?: number;
}

/**
 * What one room's read may still spend on a sharing conflict: whichever of the per-room cap and the
 * listing's remaining budget is smaller. Both caps apply, so no single room can eat the whole listing
 * and the listing cannot outlive its caller.
 */
function sharingBudgetLeft(deadline: number): number {
  return Math.min(SHARING_RETRY_BUDGET_MS, Math.max(0, deadline - Date.now()));
}

interface Candidate {
  readonly sessionId: `chat-${string}`;
  readonly updatedAt: string;
  /** Present when the stamp step already read the whole transcript, so the page never reads it twice. */
  readonly title?: string;
}

/**
 * Three answers, not two. A marker that is simply ABSENT means "not a room of this version" — a legacy
 * chat session or a half-created directory, and nothing to announce. A marker that EXISTS and cannot be
 * read is a different fact: something wrote it and it is now damaged or held, and answering "not a room"
 * to that made the room vanish from the picker with nothing on stderr at all (codex cross-check,
 * TORN_MARKER returned `{sessions:[]}` with empty stderr; a real 3.5 s marker lock did the same).
 */
export type RoomMarkerOutcome =
  | { readonly kind: "marked" }
  | { readonly kind: "not-a-room" }
  | { readonly kind: "unreadable"; readonly reason: string; readonly code: string | undefined };

export async function readRoomMarker(
  repoRoot: string,
  sessionId: string,
  roomVersion: number,
  sharingBudgetMs?: number,
): Promise<RoomMarkerOutcome> {
  const markerPath = path.join(repoRoot, COUNCIL_RUNS_DIR, sessionId, ROOM_MARKER);
  let raw: string;
  try {
    // The same sharing-violation retry the transcript read and the write path use, so a marker held
    // open for a few milliseconds costs a wait rather than a disappearing room.
    raw = await retryOnSharingViolation(() => readFile(markerPath, "utf8"), sharingBudgetMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { kind: "not-a-room" };
    return {
      kind: "unreadable",
      reason: `${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
      code,
    };
  }
  let marker: unknown;
  try {
    marker = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `${markerPath} is not a JSON document: ${error instanceof Error ? error.message : String(error)}`,
      code: undefined,
    };
  }
  const version =
    typeof marker === "object" && marker !== null && !Array.isArray(marker)
      ? (marker as Record<string, unknown>).version
      : undefined;
  return version === roomVersion ? { kind: "marked" } : { kind: "not-a-room" };
}

/** The yes/no view, for the attach path that only asks whether this id is a room of this version. */
export async function isRoomMarked(
  repoRoot: string,
  sessionId: string,
  roomVersion: number,
): Promise<boolean> {
  return (await readRoomMarker(repoRoot, sessionId, roomVersion)).kind === "marked";
}

/**
 * The two-stage listing. Stage one reads only fixed-size evidence per room — the marker, then a bounded
 * transcript prefix carrying `updatedAt` — so ordering every room costs a constant per room instead of
 * a full parse. Stage two loads ONLY the page that is about to be returned, because the title is the
 * one field that genuinely needs the messages.
 *
 * THE COST, stated exactly rather than as a headline. Per listing over N rooms: N marker reads, N
 * bounded prefix probes, and whole-transcript reads that never exceed N. When every transcript is in
 * m0irai's own pretty layout the whole reads are exactly `limit`, because the probe answers for every
 * room and only the page is loaded. A transcript whose header does not reconstruct is read whole once
 * for its stamp, and that load is carried forward so the page never reads it again — reading it twice
 * is what made 200 minified rooms cost 328 whole reads (codex cross-check, LIST_200_MINIFIED).
 *
 * Ordering stays exactly what it was: newest `updatedAt` first, ties broken by descending session id.
 * The pre-sort key is the room's own recorded `updatedAt`, never the file's mtime — a room's transcript
 * is written whenever the room is touched, so mtime tracks WRITE order, and rooms written concurrently
 * (the 129-room fixture writes in batches of eight) come back in an order mtime cannot reproduce.
 */
export async function listRoomSessions(
  input: RoomListingInput,
): Promise<readonly RoomSessionRow[]> {
  if (input.limit <= 0) throw new Error("a room listing must be allowed at least one row");
  const dirs = await listSessionDirs(input.repoRoot);
  if (dirs.kind === "unreadable")
    throw internalError(
      `the room directory could not be read, so this list would understate your rooms (${dirs.reason})`,
    );
  // ONE deadline for the whole fan-out, taken before any room is touched.
  const deadline = Date.now() + (input.sharingBudgetMs ?? LISTING_SHARING_BUDGET_MS);
  const ordered = [...(await stampRooms(input, dirs.sessionIds, deadline))].sort(newestFirst);
  return loadPage(input, ordered, deadline);
}

interface Ordered {
  readonly sessionId: string;
  readonly updatedAt: string;
}

function newestFirst(left: Ordered, right: Ordered): number {
  return left.updatedAt === right.updatedAt
    ? right.sessionId.localeCompare(left.sessionId)
    : right.updatedAt.localeCompare(left.updatedAt);
}

async function stampRooms(
  input: RoomListingInput,
  sessionIds: readonly `chat-${string}`[],
  deadline: number,
): Promise<readonly Candidate[]> {
  const stamped = await mapBounded(sessionIds, async (sessionId) => {
    const marker = await readRoomMarker(
      input.repoRoot,
      sessionId,
      input.roomVersion,
      sharingBudgetLeft(deadline),
    );
    if (marker.kind === "not-a-room") return undefined;
    if (marker.kind === "unreadable") {
      reportFailure(input, sessionId, marker, "marker");
      return undefined;
    }
    const stamp = await readSessionUpdatedAt(
      sessionId,
      input.repoRoot,
      sharingBudgetLeft(deadline),
    );
    if (stamp.kind !== "stamped") {
      reportFailure(input, sessionId, stamp, "transcript");
      return undefined;
    }
    // When the stamp cost a whole-file read anyway, keep the ONE thing the page still needs — the
    // title — and drop the session. Throwing that load away made the page read the same transcript a
    // second time: 200 minified rooms cost 328 whole reads (codex cross-check, LIST_200_MINIFIED).
    // Keeping the title rather than the session bounds what is retained to a clipped string per room.
    return stamp.session === undefined
      ? { sessionId, updatedAt: stamp.updatedAt }
      : { sessionId, updatedAt: stamp.updatedAt, title: roomSessionTitle(stamp.session) };
  });
  return stamped.filter((candidate): candidate is Candidate => candidate !== undefined);
}

/**
 * Loads titles for the page. In the healthy case this is exactly one batch of `limit` transcripts. A
 * room that turns out to be damaged is reported and replaced from the next-newest candidates, so one
 * torn file costs the operator a warning rather than a missing row — and the total still cannot exceed
 * the number of rooms that exist.
 */
async function loadPage(
  input: RoomListingInput,
  ordered: readonly Candidate[],
  deadline: number,
): Promise<readonly RoomSessionRow[]> {
  const rows: RoomSessionRow[] = [];
  let cursor = 0;
  while (cursor < ordered.length && rows.length < input.limit) {
    const batch = ordered.slice(cursor, cursor + (input.limit - rows.length));
    cursor += batch.length;
    const loaded = await mapBounded(batch, (candidate) => loadRow(input, candidate, deadline));
    rows.push(...loaded.filter((row): row is RoomSessionRow => row !== undefined));
  }
  // The loaded rows carry the authoritative `updatedAt`; re-sorting on it means the answer never
  // depends on the prefix probe being byte-identical to the parsed field.
  return rows.sort(newestFirst);
}

async function loadRow(
  input: RoomListingInput,
  candidate: Candidate,
  deadline: number,
): Promise<RoomSessionRow | undefined> {
  if (candidate.title !== undefined)
    return {
      sessionId: candidate.sessionId,
      cwd: input.repoRoot,
      title: candidate.title,
      updatedAt: candidate.updatedAt,
    };
  const read = await readSession(candidate.sessionId, input.repoRoot, sharingBudgetLeft(deadline));
  if (read.kind === "loaded")
    return {
      sessionId: candidate.sessionId,
      cwd: input.repoRoot,
      title: roomSessionTitle(read.session),
      updatedAt: read.session.updatedAt,
    };
  reportFailure(input, candidate.sessionId, read, "transcript");
  return undefined;
}

/** The compiler's proof that every verdict below is spelled out; unreachable at run time. */
function assertNever(value: never): never {
  throw new Error(`unhandled listing verdict: ${JSON.stringify(value)}`);
}

/**
 * Says WHY a room is missing from the list, in the words that fit the actual fact. Three verdicts are
 * deliberately silent: a room whose transcript vanished between the readdir and now, and the two the
 * marker read answers with when there is nothing wrong.
 *
 * The `unreadable` wording splits on the error code, because only a sharing violation was ever retried.
 * Telling an operator that an EISDIR "could not be read even after retrying a file-sharing conflict"
 * and would "return once the holder releases it" described a wait that never happened and a holder that
 * does not exist — the failure came back in 18 ms (codex cross-check, UNREADABLE_DIRECTORY).
 *
 * The union is taken WHOLE rather than as a widened shape, so a fifth verdict added to either outcome
 * type fails to compile here instead of silently going unreported.
 */
function reportFailure(
  input: RoomListingInput,
  sessionId: string,
  outcome: TranscriptFailure | RoomMarkerOutcome,
  what: "transcript" | "marker",
): void {
  const prefix = `zer0: room ${sessionId} is left out of the room list because its ${what}`;
  switch (outcome.kind) {
    case "absent":
    case "marked":
    case "not-a-room":
      return;
    case "unreadable":
      input.report(
        isTransientReplaceError({ code: outcome.code })
          ? `${prefix} could not be read even after retrying a file-sharing conflict: ${outcome.reason}. The file is untouched and the room returns once the holder releases it`
          : `${prefix} could not be read: ${outcome.reason}. The file is untouched`,
      );
      return;
    case "damaged":
      input.report(`${prefix} is not a readable document: ${outcome.reason}`);
      return;
    case "incompatible":
      input.report(
        `${prefix} is intact but is not this room: ${outcome.reason}. Nothing was moved or changed`,
      );
      return;
    default:
      assertNever(outcome);
  }
}

/** Runs `work` over `items` at most READ_WIDTH at a time, preserving input order in the result. */
async function mapBounded<TIn, TOut>(
  items: readonly TIn[],
  work: (item: TIn) => Promise<TOut>,
): Promise<readonly TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(READ_WIDTH, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  });
  await Promise.all(workers);
  return results;
}
