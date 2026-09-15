/**
 * @file src/shared/room-notice.ts
 * @purpose The room's non-fatal notice vocabulary — the CLOSED cause set this host may announce, and
 *   the bound every notice detail is held to before it can reach the wire or the durable journal.
 * @exports ROOM_NOTICE_CAUSES, RoomNoticeCause, RoomNotice, MAX_ROOM_NOTICE_DETAIL_CODE_POINTS,
 *   isRoomNoticeCause, boundRoomNoticeDetail
 * @depends ./render-escape, ./types/branded
 *
 * WHY `src/shared` AND NOT `src/room`. Two layers need this vocabulary and only one of them may
 * import the other: `src/chat` CLASSIFIES a failure (the carrier knows which call site broke) and
 * `src/room` EMITS it (the engine owns the protocol and the dedup). `src/chat` importing `src/room`
 * would invert the room's ownership of the wire, so the shared bottom layer holds the words both use.
 *
 * WHY THE CAUSE IS CLOSED HERE AND OPEN ON THE WIRE. This host may only ever announce a cause it has
 * a phrase for, which is what the union below enforces at every emission site. The WIRE deliberately
 * accepts any bounded, safe, nonempty cause string: an OLDER terminal reading a NEWER host must
 * render the notice generically rather than reject the event and lose a row the operator needs (see
 * `notice_phrase` in room_scrollback.rs). A closed wire enum would turn forward compatibility into a
 * dropped event, which is the opposite of the fail-soft rule this whole notice exists to serve.
 */
import { escapeUntrusted } from "./render-escape.js";
import type { AgentName } from "./types/branded.js";

/**
 * Every non-fatal condition this host knows how to announce. Adding a member here is HALF the change:
 * the other half is the fixed phrase in `notice_phrase` (rust/crates/codegen/xai-grok-pager/src/
 * room_scrollback.rs). A member without a phrase renders as the generic unknown-cause row.
 *
 * The first six are the memory-briefing failure sites, one per place the briefing path can break —
 * classification is by WHICH CALL SITE THREW, never by parsing the error's message text.
 */
export const ROOM_NOTICE_CAUSES = [
  "memory-db-open-failed",
  "memory-project-resolve-failed",
  "memory-compose-failed",
  "memory-cursor-failed",
  "memory-request-files-failed",
  "memory-failure-log-unwritable",
  "agy-conversation-lost",
] as const;

export type RoomNoticeCause = (typeof ROOM_NOTICE_CAUSES)[number];

/**
 * The detail bound, in CODE POINTS rather than bytes, because both halves of the protocol must agree
 * on the number and only code points count identically in JSON Schema `maxLength`, JavaScript's
 * string iterator, and Rust's `char` iterator. It is deliberately small: the detail is diagnostic
 * text for the journal, never something the room paints.
 */
export const MAX_ROOM_NOTICE_DETAIL_CODE_POINTS = 200;

/**
 * One announceable condition. `detail` is the diagnostic string that reaches the journal and the
 * failure log; it is NEVER painted, because it carries provider/error text this room does not own.
 */
export interface RoomNotice {
  readonly cause: RoomNoticeCause;
  readonly agent?: AgentName;
  readonly detail: string;
}

export function isRoomNoticeCause(value: unknown): value is RoomNoticeCause {
  return (ROOM_NOTICE_CAUSES as readonly string[]).includes(value as string);
}

/**
 * Turns an arbitrary thrown value into a detail string that is safe to journal and bounded to
 * {@link MAX_ROOM_NOTICE_DETAIL_CODE_POINTS} code points.
 *
 * Total by construction: `escapeUntrusted` never throws for any `unknown`, and an input that
 * collapses to nothing still yields a nonempty result — the wire requires `detail` to be present
 * and nonempty, so a silent empty string here would turn a fail-soft notice into a rejected event.
 *
 * @param error - the thrown value (an Error, or anything at all)
 * @returns a single-line, control-free, bounded detail string
 */
export function boundRoomNoticeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : error;
  const escaped = escapeUntrusted(raw, { maxLen: 2048 }).replace(/\s+/gu, " ").trim();
  const clipped = [...escaped].slice(0, MAX_ROOM_NOTICE_DETAIL_CODE_POINTS).join("");
  return clipped.length > 0 ? clipped : "no detail reported";
}
