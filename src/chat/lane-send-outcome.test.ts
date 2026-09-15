/**
 * @file src/chat/lane-send-outcome.test.ts
 * @purpose Falsifiers for the two endings a held send has, and for the bounded text recorder that
 *   makes the returned ending readable. The end-to-end proof (a fake codex bridge streaming its real
 *   limit sentence, through the whole lane, to an exhausted chip) is
 *   src/chat/headless-carrier-exhausted.test.ts; this file pins the edges that test cannot reach —
 *   the tail bound, the per-turn reset, and every non-`end_turn` stop reason that must NOT kill a lane.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./lane-send-outcome
 */
import { expect, it } from "vitest";
import { laneFailureReason, sendRejectedOutcome, sendStopOutcome } from "./lane-send-outcome.js";

/** The operator's own codex row at 15:20, verbatim. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";

it("a non-end_turn stop carrying the vendor's limit sentence classifies as quota", () => {
  const outcome = sendStopOutcome("refusal", VENDOR_LIMIT_TEXT);

  expect(outcome.outcome).toBe("failed");
  expect(outcome.outcome === "failed" ? outcome.reason : undefined).toBe("quota");
  // The message stays the BARE diagnostic. It is what isSessionEndedFailure reads to decide whether to
  // drop a live connection, so the agent's prose must never enter it.
  expect(outcome.outcome === "failed" ? outcome.message : undefined).toBe("stopReason=refusal");
});

it("every other non-end_turn stop with an ordinary reply stays transport — a truncation is not a death", () => {
  // THE FALSIFIER FOR THE WHOLE DESIGN. If "not end_turn" were itself the death signal, a long answer
  // clipped at the token ceiling would take the lane offline for the fallback cooldown.
  for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) {
    const outcome = sendStopOutcome(stopReason, "here is the first half of the answer");
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `${stopReason} with an ordinary reply must not mark the lane dead`,
    ).toBe("transport");
  }
});

it("end_turn accepts, whatever the turn said", () => {
  // The other half of the false-positive guard: an agent ANSWERING a question about usage limits ends
  // its turn normally, and a classifier that read text on the accepting path would kill that lane.
  expect(sendStopOutcome("end_turn", VENDOR_LIMIT_TEXT)).toEqual({ outcome: "accepted" });
});

it("a rejection classifies off its own message first, with no text offered at all", () => {
  expect(sendRejectedOutcome("codex exited: out of usage credits").reason).toBe("quota");
  expect(sendRejectedOutcome("please login again — authentication expired").reason).toBe("auth");
  expect(sendRejectedOutcome("ECONNRESET").reason).toBe("transport");
});

it("A: a rejection that says NOTHING falls through to the turn's text, narrowly", () => {
  // THE REAL CODEX DEATH. `usageLimitExceeded` becomes `RequestError.internalError(...)` inside the
  // bridge (@agentclientprotocol/codex-acp/dist/index.js:24077-24080) while the vendor's own sentence
  // still streams as an agent text chunk (:24085-24087), and internalError's message is the bare
  // string `Internal error` (@agentclientprotocol/sdk/dist/jsonrpc.js:1020-1022). So the rejection is
  // silent about usage and the delivered text is the only carrier left.
  expect(sendRejectedOutcome("Internal error", VENDOR_LIMIT_TEXT).reason).toBe("quota");

  // ...through the NARROW list, not the broad one. These three are the F3 prose: ordinary answers that
  // the death vocabulary matches and AGENT_LIMIT_PHRASE does not. `Internal error` is the JSON-RPC
  // catch-all every bridge crash wears, so this door is walked on ordinary failures constantly.
  for (const prose of INNOCENT_PROSE) {
    expect(
      sendRejectedOutcome("Internal error", prose).reason,
      `an ordinary answer took the lane offline on a generic rejection: ${prose}`,
    ).toBe("transport");
  }

  // The structured message still decides FIRST: a transport that named the death outranks the prose.
  expect(sendRejectedOutcome("authentication required", VENDOR_LIMIT_TEXT).reason).toBe("auth");
  // And a caller with no recorder at all keeps the message-only reading it always had.
  expect(sendRejectedOutcome("Internal error").reason).toBe("transport");
});

it("the structured diagnostic decides before the prose does", () => {
  // Order is the contract: a fact the transport already knows outranks a sentence that mentions one.
  expect(laneFailureReason("authentication required", "you have hit your usage limit")).toBe(
    "auth",
  );
  expect(laneFailureReason("stopReason=refusal", "you have hit your usage limit")).toBe("quota");
  expect(laneFailureReason()).toBe("transport");
});

/** F3. Three ORDINARY answers, quoted from the reviewer's own probe, that the broad death vocabulary
 *  matched. None of them is a limit notice; all three are the kind of sentence an agent working in a
 *  repo that discusses rate limits and quotas produces every day. */
