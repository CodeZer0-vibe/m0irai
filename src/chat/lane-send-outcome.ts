/**
 * @file src/chat/lane-send-outcome.ts
 * @purpose What ONE held send's ending means — including the ending the lane could not read: a turn
 *   that delivered the vendor's usage-limit sentence as ordinary assistant text and then closed with a
 *   stop reason that is not `end_turn`. Owns the bounded per-turn text recorder and the failure-reason
 *   classification for both endings a send has (a stop reason, or a rejection).
 * @exports TurnTextRecorder, createTurnTextRecorder, errorMessage, laneFailureReason, sendStopOutcome, sendRejectedOutcome
 * @depends ./lane-availability
 *
 * WHY THIS IS ITS OWN FILE. `lane-hold.ts` owns a connection's lifecycle — open, hold, supersede,
 * close — and is at its size ceiling. "What did this turn deliver and what does that say about the
 * lane" is a different question with no lifecycle in it, and it is pure enough to test directly.
 * The ratchet only falls: this is the extraction, not a raised limit.
 */
import { classifyLaneFailure } from "./lane-availability.js";

/**
 * How much of a turn's delivered text the classifier keeps, and why it is the TAIL.
 *
 * A limit or refusal notice is what ENDS a turn — it either is the whole reply (the operator's codex
 * row at 15:20 was nothing else) or it follows whatever the agent managed to say first. Keeping the
 * head would therefore be the one policy guaranteed to miss it on a long turn. Bounded at all because
 * this string is classified on a path that also reaches the lane's error field, and an agent reply has
 * no length limit worth trusting.
 */
const KEPT_TEXT_CHARS = 1_000;

/** A send's failure reason as the carrier's FailureReason enum names it. */
export type SendFailureReason = "quota" | "auth" | "transport";

/**
 * How many generations' buffers are kept at once. Each is bounded by {@link KEPT_TEXT_CHARS}, so the
 * whole recorder is bounded by the product — a few kilobytes for the life of a chat mount.
 *
 * Generations only accumulate while their turns are OPEN, and a lane runs one turn at a time, so in
 * practice at most one or two are live: the held connection's turn, plus a superseded connection still
 * draining. The cap exists because nothing in this module can PROVE that, not because the ordinary case
 * needs it. Eviction is oldest-first, and the cost of being wrong is that a very old draining turn
 * classifies as `transport` — the behaviour before any of this existed.
 */
const MAX_OPEN_GENERATIONS = 8;

/**
 * The bounded record of what EACH turn delivered, kept per connection GENERATION. {@link sinkFor}
 * builds the `onText` a connection is opened with: it forwards every chunk to the real consumer
 * unchanged and keeps a copy, so the string the classifier reads is by construction the same string the
 * operator's row was filled from.
 *
 * ITEM E, AND WHAT THE DELTA ROUND CHANGED ABOUT IT.
 *
 * One recorder is created per transport and lives for the whole chat mount, while connections come and
 * go: a cancel drops the hold, the self-heal drops a dead bridge session, a supersession refuses a
 * stale open. Every one of those connections captured its `onText` ONCE at open and holds that
 * reference for its whole life — so an OLD connection whose child has not finished dying, or whose
 * buffered chunk was already on the wire, used to deliver straight into the recorder while a DIFFERENT
 * connection was mid-turn. That text then read as turn N+1's ending and could classify it: the review
 * reproduced `reason: "quota"` from a chunk belonging to a connection that was already closed.
 *
 * The first fix for that was a single live-generation bit — whoever holds the lane records, everyone
 * else is muted — and it over-guarded. ACP keeps an in-flight prompt's `onText` installed until the
 * call's own `finally`, so a connection whose turn has NOT settled is still legitimately delivering;
 * muting it the instant a newer connection claimed the lane threw away the one sentence that says the
 * account is spent, and kept it off the operator's row as well.
 *
 * SO THE QUESTION IS NOT WHO OWNS THE LANE, IT IS WHOSE TURN IS STILL OPEN. Each generation records
 * into its own buffer between its own {@link begin} and {@link end}, and each turn classifies from its
 * own. A settled turn's late chunk is stale and goes nowhere; an unsettled turn's chunk is its own,
 * whoever else has since claimed the lane. A connection that never wins a hold never has a turn begun
 * on it, so it still records nothing at all.
 */
