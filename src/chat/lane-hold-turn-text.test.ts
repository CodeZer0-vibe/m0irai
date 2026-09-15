/**
 * @file src/chat/lane-hold-turn-text.test.ts
 * @purpose F2 — the falsifier `state.text.begin()` never had. ONE held connection serves every turn of
 *   a session, and the turn-text recorder it was opened with is created ONCE in
 *   `createCockpitLaneTransport`. If the recorder is not reset at the top of each send, a lane that
 *   once returned the vendor's usage-limit sentence classifies EVERY later failing turn as `quota`,
 *   for as long as the process lives.
 * @exports (none — test file)
 * @depends node:fs, node:os, node:path, vitest, ./lane-hold
 *
 * WHY IT NEEDED ITS OWN FILE RATHER THAN A DIRECT CALL. `lane-send-outcome.test.ts` already pins that
 * `begin()` clears the recorder — but it calls the recorder directly, so it passes whether or not the
 * HOLD ever calls it. Deleting the line from `lane-hold.ts` left 1203 tests green. The gap was that
 * nothing drove a real transport across TWO turns, which is the only place the bug can appear.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCockpitLaneTransport } from "./lane-hold.js";

const dirs: string[] = [];
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lane-hold-turn-text-"));
  dirs.push(repoRoot);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The operator's own codex row at 15:20, verbatim — the sentence that must classify exactly once. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";
/** An ordinary answer. Nothing in it says anything about the account. */
const INNOCENT_TEXT =
  "Done — I moved the retry helper into its own module and updated the imports.";

/** One scripted turn. A turn either RETURNS a stop reason or REJECTS — the two endings a send has, and
 *  the real codex usage-limit death is the SECOND one (see the A test at the bottom of this file). The
 *  scripted text streams either way, because the vendor streams it either way. */
interface Step {
  /** Absent when the turn streams NOTHING — the case the structured door exists for. */
  readonly text?: string;
  readonly stopReason?: string;
  readonly rejectWith?: Error;
}

/**
 * ONE connection for the whole session, exactly as production holds it. Each turn streams its scripted
 * text through the `onText` the connection was OPENED with — which is the recorder's sink — and then
 * ends on a stop reason that is not `end_turn`, or rejects.
 */
function heldTransport(script: readonly Step[]) {
  let turn = 0;
  return createCockpitLaneTransport({
    agent: "codex",
    cwd: "/repo",
    repoRoot,
    openConnection: async (input) => {
      return {
        initialize: async () => undefined,
        newSession: async () => ({ sessionId: "s-held" }),
        resumeSession: async (sessionId: string) => ({ sessionId }),
        prompt: async () => {
          const step = script[turn];
          turn += 1;
          if (step === undefined) throw new Error("the script ran out of turns");
          if (step.text !== undefined) input.onText?.(step.text);
          if (step.rejectWith !== undefined) throw step.rejectWith;
          return step.stopReason ?? "end_turn";
        },
        setMode: async () => undefined,
        close: () => undefined,
        waitForExit: async () => true,
        killTree: async () => undefined,
        isAlive: () => true,
        pid: () => 4242,
      } as never;
    },
  });
}

it("F2: a lane that hit its limit once does not classify the NEXT turn as quota", async () => {
  // THE DEFECT, exactly as it would reach the operator: codex answers with its limit sentence and the
  // lane correctly goes exhausted. Fifteen minutes later the window resets, the operator sends again,
  // and that turn fails for some perfectly ordinary reason — and the lane goes exhausted AGAIN, on the
  // strength of a sentence from a turn that is already over. Nothing on screen could explain it.
  const transport = heldTransport([
    { text: VENDOR_LIMIT_TEXT, stopReason: "refusal" },
    { text: INNOCENT_TEXT, stopReason: "refusal" },
  ]);
  await transport.start(undefined);

  const first = await transport.send("are you there", "s-held");
  expect(first.outcome).toBe("failed");
  expect(
    first.outcome === "failed" ? first.reason : undefined,
    "the vendor's own limit sentence stopped being read as a limit",
  ).toBe("quota");

  const second = await transport.send("try again", "s-held");
  expect(second.outcome).toBe("failed");
  expect(
    second.outcome === "failed" ? second.reason : undefined,
    "the PREVIOUS turn's limit sentence was read as this turn's ending - the recorder was never reset, so one spent window locks the lane for the life of the process",
  ).toBe("transport");

  await transport.close();
});

it("F2: the reset does not swallow a limit sentence delivered by a LATER turn", async () => {
  // The positive control, and the reason the fix is a reset rather than a one-shot latch: turn 2 is the
  // one that hits the limit here, and it must still classify. A guard that simply refused to classify
  // twice would pass the test above and break this one.
  const transport = heldTransport([
    { text: INNOCENT_TEXT, stopReason: "refusal" },
    { text: VENDOR_LIMIT_TEXT, stopReason: "refusal" },
  ]);
  await transport.start(undefined);

  const first = await transport.send("hello", "s-held");
  expect(first.outcome === "failed" ? first.reason : undefined).toBe("transport");

  const second = await transport.send("hello again", "s-held");
  expect(
    second.outcome === "failed" ? second.reason : undefined,
    "a limit that arrived on a later turn was missed",
  ).toBe("quota");

  await transport.close();
});