const INNOCENT_PROSE = [
  "The endpoint returns 429 when you exceed the rate limit, so back off and retry with jitter.",
  "you have insufficient space on D: to complete the build",
  "the connection quota for that pool is 20, which is why the 21st checkout blocks",
] as const;

it("F3: ordinary prose about limits does NOT take a lane offline on a truncated turn", () => {
  // THE HOLE B OPENED. Offering the turn's delivered TEXT to the classifier was right; running it
  // through the WHOLE death vocabulary was not. `quota`, `insufficient` and `rate limit` are ordinary
  // English in this domain, and a lane marked exhausted here is locked out for FALLBACK_COOLDOWN_MS
  // (15 minutes) because the agent explained an HTTP status code.
  //
  // `max_tokens` is the case that makes it concrete: the SDK's own schema defines it as "the turn
  // ended because the agent reached the maximum number of tokens"
  // (@agentclientprotocol/sdk/schema/schema.json, StopReason) — a TRUNCATION. A truncated answer is
  // the single most likely place to find a half-finished sentence about rate limits, and it says
  // nothing whatsoever about the account's standing.
  for (const prose of INNOCENT_PROSE) {
    const outcome = sendStopOutcome("max_tokens", prose);
    expect(outcome.outcome).toBe("failed");
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `an ordinary answer took the lane offline for 15 minutes: ${prose}`,
    ).toBe("transport");
  }
});

it("F3: the same prose is still innocent on a refusal, where only the real limit words count", () => {
  // The narrowing is in the VOCABULARY, not only in the stop reason, so it holds on the one stop
  // reason that does mean "the agent refused to continue". Otherwise the fix would be a single point
  // of failure the day the vendor changes which value it sends.
  for (const prose of INNOCENT_PROSE) {
    const outcome = sendStopOutcome("refusal", prose);
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `ordinary prose classified as a death on a refusal: ${prose}`,
    ).toBe("transport");
  }
  // ...and the real thing still does, which is the whole point of B.
  const real = sendStopOutcome("refusal", VENDOR_LIMIT_TEXT);
  expect(
    real.outcome === "failed" ? real.reason : undefined,
    "the narrowing swallowed the vendor's own limit sentence, which is what B exists to catch",
  ).toBe("quota");
});

it("F3: a STRUCTURED rejection keeps the broad vocabulary — it is not agent prose", () => {
  // The narrowing applies to what the AGENT TYPED, never to what the transport reported. A rejection
  // message comes from the child CLI or the bridge, not from a language model choosing words, so the
  // pre-existing death vocabulary is exactly right there and stays untouched.
  expect(sendRejectedOutcome("Error: insufficient credits on this account").reason).toBe("quota");
  expect(sendRejectedOutcome("429 rate limit exceeded").reason).toBe("quota");
});