export interface TurnTextRecorder {
  /** The `onText` for the connection opened under `generation`. Forwards and records only while that
   *  generation has an OPEN turn; before its first `begin` and after its `end`, chunks go nowhere. */
  readonly sinkFor: (generation: number) => (chunk: string) => void;
  /** Open a turn on `generation`. Called immediately before `prompt()`, so text from an earlier turn on
   *  the same held connection can never be read as this turn's ending. */
  readonly begin: (generation: number) => void;
  /** Close the turn on `generation`. Called once the send has been classified — see the caller's own
   *  note on why `finally` still lets `delivered` read it first. */
  readonly end: (generation: number) => void;
  /** The tail of what `generation`'s current turn delivered, at most {@link KEPT_TEXT_CHARS}
   *  characters, or the empty string when that generation has no open turn. */
  readonly delivered: (generation: number) => string;
}

export function createTurnTextRecorder(forward?: (chunk: string) => void): TurnTextRecorder {
  // Keyed by generation, INSERTION-ORDERED, which is what makes oldest-first eviction the right one:
  // generations are handed out by an increasing counter, so the first key inserted is the lowest.
  const open = new Map<number, string>();
  return {
    sinkFor:
      (generation: number) =>
      (chunk: string): void => {
        const kept = open.get(generation);
        if (kept === undefined) return; // no turn open on this connection: not its text to record
        forward?.(chunk);
        open.set(generation, (kept + chunk).slice(-KEPT_TEXT_CHARS));
      },
    begin: (generation: number): void => {
      open.set(generation, "");
      while (open.size > MAX_OPEN_GENERATIONS) {
        const oldest = open.keys().next();
        if (oldest.done === true) break;
        open.delete(oldest.value);
      }
    },
    end: (generation: number): void => {
      open.delete(generation);
    },
    delivered: (generation: number): string => open.get(generation) ?? "",
  };
}

/**
 * The first of `texts` that classifies as a death decides; nothing classifying is an ordinary
 * transport failure, which must NOT mark a lane dead.
 *
 * STRUCTURED TEXT ONLY. Every caller now passes a diagnostic produced by the transport — a stop-reason
 * string or a rejection message — never the agent's own prose. Prose used to be passed here as a
 * trailing argument and that was F3: this function reads the full death vocabulary, which includes the
 * bare words `quota`, `insufficient` and `rate limit`, and those are ordinary English in an agent's
 * answer. What the agent typed is now read by {@link proseFailureReason} against a much narrower list.
 *
 * UPSTREAM, and the deviation. grok reaches for the same fallback: when the out-of-band rate-limit
 * notification loses its race with the response, it detects the limit from the response itself —
 * "if the retry notification lost the race with (or never reached) this PromptResponse, detect the
 * free-usage code from the prompt error itself" (`D:/grok-ref/crates/codegen/xai-grok-pager/src/app/
 * dispatch/prompt.rs:1224-1232`), and again for credit limits at :1252-1258. DEVIATION: grok reads it
 * off the ERROR, because it talks to the xAI API directly and gets an HTTP status plus a well-known
 * code (`xai-grok-shell/src/sampling/error.rs:34-45`'s `subscription:free-usage-exhausted`). The codex
 * bridge hands us no error and no status for this — the turn LOOKS successful — so the only surviving
 * carrier of the fact is the text, and that is what this reads. Same principle (fall back to the
 * payload the turn actually produced), the only channel this transport leaves open.
 */
export function laneFailureReason(...texts: readonly string[]): SendFailureReason {
  for (const text of texts) {
    const classified = classifyLaneFailure(text);
    if (classified?.class === "exhausted") return "quota";
    if (classified?.class === "needs_auth") return "auth";
  }
  return "transport";
}

/**
 * A send that RETURNED. `end_turn` is the only accepting stop reason; every other value is a failure,
 * and its death class — if it has one — is in what the turn delivered rather than in the stop reason.
 *
 * THE STOP REASON IS NOT THE SIGNAL, deliberately. `max_tokens` and `max_turn_requests` are ordinary
 * truncations that must leave the lane READY; treating "not end_turn" as a death would take a lane
 * offline for the fallback cooldown every time a long answer hit its ceiling. `message` stays the bare
 * diagnostic and never carries the agent's text: it is also what `isSessionEndedFailure` reads to
 * decide whether to drop a held connection, and a reply that merely mentioned starting a new session
 * would then respawn a healthy bridge.
 */
