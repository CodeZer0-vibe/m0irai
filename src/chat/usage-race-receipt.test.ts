/**
 * @file src/chat/usage-race-receipt.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:path, node:url, vitest, ./events, ./usage-payload-emitter, ./usage-reporter
 * @purpose F6 / FL-099. claude's `/usage` call races a 3-second timeout inside the vendored bridge, and
 *   the timeout used to resolve `null` — after which the `rate_limits_available` guard sent nothing at
 *   all. So "we gave up after 3 s", "this account has no plan limits" and "the call threw" were
 *   INDISTINGUISHABLE in every artifact the system produced, and the operator's claude 5h meter simply
 *   never appeared with no way to tell which of the three had happened.
 *
 *   The bridge cannot emit a diagnostic of its own — `client.sessionUpdate` is its only channel to us —
 *   so the receipt rides as a schema-valid `_meta` marker on a `usage_update`, the same way the plan
 *   windows already do. These pin both halves: the patch really writes the marker, and the reporter
 *   really turns it into a distinct outcome instead of the flat "arrived" it used to report.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { type EmitSlot, deliverLaneUpdate } from "../adapters/acp/acp-lane-update-routing.js";
import { resetClaudeWindowFold } from "./claude-usage-fold.js";
import { ChatEventBus, type UsagePayloadEvent } from "./events.js";
import { usageOutcomeMarker } from "./usage-payload-emitter.js";
import { createUsageReporter } from "./usage-reporter.js";

// claude's window fold is PROCESS-scoped on purpose (claude-usage-fold.ts:15 — account windows outlive
// a turn, so a later usage_update carrying only used/size still shows the last real 5h/weekly). That
// makes it shared state between tests, and this file was the one FL-099 file not isolating it: the
// day-2 case below writes fiveHourUsedPct 71 and every later test in the file inherited it. The three
// sibling suites (claude-usage-fold, headless-turn-acp-usage, usage-reporter) already reset it.
beforeEach(resetClaudeWindowFold);

it("FALSIFIER F6: a timed-out /usage race reports 'timed-out', not 'arrived'", () => {
  const { payloads, statuses } = report({
    sessionUpdate: "usage_update",
    used: 40,
    size: 100,
    _meta: { "_claude/usageOutcome": "timed-out" },
  });

  expect(outcomes(payloads)).toEqual(["timed-out", "timed-out"]);
  // The context numbers on a receipt update are REAL and still publish. Only the diagnostic changes:
  // reporting "arrived" for an update that carries no windows was the lie.
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({ usage: { contextUsedPct: 40 } });
});

it("FALSIFIER F6: 'timed out' and 'no limits on this account' are DIFFERENT values", () => {
  const timedOut = outcomes(
    report({
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: { "_claude/usageOutcome": "timed-out" },
    }).payloads,
  );
  const noLimits = outcomes(
    report({
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: { "_claude/usageOutcome": "no-limits" },
    }).payloads,
  );
  const failed = outcomes(
    report({
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: { "_claude/usageOutcome": "failed" },
    }).payloads,
  );

  // THE WHOLE POINT. An operator with no plan limits and an operator whose call timed out both saw an
  // empty meter and an "arrived" diagnostic. Three outcomes, three values, no overlap.
  expect(new Set([...timedOut, ...noLimits, ...failed]).size).toBe(3);
  expect(timedOut).toEqual(["timed-out", "timed-out"]);
  expect(noLimits).toEqual(["no-limits", "no-limits"]);
  expect(failed).toEqual(["failed", "failed"]);
});

it("PIN: an ordinary usage_update with real windows still reports 'arrived'", () => {
  const { payloads } = report({
    sessionUpdate: "usage_update",
    used: 40,
    size: 100,
    _meta: {
      "_claude/usageWindows": {
        five_hour: { utilization: 42, resets_at: 1_800_000_000 },
      },
    },
  });

  expect(outcomes(payloads)).toEqual(["arrived", "arrived"]);
});

it("PIN: an unrecognised marker is ABSENT, not a new outcome invented for the vendor", () => {
  // UNTRUSTED vendor output. A bridge that starts writing a fourth value must not smuggle it onto the
  // wire — event-schemas.ts drops an unlisted enum value silently, so an unknown marker that reached
  // the emit would produce a diagnostic that vanishes rather than one that is wrong out loud.
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": "gave-up-ish" } })).toBeUndefined();
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": 3 } })).toBeUndefined();
  expect(usageOutcomeMarker({ _meta: null })).toBeUndefined();
  expect(usageOutcomeMarker(null)).toBeUndefined();
  expect(usageOutcomeMarker({ _meta: { "_claude/usageOutcome": "failed" } })).toBe("failed");
});

it("FALSIFIER F6: the patch AND the installed bytes both write the marker, on all three paths", async () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageRoot = path.join(
    repoRoot,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
  );
  // The version-embedded filename is resolved from the INSTALLED package rather than hard-coded: a
  // bump leaves the old patch sitting in patches/ applying to nothing, and a test naming the old
  // version would keep reading that dead file and stay green (the trap
  // tests/integration/claude-acp-usage-patch.test.ts already guards this way).
  const installedVersion = (
    JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
      readonly version: string;
    }
  ).version;
  const patchPath = path.join(
    repoRoot,
    "patches",
    `@agentclientprotocol+claude-agent-acp+${installedVersion}.patch`,
  );
  const [patch, installed] = await Promise.all([
    readFile(patchPath, "utf8"),
    readFile(path.join(packageRoot, "dist", "acp-agent.js"), "utf8"),
  ]);
  // The patch file and the installed bytes must BOTH carry it. A patch that is correct and not applied
  // is exactly the state a clean npm ci is supposed to prevent and the only one worth testing for.
  expect(installed).toContain('_meta: { "_claude/usageOutcome": outcome }');
  expect(installed).toContain('const timedOut = { zer0UsageOutcome: "timed-out" }');

  // The mechanical point of the change: the timeout must resolve a MARKER OBJECT, because the
  // rate_limits_available guard drops a null before it can be reported. A patch that added the _meta
  // key while still resolving null would look right in review and emit nothing at runtime.
  expect(patch).toContain('_meta: { "_claude/usageOutcome": outcome }');
  expect(patch).toContain('const timedOut = { zer0UsageOutcome: "timed-out" }');
  expect(patch).toContain("resolve(timedOut)");
  expect(patch).not.toContain("resolve(null), 3000");
  for (const outcome of ['usageReceipt("timed-out")', 'usageReceipt("no-limits")']) {
    expect(patch).toContain(outcome);
  }
  expect(patch).toContain('usageReceipt("failed")');
});

it("FL-099 day 2: the /usage race stays BOUNDED, and the bound is not a meter-latency knob", async () => {
  // THE OPERATOR ASKED FOR A LONGER BUDGET, and measuring the tree refuted the reason for one. The
  // premise was that the call is post-turn so waiting longer costs only meter latency. It is not
  // post-turn in any sense the client can see: the race is awaited INLINE inside the bridge's
  // `case "result":` handler (dist/acp-agent.js:2288 opens the case, the `await Promise.race([...])`
  // is at :2451-2457), and every path that ENDS the turn runs after it — `settleOrDefer({ stopReason,
  // … })` at :2641 and the refusal path's at :2546. An `await` there suspends the whole handler, so
  // the bound is not "how long before we give up on the meters", it is "how long the operator's lane
  // keeps saying `working` after the answer has already finished streaming". The patch's own header
  // says exactly this: "bounded so telemetry can never stall prompt settlement".
  //
  // So this pins the bound rather than a particular number: raising it trades a missing meter for a
  // stalled lane, at 1 ms of dead screen per 1 ms of extra budget, on EVERY claude turn whose usage
  // call is slow.
  //
  // WHAT ACTUALLY DELIVERS THE METERS, now that both halves exist: the answer that loses the race is
  // FORWARDED rather than discarded. That took a receiver AND a producer, and shipping only the
  // receiver changed nothing the operator could see. The receiver is acp-lane-connection.ts's
  // session-scoped standing listener; the producer is the `usageCall.then(...)` on the timed-out
  // branch of the patch, pinned by the day-3 test below. This comment used to say the listener alone
  // was the fix — it was not, because until day 3 the bridge never emitted the message it listens for.
  const [patch, installed] = await Promise.all([patchSource(), installedSource()]);

  for (const source of [patch, installed]) {
    expect(source, "the race must keep a timer leg at all").toContain("resolve(timedOut)");
    const bound = /setTimeout\(\(\) => resolve\(timedOut\), (\d+)\)/.exec(source)?.[1];
    expect(bound, "the timed-out leg lost its numeric bound").toBeDefined();
    expect(
      Number(bound),
      "the /usage race bound is the operator's post-answer wait, not a meter knob - read this test's header before moving it",
    ).toBeLessThanOrEqual(3000);
  }
});

it("FL-099 day 2: a timed-out call is retried on the NEXT turn, never suppressed for the session", async () => {
  // THE THIRD HALF OF THE OPERATOR'S REPORT: "I thought we fixed that dumb bug". If a timeout latched
  // a session-level flag, one saturated moment would cost the meters for the whole run, and the
  // operator's two turns at 15:23 and 15:24 would be explained by the FIRST one alone. It does not:
  // the whole block is guarded only by `lastAssistantTotalUsage !== null`, a per-result value, inside
  // `case "result":` — which runs once per turn — so every turn issues its own call. Pinned here
  // because "it already works" is exactly the property a later edit removes by accident, and nothing
  // else in the suite would notice.
  const installed = await installedSource();
  const block = usageBlock(installed);

  expect(block, "the /usage forward block moved or lost its guard").toContain(
    "if (lastAssistantTotalUsage !== null)",
  );
  // F8 — NO SESSION-SCOPED LATCH, PINNED STRUCTURALLY RATHER THAN BY NAME.
  //
  // This used to match `/session[.]\w*usage\w*/i`, which is a guess about what a latch would be
  // CALLED. A latch spelled `session.zer0MetersDone` walks straight past it, and the history of this
  // very line says name-shaped guards fail exactly that way: an earlier draft used a letters-only
  // class and missed `session.zer0UsageAsked` because `zer0` contains a digit — proven by injecting
  // that latch and watching the test pass.
  //
  // So the pin is now an ALLOWLIST of the session state this block is allowed to touch at all. Any new
  // `session.<anything>` fails it, whatever it is named, and the only way to add one is to come here
  // and say why it is not a latch.
  const sessionProps = [
    ...new Set(Array.from(block.matchAll(/session\.([A-Za-z0-9_$]+)/g), (match) => match[1])),
  ].sort();
  expect(
    sessionProps,
    "the /usage block reached for session state it did not use before - if that is a latch, one timeout costs the meters for the rest of the run",
  ).toEqual(["contextWindowSize", "query"]);
  // ...and the same defect held in a keyed collection rather than on the session object. A Map lookup
  // inside this block is the other shape "have we already asked for this session" takes.
  expect(
    /\.(?:has|set|delete)\(/.test(block),
    "a keyed lookup appeared in the /usage block - a latch in a Map is still a latch",
  ).toBe(false);
  expect(block).toContain("usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()");
});

/** The bytes actually loaded at runtime. Resolved from the INSTALLED package for the same reason the
 *  falsifier above resolves its patch filename that way: a version bump must not leave a test reading
 *  a file nothing applies. */
async function installedSource(): Promise<string> {
  return readFile(path.join(packageRoot(), "dist", "acp-agent.js"), "utf8");
}

async function patchSource(): Promise<string> {
  const version = (
    JSON.parse(await readFile(path.join(packageRoot(), "package.json"), "utf8")) as {
      readonly version: string;
    }
  ).version;
  return readFile(
    path.join(repoRoot(), "patches", `@agentclientprotocol+claude-agent-acp+${version}.patch`),
    "utf8",
  );
}

function repoRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function packageRoot(): string {
  return path.join(repoRoot(), "node_modules", "@agentclientprotocol", "claude-agent-acp");
}

/** The zer0 /usage forward block, from its PATCH marker to the end of its catch. Sliced rather than
 *  searched whole-file so "no session flag gates this" is a claim about THIS block and not about a
 *  coincidence somewhere else in a 3000-line file. */
function usageBlock(source: string): string {
  const start = source.indexOf("PATCH(zer0 u2d-c)");
  expect(start, "the /usage forward block is gone from the installed bytes").toBeGreaterThan(-1);
  const end = source.indexOf('usageReceipt("failed")', start);
  expect(end, "the /usage forward block lost its failure receipt").toBeGreaterThan(start);
  return source.slice(start, end);
}

it("FL-099 day 2: the windows that arrive AFTER the turn settles now reach agent.status", async () => {
  // THE OPERATOR'S MISSING METERS, end to end, through the REAL delivery rule and the REAL reporter.
  // The bridge answers `/usage` a moment after the turn is over; before this, `slot.current` was already
  // undefined and the answer went nowhere. Now the session's standing listener takes it and the reporter
  // publishes the windows on `agent.status` exactly as it would have mid-turn.
  //
  // TURN ATTRIBUTION, and it is a choice: the late update is recorded by whichever reporter is still
  // installed, which is the reporter of the turn that ASKED for the usage — the bridge issues the call
  // from that turn's own `result` handler. So the diagnostic is stamped with the turn that caused it,
  // which is the correct attribution rather than a compromise. `agent.status` itself carries no turn:
  // usage is account and session state, not turn state, so the meters are unaffected either way.
  const bus = new ChatEventBus();
  const statuses: unknown[] = [];
  bus.on("agent.status", (event) => statuses.push(event));
  const reporter = createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 3,
  });
  const slot: EmitSlot = {
    current: undefined,
    standing: (update) => reporter.recordAcpSessionUpdate(update),
    liveSessionId: "s-live",
  };

  deliverLaneUpdate(
    slot,
    {
      sessionUpdate: "usage_update",
      used: 40,
      size: 100,
      _meta: {
        "_claude/usageWindows": {
          five_hour: { utilization: 71, resets_at: 1_800_000_000 },
        },
      },
    },
    "s-live",
  );

  expect(
    statuses,
    "a usage_update that landed after the turn published nothing - the 5h meter never appears",
  ).toHaveLength(1);
  expect(statuses[0]).toMatchObject({ usage: { fiveHourUsedPct: 71 } });
});

function report(update: unknown): {
  readonly payloads: readonly UsagePayloadEvent[];
  readonly statuses: readonly unknown[];
} {
  const bus = new ChatEventBus();
  const payloads: UsagePayloadEvent[] = [];
  const statuses: unknown[] = [];
  bus.on("usage.payload", (event) => payloads.push(event));
  bus.on("agent.status", (event) => statuses.push(event));
  createUsageReporter({
    agent: "claude",
    bus,
    cwd: "C:/repo",
    startedMs: Date.now(),
    turn: 3,
  }).recordAcpSessionUpdate(update);
  return { payloads, statuses };
}

/** Both diagnostics one update produces: the raw-shape trace and the normalized one. Asserting the
 *  PAIR rather than `.at(-1)` is deliberate — translating only the second would leave the raw trace
 *  still claiming "arrived" for an update that carried no windows, which is the original defect one
 *  layer down. */
function outcomes(payloads: readonly UsagePayloadEvent[]): readonly string[] {
  return payloads.map((payload) => payload.outcome);
}

it("FL-099 day 3: a /usage answer that LOSES the race is FORWARDED, not discarded", async () => {
  // F1, and it refutes day 2's headline. C1 built a receiver for a message the bridge never sent.
  //
  // Read out of the bytes rather than reasoned about: inside the PATCH(zer0 u2d-c) block `usageCall`
  // appeared exactly three times — its creation, a rejection swallow, and one `Promise.race` leg.
  // No `.then`, no second `await`. So when the 3 s timer won, `usageReceipt("timed-out")` went out
  // and the REAL answer resolved into nothing inside the bridge; and when the CALL won, its
  // `sessionUpdate` was awaited INLINE ahead of every settle path, so `slot.current` was still
  // installed and the standing listener was never involved. Either way the operator's 5h and weekly
  // windows never arrived, which is why they still saw `ctx 3%` alone after day 2 shipped.
  //
  // The missing half was the PRODUCER. On the timed-out branch the late answer is now forwarded as an
  // out-of-turn `usage_update` carrying the session's own id — exactly the shape
  // acp-lane-connection.ts's standing listener takes, and exactly the id its superseded-session guard
  // judges. It is deliberately NOT awaited: awaiting it would reintroduce the settlement stall the
  // 3 s bound exists to prevent, which is the trade the sibling bound test refuses.
  const [patch, installed] = await Promise.all([patchSource(), installedSource()]);

  for (const [label, source] of [
    ["the patch file", patch],
    ["the installed bytes", installed],
  ] as const) {
    const block = usageBlock(source);
    expect(
      block,
      `${label}: the late /usage answer is still dropped inside the bridge - the operator's 5h and weekly meters cannot arrive at all`,
    ).toMatch(/usageCall\s*\.\s*then\(/);
    expect(
      block.match(/_claude\/usageWindows/g)?.length ?? 0,
      `${label}: the late path must emit the SAME windows payload the inline path does`,
    ).toBe(2);
    expect(
      block,
      `${label}: the forwarded answer must name its session, or the standing listener's superseded-session guard has nothing to judge`,
    ).toMatch(/sessionId:\s*params\.sessionId/);
    // NEVER AWAITED. `await usageCall.then(...)` would suspend `case "result":` for the full length
    // of the call, which is precisely the post-answer dead screen the bound exists to cap.
    expect(
      block,
      `${label}: the late forward is awaited, so the bound no longer bounds anything`,
    ).not.toMatch(/await\s+usageCall\s*\.\s*then/);
    expect(
      block,
      `${label}: the late forward can reject after the session is gone and must swallow it`,
    ).toMatch(/usageCall\s*\.\s*then\([\s\S]*?\)\s*\.\s*catch\(/);
  }
});

