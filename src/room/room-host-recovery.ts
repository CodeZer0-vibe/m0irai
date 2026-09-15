/**
 * @file src/room/room-host-recovery.ts
 * @purpose Reconcile a loaded room journal against the evidence ledger at boot and apply the repaired
 *   state through capacity-checked writes; extracted from AliveRoomHost when it crossed the hard clamp.
 * @exports reconcileRoomRecovery, RoomRecoveryOwner
 * @depends node:crypto, ../chat/lane-transport, ../chat/types, ../shared/room-notice, ./room-engine-capacity, ./room-engine-contract, ./room-recovery
 */
import { randomUUID } from "node:crypto";
import { persistenceOwnerFor } from "../chat/lane-transport.js";
import type { ChatSession } from "../chat/types.js";
import type { Db } from "../evidence/db.js";
import { MAX_ROOM_NOTICE_DETAIL_CODE_POINTS } from "../shared/room-notice.js";
import { applyCapacityCheckedRecovery } from "./room-engine-capacity.js";
import type { RoomEvent } from "./room-engine-contract.js";
import { recoverRoomState } from "./room-recovery.js";

/** The ledger this room's persistence is bound to; `undefined` means no carrier runtime owns this db. */
export type RoomRecoveryOwner = Readonly<{ db: Db; projectId: string }> | undefined;

/**
 * The wire's cause vocabulary is open (`src/shared/room-notice.ts`'s closed `RoomNoticeCause` union is a
 * DIFFERENT, narrower thing: the set the room-side `RoomNotice`/`RoomNoticeGate` API accepts), so this
 * cause needs no addition there — `validateRoomNoticePayload` only requires a bounded, safe, nonempty
 * string. A terminal build that has no phrase for it renders the generic unknown-cause row (by design,
 * see `notice_phrase` / `push_room_notice` in room_scrollback.rs) rather than dropping the event.
 */
const ROOM_REBUILT_NOTICE_CAUSE = "room-rebuilt-from-ledger";

/**
 * Ids present in `after` that were absent from `before` — the CONTENT delta recovery actually restored,
 * never reference identity. `mergeTranscript` (./room-recovery.ts:180-190) always returns a FRESH array,
 * even when nothing changed, so `repaired.session.messages === input.session.messages` is never true on
 * mainline and cannot answer "did anything change" (SEAM-1,
 * D:/m0irai-evidence/wave1/lanes-0901/sl-review-r3.md:26-70).
 */
function restoredMessageCount(before: ChatSession, after: ChatSession): number {
  const beforeIds = new Set(before.messages.map((message) => message.id));
  return after.messages.filter((message) => !beforeIds.has(message.id)).length;
}

/** The next event's sequence number, continuing whatever `journal` already ends on. */
function nextEventSeq(journal: readonly RoomEvent[]): string {
  const last = journal.at(-1)?.eventSeq;
  return (BigInt(last ?? "0") + 1n).toString();
}

/**
 * The "room was rebuilt" notice for one boot's reconciliation. `detail` carries the full operator
 * sentence (never just a diagnostic fragment) because a terminal that does not yet recognize
 * {@link ROOM_REBUILT_NOTICE_CAUSE} still journals this durably and legibly, and a future terminal build
 * that renders `detail` for an unrecognized cause shows the right words with no further wiring.
 */
function roomRebuiltNotice(
  sessionId: string,
  restored: number,
  journal: readonly RoomEvent[],
): RoomEvent {
  const sentence = `zer0: room ${sessionId} was rebuilt from the evidence ledger: ${restored} messages restored to its transcript.`;
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId,
    eventSeq: nextEventSeq(journal),
    eventId: `room-recovery-notice-${randomUUID()}`,
    turnId: "room-recovery",
    occurredAt: new Date().toISOString(),
    type: "room.notice",
    payload: {
      cause: ROOM_REBUILT_NOTICE_CAUSE,
      detail: [...sentence].slice(0, MAX_ROOM_NOTICE_DETAIL_CODE_POINTS).join(""),
    },
  };
}

/**
 * Repairs `journal` against the ledger owned by `dbPath` (drift repair announces itself downstream) and
 * applies the result: the repaired session is persisted ONLY when recovery produced a different message
 * list, and every appended event — including the rebuild notice below, when one fires — goes through
 * `appendEvent` after the capacity check. Returns the journal the host must rehydrate from. With no
 * owner the journal is returned untouched and nothing is written.
 *
 * A healthy attach and a brand-new room restore nothing (`restoredMessageCount` is 0) and get no notice;
 * a rebuild that restores zero messages is Sentence B's territory (declared, not built here — see the
 * brief) and also gets no notice from this function.
 */
export async function reconcileRoomRecovery(
  input: Readonly<{
    dbPath: string;
    blobRoot: string;
    session: ChatSession;
    journal: readonly RoomEvent[];
    /** Swap the host's session for the repaired one and persist it, serialized with other session writes. */
    persistSession: (session: ChatSession) => Promise<void>;
    appendEvent: (event: RoomEvent) => Promise<void>;
  }>,
  owner: RoomRecoveryOwner = persistenceOwnerFor(input.dbPath),
): Promise<readonly RoomEvent[]> {
  if (owner === undefined) return input.journal;
  const repaired = recoverRoomState({
    db: owner.db,
    projectId: owner.projectId,
    session: input.session,
    blobRoot: input.blobRoot,
    journal: input.journal,
  });
  const restored = restoredMessageCount(input.session, repaired.session);
  const notice =
    restored > 0 ? roomRebuiltNotice(input.session.id, restored, repaired.journal) : undefined;
  const journal = notice === undefined ? repaired.journal : [...repaired.journal, notice];
  const appended = notice === undefined ? repaired.appended : [...repaired.appended, notice];
  await applyCapacityCheckedRecovery({
    journal,
    appended,
    ...(repaired.session.messages === input.session.messages
      ? {}
      : { persistSession: () => input.persistSession(repaired.session) }),
    appendEvent: input.appendEvent,
  });
  return journal;
}