export function sendStopOutcome(
  stopReason: string,
  delivered: string,
):
  | { readonly outcome: "accepted" }
  | { readonly outcome: "failed"; readonly reason: SendFailureReason; readonly message: string } {
  if (stopReason === "end_turn") return { outcome: "accepted" as const };
  const message = `stopReason=${stopReason}`;
  const structured = laneFailureReason(message);
  if (structured !== "transport")
    return { outcome: "failed" as const, reason: structured, message };
  return { outcome: "failed" as const, reason: proseFailureReason(stopReason, delivered), message };
}

/**
 * The SDK's own words for the two endings that mean TRUNCATION rather than refusal:
 * `max_tokens` is "the turn ended because the agent reached the maximum number of tokens" and
 * `max_turn_requests` is "the turn ended because the agent reached the maximum number of allowed
 * agent requests between user turns" (`@agentclientprotocol/sdk/schema/schema.json`, `StopReason`).
 * Neither can mean "this account is spent", and a truncated answer is the likeliest place of all to
 * find a half-finished sentence about rate limits.
 */
const TRUNCATION_STOP_REASONS: ReadonlySet<string> = new Set(["max_tokens", "max_turn_requests"]);

/**
 * The ONLY vocabulary read out of what the AGENT TYPED — deliberately much narrower than the death
 * words a transport diagnostic is read with.
 *
 * F3, and it was a real hole rather than a theoretical one. Offering a turn's delivered text to the
 * classifier is the right idea (it is the only surviving carrier of a codex limit notice), but running
 * it through the whole `EXHAUSTED_PATTERN` put the bare words `quota`, `insufficient` and `rate limit`
 * against arbitrary agent prose. Three ordinary answers matched — "the endpoint returns 429 when you
 * exceed the rate limit", "insufficient space on D:", "the connection quota for that pool is 20" —
 * and any one of them would have locked the lane out for FALLBACK_COOLDOWN_MS. In a repo whose own
 * source discusses rate limits at length, that is an ordinary Tuesday, not an edge case.
 *
 * These phrases are the vendor's actual limit vocabulary and are not things an agent says by
 * accident while explaining something.
 *
 * ITEM D — `out of credits`, the spend cap and the credit limit, VERIFIED in the bytes this repo
 * installs rather than taken from a review's word. Searched in the native binary of our pinned
 * @openai/codex 0.153.4,
 * `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`, with
 * `grep -a -b -o -F`. Offsets re-derived on the 0.153.4 binary at the 0.147.0 → 0.153.4 bump; every
 * sentence below still ships. The vendor's whole limit sentence table, dumped from those bytes:
 *   234332692  "Your workspace is out of credits. Add credits to continue."
 *   234332750  "Your workspace is out of credits. Ask your workspace owner to refill in order to
 *               continue."
 *   234332840  "You hit your spend cap set in your workspace. Increase your spend cap to continue."
 *   234332922  "You hit your spend cap set by the owner of your workspace. Ask an owner to increase
 *               your spend cap to continue."
 *   236066135  "You've reached your workspace credit limit"
 *   236066177  "Your workspace is out of credits. Ask your workspace owner to add more."
 *   236066262  "Usage limit reached" / 234333034 "You've hit your usage limit."
 *
 * These are a DIFFERENT death from `usage limit`: a spent workspace balance, not a rate window. Both
 * mean "this lane cannot work right now", which is the only thing this function decides.
 *
 * DELTA ITEM 3 — MATCH THE SENTENCE SHAPE, NEVER THE NOUN. The first pass matched a bare `spend cap`
 * and the review reproduced the predictable result: "I cannot help you bypass the workspace spend
 * cap." — an ordinary safety refusal, which is a non-`end_turn` ending and therefore goes straight
 * through this door — classified as quota and locked a healthy lane out for the fallback cooldown.
 * An agent DISCUSSING a limit uses the bare noun; the vendor REPORTING one always anchors it with a
 * verb or a possessive (`hit your spend cap`, `out of credits`, `reached your ... credit limit`), and
 * every string in the table above carries such an anchor. So requiring one costs no real detection.
 * The same rule already governs `credit` and `cap` alone ("give the reviewer credit", "a hard cap of
 * 1000 characters"), which is the F3 mistake this list exists to avoid repeating.
 */
const AGENT_LIMIT_PHRASE =
  /usage limit|hit your usage|out of (usage )?credits|usage credits|credit limit|hit your spend cap/i;