it("N2: a TRUNCATED answer that quotes the vendor's limit sentence still leaves the lane usable", () => {
  // THE CASE THE TRUNCATION LAYER EXISTS FOR, and the one input that actually pins it. The three F3
  // cases above pass `max_tokens` with INNOCENT prose, which the narrow AGENT_LIMIT_PHRASE does not
  // match anyway — so deleting TRUNCATION_STOP_REASONS left the whole suite green and the first layer
  // was decorative. Measured, not assumed: 948 tests passed with that line removed.
  //
  // This is the input where the two layers disagree: an answer that ran out of tokens WHILE QUOTING a
  // usage-limit notice — an agent reading this repo's own source, or the operator's screenshot, or a
  // vendor doc. `max_tokens` is defined by the SDK as "the turn ended because the agent reached the
  // maximum number of tokens" (@agentclientprotocol/sdk/schema/schema.json, StopReason). It says
  // nothing whatsoever about the account, and a lane taken offline here is offline for
  // FALLBACK_COOLDOWN_MS because a long answer hit its ceiling.
  for (const truncation of ["max_tokens", "max_turn_requests"]) {
    const outcome = sendStopOutcome(truncation, VENDOR_LIMIT_TEXT);
    expect(outcome.outcome).toBe("failed");
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `a truncated answer QUOTING a limit notice took the lane offline on ${truncation} - the stop reason says the agent ran out of room, not that the account is spent`,
    ).toBe("transport");
  }

  // The control that keeps the pair honest: the SAME sentence on a refusal is still the real thing.
  const refused = sendStopOutcome("refusal", VENDOR_LIMIT_TEXT);
  expect(refused.outcome === "failed" ? refused.reason : undefined).toBe("quota");
});

/**
 * ITEM D — codex's OTHER two limit vocabularies, VERIFIED in the bytes we actually ship.
 *
 * The review claimed @openai/codex carries "out of credits" and "spend cap" copy and the lead could
 * not find it. It is there. Searched in the installed native binary of our exact pinned version
 * (package.json: "@openai/codex": "0.153.4"). Re-measured on the 0.153.4 binary at the
 * 0.147.0 → 0.153.4 bump — every sentence still ships, at new offsets:
 *
 *   node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe
 *     byte 234332692: "Your workspace is out of credits. Add credits to continue."
 *     byte 234332750: "Your workspace is out of credits. Ask your workspace owner to refill in order
 *                      to continue."
 *     byte 234332840: "You hit your spend cap set in your workspace. Increase your spend cap to
 *                      continue."
 *     and byte 236069160 "You're out of credits." / byte 236066135 "You've reached your workspace
 *     credit limit" nearby.
 *   Command: grep -a -b -o -F "<phrase>" <binary>   (5 hits for "out of credits", 4 for "spend cap";
 *   positive control: 118 hits for "credits", 31 for "usage limit").
 *
 * VERIFIED, not assumed — but the ROUTE is not. These strings live in the codex binary; whether the
 * ACP bridge relays them as agent text on the path this classifier reads is UNVERIFIED, because
 * reproducing it needs a real workspace at its spend cap. The phrases go in regardless: they cost
 * nothing, they are unmistakable, and the failure they guard against is silent.
 */
const CODEX_CREDIT_PROSE = [
  "Your workspace is out of credits. Add credits to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
  "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
  "You're out of credits.",
  // DELTA ITEM 3: the sentence the first pass named in a comment and never matched. Re-verified in
  // this worktree's own installed binary at the byte the review reported:
  //   grep -a -b -o -F "You've reached your workspace credit limit" <codex.exe>
  //   240144687:You've reached your workspace credit limit
  // The full surrounding string, dumped from the same bytes, is
  //   "You've reached your workspace credit limit" / "Your workspace is out of credits. Ask your
  //    workspace owner to add more. Notify owner?" / "Usage limit reached"
  "You've reached your workspace credit limit",
  "Usage limit reached",
] as const;

/**
 * DELTA ITEM 3 — THE FALSE POSITIVE THE FIRST PASS CREATED, and it did not exist before that commit.
 *
 * `spend cap` was matched as a bare noun phrase, so the review reproduced an ORDINARY safety refusal
 * classifying as a death: an agent declining to help bypass a workspace spend cap is talking ABOUT the
 * limit, not reporting one. A refusal is a non-`end_turn` stop, so the prose door is wide open on
 * exactly that ending, and the cost is a fifteen-minute lockout of a perfectly healthy lane.
 *
 * The rule the fix follows: match the vendor's SENTENCE SHAPE — a verb or a possessive anchoring the
 * noun (`hit your spend cap`, `out of credits`) — never the noun alone. Every real vendor string above
 * carries such an anchor, so nothing is lost by requiring one.
 */