it("N1: the late forward captures its usage NUMBERS, instead of reading a binding the next turn nulls", async () => {
  // THE DEFECT INSIDE F1'S OWN FIX, and it failed in exactly the shape it was written to close: the
  // slower the `/usage` call, the likelier the operator has already sent the next message, and from
  // that moment the forward carried nothing usable.
  //
  // Read at the bytes, both halves:
  //   dist/acp-agent.js:1116  `let lastAssistantTotalUsage = null;` is a runConsumer-scoped local,
  //                           NOT a per-prompt one.
  //   dist/acp-agent.js:1179  `resetTurnScratch()` nulls it, and
  //   dist/acp-agent.js:1238  `activateTurn` calls that the moment the NEXT turn becomes active.
  // A `.then` that reads the binding when it FIRES therefore emits `used: null` after turn N+1 starts,
  // and the client rejects the whole message on that one field — `usageFromUpdate`
  // (src/adapters/acp/acp-turn-session.ts:433-436) returns undefined when `typeof used !== "number"`,
  // taking the `_meta` windows down with it, so `recordAcpStatus` publishes nothing at all.
  //
  // Fixed on the PATCH side, deliberately, rather than by loosening the client: the parser's strictness
  // is correct — a `usage_update` with no numeric `used` is malformed — and the bridge is the side that
  // knows the right value. Capturing at the moment the race times out makes the late payload
  // byte-identical to what the inline path would have sent one branch above.
  const [patch, installed] = await Promise.all([patchSource(), installedSource()]);

  for (const [label, source] of [
    ["the patch file", patch],
    ["the installed bytes", installed],
  ] as const) {
    const block = usageBlock(source);
    // JUST THE HANDLER BODY. Slicing to the end of the block would also swallow the INLINE branch,
    // which reads `lastAssistantTotalUsage` directly and is right to: it runs synchronously inside the
    // same turn, before anything can reset it. The bug is only about the deferred read.
    const start = block.indexOf("usageCall.then(");
    const late = block.slice(start, block.indexOf("}).catch(", start));
    expect(
      late,
      `${label}: the late forward still reads the mutable binding - once the operator's next turn activates it is null and the client drops the windows with it`,
    ).not.toMatch(/used:\s*lastAssistantTotalUsage/);
    expect(
      late,
      `${label}: the late forward must send the numbers captured when the race timed out`,
    ).toMatch(/used:\s*lateUsedTokens/);
    expect(
      late,
      `${label}: the context window size must be captured with it, so the whole payload is one consistent sample`,
    ).toMatch(/size:\s*lateContextWindow/);
    // The capture has to happen BEFORE the handler is registered, or it is the same live read.
    expect(
      block.indexOf("const lateUsedTokens"),
      `${label}: the capture must precede the .then that closes over it`,
    ).toBeLessThan(block.indexOf("usageCall.then("));
  }
});