/**
 * THE RULE, stated once: what the agent TYPED can only ever mean one death — "this lane is out of
 * usage" — and only when the turn did not end in a documented truncation.
 *
 * WHY NOT `refusal` ALONE, which is the narrowest possible gate: the stop reason the codex bridge
 * really sends for a rate-limited turn is UNVERIFIED (it needs a live bridge at its limit, which is
 * operator-gated). `refusal` is the only value whose SDK definition — "the turn ended because the
 * agent refused to continue" — fits, but naming it as the sole trigger would bet the entire detection
 * on an unverified vendor value: if the bridge actually sends something else, codex-out-of-usage goes
 * silently undetected again and the operator is back where B started. Excluding the two endings the
 * SDK DEFINES as truncations is the same protection without the bet, because it rests on documented
 * meaning rather than on a guess about which value arrives.
 */
function proseFailureReason(stopReason: string, delivered: string): SendFailureReason {
  if (TRUNCATION_STOP_REASONS.has(stopReason)) return "transport";
  return limitPhraseReason(delivered);
}

/** THE ONE DOOR the agent's own text goes through, on BOTH endings. Extracted so a rejection and a
 *  stop reason cannot end up reading prose with two different vocabularies — the whole point of the
 *  narrowing is that there is exactly one list, and a second caller is exactly how a second list
 *  appears. A rejection has no stop reason, so it has no truncation layer to apply and reaches this
 *  directly. */
function limitPhraseReason(delivered: string): SendFailureReason {
  return AGENT_LIMIT_PHRASE.test(delivered) ? "quota" : "transport";
}

/** The text of a thrown cause. Lives here because this module is where a failure becomes words, and the
 *  hold's open/resume/send paths all need the same reading of one. (There are four more copies of this
 *  three-line function elsewhere in the tree — consolidating the rest is its own change, not this one.) */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The vendor-shaped `data` a JSON-RPC rejection may carry, read DEFENSIVELY.
 *
 * `RequestError` declares `data` as an untyped public field
 * (`@agentclientprotocol/sdk/dist/jsonrpc.js:975-989`) and the client re-raises the error with it
 * intact — `new RequestError(code, message, data)` (:843-844). Nothing validates its shape: an
 * ordinary `Error` has no `data` at all, a different bridge may put anything there, and a future
 * codex version may rename the fields. So every read here is a shape CHECK, never a cast: absence,
 * the wrong type, a nested object, a hostile value — all of them fall through to the next rung
 * rather than throwing or classifying a death on a shape nothing recognised.
 */
function rejectionData(cause: unknown): {
  readonly codexErrorInfo?: string;
  readonly message?: string;
} {
  // `Object.hasOwn`, not `in`: `RequestError` assigns `this.data = data` in its constructor
  // (`@agentclientprotocol/sdk/dist/jsonrpc.js:975-989`), so on every real producer this is an OWN
  // field. Reading through the prototype chain would let anything that merely INHERITS a `data`
  // property reach the strongest rung on this ladder.
  if (!(cause instanceof Error) || !Object.hasOwn(cause, "data")) return {};
  // `Object.hasOwn` proves the field is there but does not narrow the type the way `in` did, and the
  // field is genuinely absent from `Error` — so the read is declared optional rather than asserted.
  const data: unknown = (cause as { readonly data?: unknown }).data;
  if (!isPlainRecord(data)) return {};
  return {
    ...ownStringField(data, "codexErrorInfo"),
    ...ownStringField(data, "message"),
  };
}

/**
 * DELTA ITEM 6 — WHAT "A JSON RECORD" MEANS, CHECKED RATHER THAN ASSUMED.
 *
 * `typeof data === "object" && data !== null` is not a record check. Arrays satisfy it, every class
 * instance satisfies it, and a plain property read on any of them walks the prototype chain — so the
 * review classified `quota` from an array and from an object whose `codexErrorInfo` was inherited.
 *
 * Both shapes the real path produces are plain records: `createTurnErrorData`'s object literal
 * (`@agentclientprotocol/codex-acp/dist/index.js:24105-24115`), built in-process with
 * `Object.prototype`, and a `JSON.parse` of the same thing off the wire. A null prototype is admitted
 * too, because that is what a `JSON.parse` reviver or an explicitly bare record produces and it is
 * strictly SAFER than the default — nothing can be inherited onto it at all.
 *
 * The numeric `RequestError.code` is deliberately NOT required on top of this. It would tighten the
 * door a little further, and it would also mean that a bridge version which renames or drops that
 * field takes codex-out-of-usage back to silent misdetection — the exact regression this ladder was
 * built to end. The shape checks here close the forgeries that were actually reproduced; the field
 * check would trade a real detection risk for a theoretical one.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `key`'s value when the record OWNS it and it is a string — otherwise nothing at all, so an absent,
 *  inherited or wrongly-typed field falls through to the next rung rather than deciding a death. */
