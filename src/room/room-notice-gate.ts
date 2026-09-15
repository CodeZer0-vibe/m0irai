/**
 * @file src/room/room-notice-gate.ts
 * @purpose Decide whether a non-fatal room notice becomes a transcript row: the FIRST occurrence of
 *   each cause in a session does, every later one is counted and stays quiet.
 * @exports RoomNoticeGate
 * @depends ../shared/room-notice, ./room-engine-contract
 *
 * THE SHAPE IS TAKEN FROM UPSTREAM GROK, deliberately. `EphemeralTipState::show`
 * (D:/grok-ref/crates/codegen/xai-grok-pager/src/tips/ephemeral.rs:96-125) gates a notice against a
 * per-session `seen_counts: HashMap<&'static str, u32>` whose own doc says the count "lives only in
 * `AppView::tip_seen_counts` (per session, never on disk)". Same rule here, with one difference the
 * room forces: our notices are DURABLE transcript rows, so "per session" has to survive a reload of
 * that session. The map is still never persisted as a map — it is rebuilt from the journal, which is
 * the only thing that actually knows what this session already showed. Persisting the counter
 * separately would give the room a second source of truth about its own transcript, and the two
 * would disagree the first time a journal write failed.
 */
import type { RoomNotice } from "../shared/room-notice.js";
import type { RoomEvent } from "./room-engine-contract.js";

export class RoomNoticeGate {
  private readonly occurrences = new Map<string, number>();

  /**
   * Seeds the gate from an already-loaded room journal, so a reload does not re-announce what the
   * operator has already been shown. Every `room.notice` in the journal is, by this gate's own rule,
   * the FIRST occurrence of its cause — later ones were never written.
   *
   * @param events - the rehydrated journal, in event order
   */
  public rehydrate(events: readonly RoomEvent[]): void {
    for (const event of events) {
      if (event.type !== "room.notice") continue;
      const cause = event.payload.cause;
      if (typeof cause !== "string" || cause.length === 0) continue;
      this.occurrences.set(cause, (this.occurrences.get(cause) ?? 0) + 1);
    }
  }

  /**
   * Records one occurrence and, for the first of its cause, projects the wire payload to emit.
   *
   * Counting happens on EVERY call, including the ones that answer `undefined`: "this failed four
   * more times after we said so" is the fact a reader wants, and it is lost the moment the gate
   * returns early. The row itself stays single — that is the whole point of the gate.
   *
   * The projection lives here rather than at the emit site so that "which fields cross the wire" is
   * decided in one place: an absent agent is OMITTED, never sent as an explicit undefined that the
   * envelope's exact-key check would then reject.
   *
   * @param notice - the classified condition
   * @returns the payload to emit, or undefined when this cause has already been announced
   */
  public admit(notice: RoomNotice): Readonly<Record<string, unknown>> | undefined {
    const seen = this.occurrences.get(notice.cause) ?? 0;
    this.occurrences.set(notice.cause, seen + 1);
    if (seen > 0) return undefined;
    return {
      cause: notice.cause,
      ...(notice.agent === undefined ? {} : { agent: notice.agent }),
      detail: notice.detail,
    };
  }

  /** How many times this session has seen `cause`, announced or not. */
  public occurrencesOf(cause: string): number {
    return this.occurrences.get(cause) ?? 0;
  }
}