it("N1: a usage_update with a non-numeric `used` is dropped WINDOWS AND ALL - why the capture exists", () => {
  // The client behaviour that makes the bridge-side capture load-bearing, pinned so the reason cannot
  // quietly stop being true. This is NOT a bug being tolerated: a usage_update with no numeric `used`
  // is malformed, and a strict parser is right. It is recorded because it is the mechanism by which a
  // late forward silently loses the operator's meters.
  const windows = {
    "_claude/usageWindows": { five_hour: { utilization: 71, resets_at: 1_800_000_000 } },
  };
  const dropped = report({ sessionUpdate: "usage_update", used: null, size: 100, _meta: windows });
  expect(
    dropped.statuses,
    "a malformed usage_update published a status; the strictness this fix relies on is gone",
  ).toEqual([]);

  // The positive control, so the assertion above is the `used` check and not an inert fixture.
  const kept = report({ sessionUpdate: "usage_update", used: 40, size: 100, _meta: windows });
  expect(kept.statuses).toHaveLength(1);
  expect(kept.statuses[0]).toMatchObject({ usage: { fiveHourUsedPct: 71 } });
});

it("C: the late handler is registered BEFORE the awaited receipt, not after it", async () => {
  // THE HOLE INSIDE THE DAY-3 FIX. The timed-out branch reads, in source order:
  //     await usageReceipt("timed-out");
  //     ... const lateUsedTokens = ...; usageCall.then(...)
  // `usageReceipt` is an `async` function whose body is a single `await this.client.sessionUpdate(...)`
  // — a call across the ACP wire to the CLIENT, which can reject for reasons that have nothing to do
  // with the session being finished: a client handler that throws, a transport hiccup, a closed
  // connection on a session the operator is still using. If it does, the `await` throws out of the
  // branch and control jumps to the enclosing `catch`, so the `.then` is NEVER INSTALLED and the late
  // /usage answer is discarded exactly as it was before day 3 shipped. The whole FL-099 chain — the
  // operator's missing 5h and weekly meters — is undone by one rejected diagnostic.
  //
  // The fix is an ORDER SWAP and nothing else: register the handler first, then send the receipt. The
  // capture still precedes the handler (pinned by the N1 test above), the forward is still not
  // awaited (pinned by the day-3 test above), and the receipt still goes out on every timed-out turn.
  const [patch, installed] = await Promise.all([patchSource(), installedSource()]);

  for (const [label, source] of [
    ["the patch file", patch],
    ["the installed bytes", installed],
  ] as const) {
    const block = usageBlock(source);
    const registered = block.indexOf("usageCall.then(");
    const receipt = block.indexOf('await usageReceipt("timed-out")');
    expect(registered, `${label}: the late forward is gone`).toBeGreaterThan(-1);
    expect(receipt, `${label}: the timed-out receipt is gone`).toBeGreaterThan(-1);
    expect(
      registered,
      `${label}: the late /usage handler is registered AFTER an awaited receipt - if that await rejects on a session the operator is still using, the handler is never installed and the meters are dropped again`,
    ).toBeLessThan(receipt);
  }
});