function ownStringField<K extends string>(
  record: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  if (!Object.hasOwn(record, key)) return {};
  const value = record[key];
  return typeof value === "string" ? ({ [key]: value } as { [P in K]?: string }) : {};
}

/**
 * The codex bridge's OWN NAME for a spent account, and the reason this rung exists at all.
 *
 * It is an enum produced by the transport, not prose produced by a model — READ WHAT ARRIVES. A
 * vendor that changes its sentence tomorrow keeps this value; a model that mentions usage limits in
 * an answer never has it. It is the strongest signal on this path and therefore the first structured
 * rung. Matched exactly (`@agentclientprotocol/codex-acp/dist/index.js:24077`); a value this does not
 * recognise is not a death, it is an unknown, and unknowns fall through.
 */
const CODEX_USAGE_LIMIT_INFO = "usageLimitExceeded";

/**
 * A send that REJECTED, and the FOUR rungs it is read with, in this order:
 *
 *   1. the rejection's own message, through the full death vocabulary  (transport-produced)
 *   2. `data.codexErrorInfo === "usageLimitExceeded"`                  (transport-produced enum)
 *   3. `data.message`, through the NARROW limit-phrase list            (vendor prose, structured)
 *   4. what the turn DELIVERED, through the same narrow list           (agent prose, streamed)
 *
 * ITEM A, and the sentence this header once carried ("there is one text to read and no
 * delivered-text fallback to reach for") was false about the real codex bridge. Read at the installed
 * bytes: `@agentclientprotocol/codex-acp/dist/index.js:24077-24080` maps `usageLimitExceeded` to
 * `this.failure = RequestError.internalError(this.createTurnErrorData(params.error))` — a THROW, not a
 * stop reason — while the same function still returns the vendor's sentence as an agent text chunk
 * (:24085-24087). `RequestError.internalError(data)` builds its message as the bare string
 * `Internal error` with no suffix (`@agentclientprotocol/sdk/dist/jsonrpc.js:1020-1022`), so rung 1
 * carries nothing about usage and the ONE path a spent codex account actually takes used to classify
 * as `transport` while the lane painted generic offline.
 *
 * WHY RUNGS 2 AND 3 EXIST WHEN RUNG 4 ALREADY WORKED. The same error produces `createTurnErrorData`'s
 * `{ message: additionalDetails ?? message, codexErrorInfo }` (:24105-24115) ON the rejection, while
 * the streamed text arrives as a SEPARATE `session/update` notification. Both travel the same stdio
 * stream in order, but notification handling is `async` (`jsonrpc.js:742`), so "the chunk was
 * processed before the response settled" is reliable and NOT provable. Rungs 2 and 3 arrive attached
 * to the rejection itself and cannot lose that race. Rung 4 stays as the last fallback, for a bridge
 * that carries no structured data at all.
 *
 * THE PROSE VOCABULARY IS NOT WIDENED BY ANY OF THIS. Rungs 3 and 4 both go through
 * {@link limitPhraseReason} — the same narrow AGENT_LIMIT_PHRASE list `sendStopOutcome` uses. Rung 3
 * is structured but its VALUE is `additionalDetails ?? message`, free-form vendor prose, so it earns
 * no more trust than the streamed text does. Only rungs 1 and 2 are read as transport facts.
 *
 * `delivered` defaults to empty so a caller with no recorder (open/resume, which stream no agent
 * text) keeps the message-only reading it always had.
 */
export function sendRejectedOutcome(
  cause: unknown,
  delivered = "",
): {
  readonly outcome: "failed";
  readonly reason: SendFailureReason;
  readonly message: string;
} {
  const message = errorMessage(cause);
  return { outcome: "failed" as const, reason: rejectedReason(cause, message, delivered), message };
}

/** The four-rung ladder of {@link sendRejectedOutcome}, split out so that function stays inside the
 *  parameter and length clamps and so each rung is one readable line. */
function rejectedReason(cause: unknown, message: string, delivered: string): SendFailureReason {
  const structured = laneFailureReason(message);
  if (structured !== "transport") return structured;
  const data = rejectionData(cause);
  if (data.codexErrorInfo === CODEX_USAGE_LIMIT_INFO) return "quota";
  const vendorPhrase = limitPhraseReason(data.message ?? "");
  return vendorPhrase !== "transport" ? vendorPhrase : limitPhraseReason(delivered);
}