const SPEND_CAP_PROSE_THAT_IS_NOT_A_DEATH = [
  "I cannot help you bypass the workspace spend cap.",
  "You could raise the spend cap, but I would not recommend it for a shared account.",
  "The spend cap is a billing control, not a rate limit — they behave differently.",
] as const;

it("DELTA 3: an agent TALKING ABOUT a spend cap is not an agent that hit one", () => {
  for (const prose of SPEND_CAP_PROSE_THAT_IS_NOT_A_DEATH) {
    const outcome = sendStopOutcome("refusal", prose);
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `ordinary refusal prose locked the lane out for the fallback cooldown: ${prose}`,
    ).toBe("transport");
    // The rejection ending reads the same list, so it has to agree.
    expect(
      sendRejectedOutcome("Internal error", prose).reason,
      `the rejection door classified ordinary prose as a death: ${prose}`,
    ).toBe("transport");
  }
});

it("D: codex's credit and spend-cap sentences are read as a limit, like its usage-limit one", () => {
  for (const prose of CODEX_CREDIT_PROSE) {
    const outcome = sendStopOutcome("refusal", prose);
    expect(outcome.outcome).toBe("failed");
    expect(
      outcome.outcome === "failed" ? outcome.reason : undefined,
      `codex said the workspace is spent and the lane stayed ready: ${prose}`,
    ).toBe("quota");
  }
  // ...and on the REJECTED ending too, which is the one the real codex death takes (item A).
  for (const prose of CODEX_CREDIT_PROSE) {
    expect(sendRejectedOutcome("Internal error", prose).reason).toBe("quota");
  }
});

it("D: the new phrases are still bounded by the truncation layer", () => {
  // The safety half. `max_tokens` and `max_turn_requests` are the SDK's own truncations — an answer
  // that ran out of room while QUOTING codex's credit copy (a screenshot, this very test file, a
  // vendor doc) says nothing about the account. Widening the vocabulary must not widen that.
  for (const truncation of ["max_tokens", "max_turn_requests"]) {
    for (const prose of CODEX_CREDIT_PROSE) {
      expect(
        (() => {
          const outcome = sendStopOutcome(truncation, prose);
          return outcome.outcome === "failed" ? outcome.reason : undefined;
        })(),
        `a truncated answer quoting codex credit copy took the lane offline on ${truncation}: ${prose}`,
      ).toBe("transport");
    }
  }
});

it("D: ordinary prose about credit and spending is still innocent", () => {
  // The false-positive control for the two new phrases specifically. Neither is a phrase an agent
  // reaches for while explaining something — but "credit" and "cap" on their own are, which is why
  // the pattern matches the full two- and three-word forms and not the bare nouns.
  for (const prose of [
    "give the reviewer credit for spotting it",
    "the buffer has a hard cap of 1000 characters",
    "we ran out of disk space, not out of ideas",
  ]) {
    expect(
      (() => {
        const outcome = sendStopOutcome("refusal", prose);
        return outcome.outcome === "failed" ? outcome.reason : undefined;
      })(),
      `ordinary prose classified as a death: ${prose}`,
    ).toBe("transport");
  }
});

/**
 * A' — THE STRUCTURED DOOR, and it is the rung that does not depend on a race.
 *
 * The vendor's fact is carried TWICE on the codex limit path. `createErrorEvent`
 * (`@agentclientprotocol/codex-acp/dist/index.js:24066-24088`) does both of these for one error:
 *
 *   } else if (error51 === "usageLimitExceeded") {          // :24077
 *     this.failure = RequestError.internalError(
 *       this.createTurnErrorData(params.error)               // :24078-24080
 *     );
 *   ...
 *   return createAgentTextMessageChunk(`${params.error.message}\n\n`);   // :24085-24087
 *
 * and `createTurnErrorData` (:24105-24115) builds that data as
 * `{ message: error.additionalDetails ?? error.message, codexErrorInfo, additionalDetails }`.
 * `RequestError` keeps `data` as a public field (`@agentclientprotocol/sdk/dist/jsonrpc.js:975-989`)
 * and the client re-raises the error WITH it: `new RequestError(code, message, data)` (:843-844).
 *
 * So the rejection carries a transport-produced ENUM — `codexErrorInfo: "usageLimitExceeded"` — and
 * the vendor sentence, neither of which can lose a race with anything: they arrive ON the rejection.
 * The streamed text arrives as a separate `session/update` notification, and while it travels the
 * same stream in order, notification handling is async (`jsonrpc.js:742`) and I could not prove the
 * chunk always lands first. This door does not care.
 */
