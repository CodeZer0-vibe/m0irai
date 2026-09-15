/**
 * @file src/chat/lane-carrier-briefing.ts
 * @purpose The carrier's briefing path and its ONE degradation rule: every way the briefing can fail
 *   is caught at its own call site, classified, recorded durably, and turned into a value the turn
 *   carries on — never a throw that takes the lane down, and never silence.
 * @exports RaisedNotice, NoticeOrigin, NoticePublisher, safely, composeCarrierBriefing, publishNotices
 * @depends ../memory/briefing, ../memory/request-files, ../memory/router, ../shared/room-notice, ./lane-carrier, ./memory-failure-log, ./types
 *
 * Lifted out of lane-carrier.ts (lane MN) for the reason that file has been split twice before — it
 * crossed the 600-line hard ceiling, and a ratchet is answered by extraction, never by raising the
 * limit. The seam is the one lane-acquire.ts and lane-carrier-cancel-send.ts already established:
 * take a whole STEP of the turn, not a bag of helpers.
 *
 * The `PromptInput`/`TraceBus` back-edge to lane-carrier.ts is TYPE-ONLY and therefore erased at
 * compile time — the same shape .dependency-cruiser.cjs's no-circular rule already tolerates for the
 * cockpit-turn-exec type back-edges, and the reason that rule is scoped to runtime cycles.
 */
import { composeBriefing } from "../memory/briefing.js";
import { extractRequestFiles } from "../memory/request-files.js";
import { selectBriefingPulls } from "../memory/router.js";
import {
  type RoomNotice,
  type RoomNoticeCause,
  boundRoomNoticeDetail,
} from "../shared/room-notice.js";
import type { PromptInput, TraceBus } from "./lane-carrier.js";
import { recordMemoryFailure } from "./memory-failure-log.js";
import type { AgentName } from "./types.js";

/** The mutable list one composition appends its classified failures to. */
export type RaisedNotice = RoomNotice[];

/**
 * Exactly what a degrading read needs to know: who the failure is attributed to, and where the
 * durable log lives.
 *
 * Narrower than `PromptInput` on purpose. A function that declares a whole carrier turn in order to
 * read two fields cannot be exercised without building one, which is how a test ends up asserting
 * against its fixture instead of against the behaviour. `PromptInput` satisfies this structurally,
 * so every real call site is unchanged.
 */
export interface NoticeOrigin {
  readonly agent: AgentName;
  readonly binding: { readonly cwd: string };
}

/** {@link NoticeOrigin} plus the two things publishing needs: the turn, and somewhere to publish. */
export interface NoticePublisher extends NoticeOrigin {
  readonly turn: number;
  readonly trace?: TraceBus;
}

/**
 * THE ONE DEGRADATION PRIMITIVE for the briefing path. Runs `read`, and on ANY throw classifies the
 * failure by WHICH CALL SITE broke — never by parsing the message text — records it durably, adds it
 * to this turn's raised notices, and returns `fallback` so the turn goes on without a briefing rather
 * than dying with one.
 *
 * R5b-05 (M1 review) established that composeBriefing's fail-closed byte assertion must degrade
 * rather than kill the lane. The gap this closes is that the assertion was the ONLY thing wrapped:
 * `getLaneCursor` ran before the try and `extractRequestFiles` sat outside it, so those two threw
 * straight through the carrier and took the turn with them. Same rule at every door now.
 *
 * @param input - the composition this failure belongs to (names the agent and the log's root)
 * @param raised - this composition's notice list, appended in place
 * @param cause - the classification, fixed by the call site rather than read off the error
 * @param read - the operation that may throw
 * @param fallback - what the turn uses instead
 */
export function safely<T>(
  input: NoticeOrigin,
  raised: RaisedNotice,
  cause: RoomNoticeCause,
  read: () => T,
  fallback: T,
): T {
  try {
    return read();
  } catch (error) {
    const detail = boundRoomNoticeDetail(error);
    raised.push({ cause, agent: input.agent, detail });
    if (recordMemoryFailure(input.binding.cwd, cause, error)) return fallback;
    // The durable log is the only place the DETAIL of a failure survives. When even that write is
    // refused, the fail-soft record has gone fail-SILENT, and that is its own announceable condition
    // rather than something to swallow at the bottom of the stack.
    raised.push({ cause: "memory-failure-log-unwritable", agent: input.agent, detail });
    return fallback;
  }
}

export function composeCarrierBriefing(
  input: PromptInput,
  raised: RaisedNotice,
  carry: boolean,
  now: string,
): ReturnType<typeof composeBriefing> | undefined {
  if (!carry) return undefined;
  // MT6a-completion W0: carrier briefings pull file-relevant peer/ledger decisions named by the live
  // operator message (the same router the buffered path wires; empty extraction = no pulls). Its own
  // failure degrades to NO PULLS rather than to no briefing: losing the router's extras is a much
  // smaller loss than losing the briefing they were going to decorate.
  const requestFiles = safely(
    input,
    raised,
    "memory-request-files-failed",
    () => extractRequestFiles(input.operatorMessage),
    [] as readonly string[],
  );
  return safely(
    input,
    raised,
    "memory-compose-failed",
    () =>
      composeBriefing({
        db: input.db,
        projectId: input.projectId,
        agent: input.agent,
        now,
        // K1 (operator decision, 2026-08-18): framed recall is restored on the carrier path too. The
        // safe-body filter and the untrusted framing both stay; only the operator-only clamp goes.
        operatorOnly: false,
        pulls:
          requestFiles.length > 0
            ? selectBriefingPulls({
                db: input.db,
                projectId: input.projectId,
                forAgent: input.agent,
                requestFiles,
              })
            : [],
      }),
    undefined,
  );
}

/**
 * Hands each classified failure to whoever is listening, at the moment of classification.
 *
 * NOT gated by `debugEnabled()`, unlike the carrier's memory traces: a trace is diagnostics an
 * operator opted into, while this is the room learning that its briefing is gone. A notice that only
 * exists under a debug flag is the silence this whole path was built to end.
 */
export function publishNotices(input: NoticePublisher, raised: readonly RoomNotice[]): void {
  for (const notice of raised) {
    input.trace?.emit({
      kind: "room.notice",
      cause: notice.cause,
      turn: input.turn,
      ...(notice.agent === undefined ? {} : { agent: notice.agent }),
      detail: notice.detail,
    });
  }
}