/**
 * WHAT THE REAL CODEX DEATH LOOKS LIKE ON THE WIRE, read out of the installed bytes rather than
 * assumed — and it is a REJECTION, which is the ending B never covered.
 *
 * `node_modules/@agentclientprotocol/codex-acp/dist/index.js:24077-24080`:
 *     } else if (error51 === "usageLimitExceeded") {
 *       this.failure = RequestError.internalError(
 *         this.createTurnErrorData(params.error)
 *       );
 * and the SAME function still returns `createAgentTextMessageChunk(`${params.error.message}\n\n`)`
 * at :24085-24087. So the bridge does both: it streams the vendor's own limit sentence as ordinary
 * agent TEXT and it arms a failure that makes `prompt()` reject.
 *
 * AND THE REJECTION SAYS NOTHING. `RequestError.internalError(data)` is
 * `new RequestError(-32603, "Internal error", data)` — the message has no suffix unless a second
 * argument is passed, and none is (`@agentclientprotocol/sdk/dist/jsonrpc.js:1020-1022`). The client
 * re-raises it verbatim: `pendingResponse.reject(new RequestError(code, message, data))` (:843-844).
 * So `Error.message` is the literal string `Internal error`, and the only surviving carrier of the
 * fact that this account is spent is the text the turn delivered.
 */
const CODEX_REJECTION = (): Error => new Error("Internal error");

it("A: the real codex limit death REJECTS with 'Internal error' and must still classify as quota", async () => {
  // BEFORE THIS FIX the rejected path called `sendRejectedOutcome(errorMessage(cause))` and nothing
  // else — `state.text.delivered()` was never offered on a throw — so this exact turn came back
  // `transport`, the lane stayed READY, and the operator's codex chip painted generic offline
  // instead of the red `out of usage` the whole lane exists to produce.
  const transport = heldTransport([{ text: VENDOR_LIMIT_TEXT, rejectWith: CODEX_REJECTION() }]);
  await transport.start(undefined);

  const result = await transport.send("are you there", "s-held");

  expect(result.outcome).toBe("failed");
  expect(
    result.outcome === "failed" ? result.reason : undefined,
    "the vendor streamed its limit sentence and then threw an opaque 'Internal error' - reading only the rejection message paints generic offline for the one death this lane exists to name",
  ).toBe("quota");
  // The message stays the BARE transport diagnostic: it is what isSessionEndedFailure reads to decide
  // whether to drop a live connection, so the agent's prose must never enter it.
  expect(result.outcome === "failed" ? result.message : undefined).toBe("Internal error");

  await transport.close();
});

it("A: an ORDINARY turn that rejects with 'Internal error' still leaves the lane usable", async () => {
  // The false-positive control for the new door. `Internal error` is the JSON-RPC catch-all — every
  // bridge crash, every unhandled throw inside the agent, arrives wearing it. If the delivered text
  // were read through the BROAD death vocabulary here, an ordinary answer mentioning a rate limit
  // would take the lane offline for the fallback cooldown on any internal error. It is read through
  // the narrow AGENT_LIMIT_PHRASE instead, the same one the stop-reason path uses.
  const transport = heldTransport([
    { text: INNOCENT_TEXT, rejectWith: CODEX_REJECTION() },
    {
      text: "The endpoint returns 429 when you exceed the rate limit, so back off and retry.",
      rejectWith: CODEX_REJECTION(),
    },
  ]);
  await transport.start(undefined);

  for (const prompt of ["hello", "and again"]) {
    const result = await transport.send(prompt, "s-held");
    expect(
      result.outcome === "failed" ? result.reason : undefined,
      `an ordinary rejected turn marked the lane dead: ${prompt}`,
    ).toBe("transport");
  }

  await transport.close();
});

it("A: a rejection whose OWN message names the death still decides before the prose", async () => {
  // Order is the contract and it is not decorative: a fact the transport already reported outranks a
  // sentence the agent happened to type. Here the rejection says `authentication required` while the
  // turn's text says `usage limit` — a lane sent to the wrong recovery ladder would sit waiting for a
  // window to reset when what it needs is a reconnect.
  const transport = heldTransport([
    { text: VENDOR_LIMIT_TEXT, rejectWith: new Error("authentication required") },
  ]);
  await transport.start(undefined);

  const result = await transport.send("are you there", "s-held");
  expect(result.outcome === "failed" ? result.reason : undefined).toBe("auth");

  await transport.close();
});

it("A': a turn that streams NOTHING and rejects with the vendor's enum still classifies quota", async () => {
  // THE WHOLE PATH for the race's losing side. Rungs 2-4 of sendRejectedOutcome only matter if the
  // hold actually hands it the CAUSE rather than the cause's message, and nothing else in this file
  // would notice that regression: every other case has streamed text to fall back on.
  //
  // No text at all here, deliberately. The chunk is a separate `session/update` notification and its
  // processing is async (`@agentclientprotocol/sdk/dist/jsonrpc.js:742`), so a rejection can settle
  // first. What cannot lose that race is the data ON the rejection — `codexErrorInfo` set by
  // `createTurnErrorData` (`@agentclientprotocol/codex-acp/dist/index.js:24105-24115`), reached from
  // the `usageLimitExceeded` branch at :24077-24080.
  const rejection = Object.assign(new Error("Internal error"), {
    data: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
  });
  const transport = heldTransport([{ rejectWith: rejection }]);
  await transport.start(undefined);

  const result = await transport.send("are you there", "s-held");
  expect(
    result.outcome === "failed" ? result.reason : undefined,
    "the hold passed only the rejection's MESSAGE to the classifier, so the structured door never saw the vendor's own enum",
  ).toBe("quota");

  await transport.close();
});