const CODEX_LIMIT_DATA = {
  message: "You've hit your usage limit. Try again at Aug 27th, 2026 8:54 AM.",
  codexErrorInfo: "usageLimitExceeded",
} as const;

function rejectionWith(message: string, data: unknown): Error {
  const error = new Error(message);
  return Object.assign(error, { data });
}

it("A': a rejection carrying ONLY the structured data classifies quota — no streamed text at all", () => {
  // THE RACE'S LOSING SIDE. If the text chunk has not been processed when the rejection settles,
  // `delivered` is empty and the prose door has nothing to read. The enum still says it outright.
  const cause = rejectionWith("Internal error", CODEX_LIMIT_DATA);

  expect(
    sendRejectedOutcome(cause).reason,
    "the vendor named the death in a transport-produced enum and the lane still called it a transport hiccup",
  ).toBe("quota");
  // ...and with the text present too, which is the ordinary ordering.
  expect(sendRejectedOutcome(cause, VENDOR_LIMIT_TEXT).reason).toBe("quota");
});

it("A': the vendor's own sentence on the error data is read, narrowly, when the enum is absent", () => {
  // The second structured rung. A bridge that fills `data.message` but not `codexErrorInfo` — or
  // renames the enum in a later version — still says the thing out loud in a field the transport
  // produced. Read through the NARROW list, not the broad death vocabulary: this value is
  // `error.additionalDetails ?? error.message`, and `additionalDetails` is free-form vendor prose.
  expect(sendRejectedOutcome(rejectionWith("Internal error", CODEX_LIMIT_DATA)).reason).toBe(
    "quota",
  );
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", { message: VENDOR_LIMIT_TEXT })).reason,
  ).toBe("quota");
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", { message: INNOCENT_PROSE[0] })).reason,
    "the narrow list was widened - ordinary prose on the error data took the lane offline",
  ).toBe("transport");
});

it("A': every shape of absent, malformed or hostile error data degrades to the text door", () => {
  // THE FIELD IS VENDOR-SHAPED, NOT SCHEMA-GUARANTEED. `data` is typed `unknown` on RequestError and
  // an ordinary `Error` has no `data` at all. Every read is defensive: nothing here may throw, and
  // nothing here may classify a death on the strength of a shape it did not recognise.
  for (const data of [
    undefined,
    null,
    "a string",
    42,
    [],
    {},
    { codexErrorInfo: null },
    { codexErrorInfo: 7 },
    { codexErrorInfo: "somethingElse" },
    { message: null },
    { message: 42 },
    { message: { nested: "usage limit" } },
  ]) {
    const cause = rejectionWith("Internal error", data);
    expect(
      sendRejectedOutcome(cause).reason,
      `data ${JSON.stringify(data) ?? "undefined"} classified a death it should not have`,
    ).toBe("transport");
    // ...and the delivered-text door still works underneath it, unchanged.
    expect(
      sendRejectedOutcome(cause, VENDOR_LIMIT_TEXT).reason,
      `data ${JSON.stringify(data) ?? "undefined"} swallowed the text fallback`,
    ).toBe("quota");
  }
  // A cause that is not an Error at all — the `String(cause)` path — still behaves.
  expect(sendRejectedOutcome("ECONNRESET").reason).toBe("transport");
  expect(sendRejectedOutcome(undefined, VENDOR_LIMIT_TEXT).reason).toBe("quota");
});

/**
 * DELTA ITEM 6 — THE STRUCTURED DOOR IS THE STRONGEST RUNG, SO IT MUST BE THE NARROWEST.
 *
 * `typeof data === "object" && data !== null` admits far more than a JSON record: arrays are objects,
 * and a plain property read walks the whole prototype chain. The review classified `quota` from an
 * ARRAY and from an object that carried `codexErrorInfo` only by inheritance — neither of which any
 * producer in this tree can build, and both of which the rung was happy to believe.
 *
 * That matters more here than at the prose rungs because this one is not a heuristic: it is read as a
 * transport FACT and it decides a fifteen-minute lockout with no text needed to corroborate it. The
 * real shape is an object literal built in-process by `createTurnErrorData`
 * (`@agentclientprotocol/codex-acp/dist/index.js:24105-24115`) or a JSON-parsed record off the wire.
 * Both are plain records with own properties; nothing legitimate is lost by requiring exactly that.
 */
it("DELTA 6: an ARRAY cannot forge the structured enum", () => {
  const arrayData = Object.assign([], { codexErrorInfo: "usageLimitExceeded" });
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", arrayData)).reason,
    "an array carrying the enum classified a death - `typeof [] === 'object'` is not a record check",
  ).toBe("transport");

  const arrayMessage = Object.assign([], { message: VENDOR_LIMIT_TEXT });
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", arrayMessage)).reason,
    "an array carrying vendor prose classified a death",
  ).toBe("transport");
});

it("DELTA 6: an INHERITED property cannot forge the structured enum", () => {
  const inheritedEnum: unknown = Object.create({ codexErrorInfo: "usageLimitExceeded" });
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", inheritedEnum)).reason,
    "a prototype-chain property classified a death - the read walked past the object's own keys",
  ).toBe("transport");

  const inheritedMessage: unknown = Object.create({ message: VENDOR_LIMIT_TEXT });
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", inheritedMessage)).reason,
    "an inherited vendor sentence classified a death",
  ).toBe("transport");

  // The classic prototype-pollution shape, for completeness: every object inherits Object.prototype,
  // so a polluted prototype would otherwise hand this rung to whoever polluted it.
  const polluted: unknown = Object.create(Object.prototype, {
    codexErrorInfo: { value: "usageLimitExceeded", enumerable: true, writable: true },
  });
  expect(
    sendRejectedOutcome(rejectionWith("Internal error", polluted)).reason,
    "an own, enumerable enum on a plain record must still be believed - this control has stopped controlling",
  ).toBe("quota");
});

it("DELTA 6: the narrowing does not close the door on the real shape", () => {
  // The positive control that keeps this from being a fix that simply stops detecting. Both real
  // producers still pass: an in-process object literal, and the same record after a JSON round trip.
  expect(sendRejectedOutcome(rejectionWith("Internal error", CODEX_LIMIT_DATA)).reason).toBe(
    "quota",
  );
  expect(
    sendRejectedOutcome(
      rejectionWith("Internal error", JSON.parse(JSON.stringify(CODEX_LIMIT_DATA))),
    ).reason,
    "a JSON-parsed record - which is literally what arrives off the wire - stopped being read",
  ).toBe("quota");
  // A null-prototype record is a legitimate JSON shape too (`JSON.parse` reviver, `Object.create(null)`).
  const bare = Object.assign(Object.create(null), { codexErrorInfo: "usageLimitExceeded" });
  expect(sendRejectedOutcome(rejectionWith("Internal error", bare)).reason).toBe("quota");
});

it("A': the rejection MESSAGE still outranks every structured rung", () => {
  // Order is unchanged at the top: `authRequired` puts its cause in the message
  // (`RequestError.authRequired(data, params.error.message)`, codex-acp :24082, formatted as
  // `Authentication required: …` by jsonrpc.js:1030-1032), and a lane sent to the wrong recovery
  // ladder waits for a window to reset when what it needs is a reconnect.
  const cause = rejectionWith("Authentication required: sign in again", CODEX_LIMIT_DATA);
  expect(sendRejectedOutcome(cause, VENDOR_LIMIT_TEXT).reason).toBe("auth");
});
