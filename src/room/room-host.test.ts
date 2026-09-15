/**
 * @size-justified: FL-175 round 4 nit (c) — re-checked for a real extraction rather than just relabeling
 * this note. Found two genuine ones and took both: `recordAndSettle` (the record-then-settle-then-return
 * tail duplicated across three HeadlessTurnRunner fixtures) and `roomPaths` (the `.zer0/evidence.db` +
 * `.zer0/blobs` derivation repeated at all 9 createHost() call sites). That moved the file from 590 to
 * 577 lines, 23 under the 600 hard clamp rather than 10. What remains is nine distinct host-lifecycle
 * falsifiers, each needing its own real AliveRoomHost, its own fixture turn runner, and its own
 * assertions against durable session/DB state — no further shared seam was found; splitting by falsifier
 * count alone would relocate the line total across files rather than removing any of it.
 */
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { recordChatMessage } from "../chat/evidence.js";
import type { HeadlessTurnInput } from "../chat/headless-turn.js";
import { loadSession } from "../chat/session-store.js";
import type { LaneOutcome } from "../chat/tower-bridge-lane.js";
import type { ChatSession } from "../chat/types.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { RoomEvent } from "./room-engine.js";
import { AliveRoomHost, type RoomHostOptions, parseRoomInput } from "./room-host.js";
import {
  DEFAULT_POLL_TIMEOUT_MS,
  cleanupTestRoot,
  pollUntil,
} from "./room-test-cleanup.fixtures.js";

const roots: string[] = [];
// FL-175 round 3 BLOCKING: shutdown() rejection asserted on room-host.ts:294's 4_000 ms default, no
// override; RED via shutdownTimeoutMs: 1 ("...did not terminate" masking the injected error). Every host
// goes through this helper so a new call site can't miss it.
const SHUTDOWN_TIMEOUT_MS = 40_000;
const createHost = (options: Omit<RoomHostOptions, "shutdownTimeoutMs">): Promise<AliveRoomHost> =>
  AliveRoomHost.create({ ...options, shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS });
type HeadlessTurnRunner = NonNullable<RoomHostOptions["runHeadlessTurn"]>;
const readyEagerBoot: NonNullable<RoomHostOptions["startEagerSessionBoot"]> = () => ({
  claude: Promise.resolve({ outcome: "ready" }),
  codex: Promise.resolve({ outcome: "ready" }),
  gemini: Promise.resolve({ outcome: "ready" }),
});
async function tempGitRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  await execa("git", ["init"], { cwd: root, shell: false });
  return root;
}
// FL-175 round 4 nit (c): the second real seam this round found — the same two-line
// `.zer0/evidence.db` + `.zer0/blobs` derivation from `root` was repeated at every createHost() call
// site in this file (9 of them). Real duplication removed, not comments trimmed.
function roomPaths(root: string): { readonly dbPath: string; readonly blobRoot: string } {
  return {
    dbPath: path.join(root, ".zer0", "evidence.db"),
    blobRoot: path.join(root, ".zer0", "blobs"),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => cleanupTestRoot(root)));
});

function expectCanonicalHop(
  inputs: readonly HeadlessTurnInput[],
  events: readonly RoomEvent[],
  session: ChatSession,
  turnId: string,
): void {
  expect(inputs).toHaveLength(2);
  const firstMessageId = inputs[0]?.messageId;
  const secondMessageId = inputs[1]?.messageId;
  expect(firstMessageId).toMatch(/^msg-/u);
  expect(secondMessageId).toMatch(/^msg-/u);
  expect(inputs[0]?.grant).toEqual(CHAT_GRANT);
  expect(inputs[0]?.addresses[0]?.grant).toEqual(CHAT_GRANT);
  expect(Object.hasOwn(inputs[1] ?? {}, "grant")).toBe(false);
  expect(Object.hasOwn(inputs[1]?.addresses[0] ?? {}, "grant")).toBe(false);
  const committed = events.find(
    (event) => event.type === "message.committed" && event.payload.messageId === secondMessageId,
  );
  const persisted = session.messages.find((message) => message.id === secondMessageId);
  expect(events.map((event) => [event.type, event.payload.messageId])).toContainEqual([
    "message.committed",
    secondMessageId,
  ]);
  expect(committed?.payload.messageId).toBe(persisted?.id);
  expect(persisted?.roomProvenance).toEqual({
    origin: "agent-hop",
    replyTo: firstMessageId,
    rootTurnId: turnId,
    hopId: `hop:${turnId}:${firstMessageId}:claude:codex:1`,
    hopIndex: 1,
    hopBudget: 1,
    fromAgent: "claude",
    toAgent: "codex",
  });
  expect(events.filter((event) => event.type === "hop.blocked")).toHaveLength(1);
}

function expectLaneActivity(events: readonly RoomEvent[], turnId: string): void {
  expect(events.filter((event) => event.type === "lane.activity")).toEqual([
    expect.objectContaining({
      turnId,
      payload: {
        agent: "claude",
        laneId: expect.stringMatching(new RegExp(`^${turnId}:.+:claude:0$`, "u")),
        streamId: expect.stringMatching(new RegExp(`^stream:${turnId}:.+:claude:0$`, "u")),
        update: "tool_call",
        toolCallId: "tool-read-1",
        title: "Read src/room/room-host.ts",
        kind: "read",
        status: "in_progress",
      },
    }),
  ]);
}

// FL-175 round 4 nit (c): the record-then-settle-then-return tail below was duplicated near-verbatim in
// three HeadlessTurnRunner fixtures in this file (canonicalHopTurn, lostCommitTurn, activityTurn) —
// same recordChatMessage shape, same onLaneSettled call, same `[outcome]` return, differing only in
// which fields the caller filled in. Extracted as the real seam nit (c) asked for, in place of trimming
// comments to stay under the clamp: this is duplication removed, not relocated.
async function recordAndSettle(
  input: HeadlessTurnInput,
  dbPath: string,
  blobRoot: string,
  outcome: LaneOutcome,
): Promise<LaneOutcome[]> {
  const messageId = outcome.messageId;
  if (messageId === undefined) throw new Error("fixture requires a durable room message identity");
  await recordChatMessage({
    dbPath,
    blobRoot,
    sessionId: input.session.id,
    messageId,
    turn: input.turn,
    role: "agent",
    agent: outcome.agent,
    text: outcome.text,
    createdAt: outcome.messageCreatedAt ?? "2026-01-01T00:00:00.000Z",
    status: "completed",
    tokenEstimate: 1,
  });
  await input.onLaneSettled?.(outcome.agent, outcome);
  return [outcome];
}

function canonicalHopTurn(root: string, inputs: HeadlessTurnInput[]): HeadlessTurnRunner {
  return async (input) => {
    inputs.push(input);
    const agent = input.addresses[0]?.agent ?? "claude";
    const messageId = input.messageId;
    if (messageId === undefined)
      throw new Error("fixture requires a durable room message identity");
    const rawText =
      agent === "claude"
        ? "I checked the implementation.\n@codex: inspect"
        : "I reviewed the handoff.\n@gemini: forbidden";
    const { dbPath, blobRoot } = roomPaths(root);
    return recordAndSettle(input, dbPath, blobRoot, {
      agent,
      text: input.canonicalizeLaneText?.(agent, rawText) ?? rawText,
      exitCode: 0,
      state: "completed",
      messageId,
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
    });
  };
}

it("falsifier: operator grants, hop grants, canonical provenance, and the one-hop ceiling stay exact", async () => {
  const root = await tempGitRoot("zer0-room-host-");
  const inputs: HeadlessTurnInput[] = [];
  const events: RoomEvent[] = [];
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    onEvent: collectEvents(events),
    runHeadlessTurn: canonicalHopTurn(root, inputs),
  });
  const { turnId } = await host.submit({ requestId: "operator-1", text: "@claude start" });
  await waitFor(() => events.some((event) => event.type === "hop.blocked"));
  await host.shutdown();
  const session = await loadSession(host.sessionId() as `chat-${string}`, root);
  expectCanonicalHop(inputs, events, session, turnId);
  expect(session.messages.find((message) => message.agent === "claude")?.text).toBe(
    "I checked the implementation.",
  );
  expect(session.messages.some((message) => message.text.includes("@codex: inspect"))).toBe(false);
}, 60_000);

it("falsifier: a bare protocol submission targets the same visible @all room target as the composer", async () => {
  const root = await tempGitRoot("zer0-room-default-all-");
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    runLane: async () => ({ status: "completed", text: "done" }),
  });
  try {
    const submitted = await host.submit({ requestId: "bare", text: "look at this" });
    expect(submitted.targets).toEqual(["claude", "codex", "gemini"]);
  } finally {
    await host.shutdown();
  }
}, 90_000);

it("falsifier: a pre-dispatch blocked lane persists its canonical failure instead of becoming an internal error", async () => {
  const root = await tempGitRoot("zer0-room-blocked-lane-");
  const events: RoomEvent[] = [];
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    onEvent: collectEvents(events),
    // This is the exact contract of gateLaneOrBlock: it returns a failed outcome before adapter/finalize,
    // so onLaneSettled is intentionally never invoked.
    runHeadlessTurn: async () => [
      {
        agent: "codex",
        text: "",
        exitCode: 1,
        state: "failed",
        error: "sign-in required before retry",
      },
    ],
  });
  let stopped = false;
  try {
    await host.submit({ requestId: "blocked-1", text: "@codex hello" });
    await waitFor(() => events.some((event) => event.type === "lane.failed"));
    await host.shutdown();
    stopped = true;

    const session = await loadSession(host.sessionId() as `chat-${string}`, root);
    const queued = events.find((event) => event.type === "lane.queued");
    const failed = events.find((event) => event.type === "lane.failed");
    const message = session.messages.find((candidate) => candidate.agent === "codex");
    expect(message).toEqual(
      expect.objectContaining({
        id: queued?.payload.expectedMessageId,
        agent: "codex",
        status: "failed",
      }),
    );
    expect(message?.text).toContain("sign-in required before retry");
    expect(failed?.payload.error).toBe("sign-in required before retry");
    expect(failed?.payload.error).not.toContain("canonical persisted outcome");
  } finally {
    if (!stopped) await host.shutdown().catch(() => undefined);
  }
}, 60_000);

it("falsifier: shutdown aborts room usage capture and drops late telemetry", async () => {
  const root = await tempGitRoot("zer0-room-usage-shutdown-");
  const events: RoomEvent[] = [];
  let input: HeadlessTurnInput | undefined;
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    onEvent: collectEvents(events),
    runHeadlessTurn: async (candidate) => {
      input = candidate;
      return [
        {
          agent: "gemini",
          text: "",
          exitCode: 1,
          state: "failed",
          error: "blocked for lifecycle test",
        },
      ];
    },
  });
  await host.submit({ requestId: "usage-1", text: "@gemini test" });
  await waitFor(() => events.some((event) => event.type === "lane.failed"));
  await host.shutdown();

  expect(input?.usagePoll?.signal?.aborted).toBe(true);
  const count = events.length;
  input?.bus.emit({
    kind: "agent.status",
    agent: "gemini",
    usage: { label: "ctx", exhausted: false, contextUsedPct: 37 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toHaveLength(count);
  expect(events.some((event) => event.type === "agent.status")).toBe(false);
}, 60_000);

it("falsifier: an @file reference is room content, not an accidental default-agent address", () => {
  expect(parseRoomInput("@file src/main.rs", "claude").route.agents).toEqual([
    "claude",
    "codex",
    "gemini",
  ]);
});

function collectEvents(events: RoomEvent[]): (event: RoomEvent) => void {
  return function collect(event) {
    events.push(event);
  };
}

// FL-175: this file's 5_000 ms default measured failing under load (3 tests RED, tree 4087a2f).
async function waitFor(
  predicate: () => boolean,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<void> {
  await pollUntil(predicate, { timeoutMs, message: "room event did not arrive before timeout" });
}

it("falsifier: a later journal append failure rejects shutdown without a later success event", async () => {
  const root = await tempGitRoot("zer0-room-journal-");
  let appends = 0;
  const events: RoomEvent[] = [];
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    appendJournal: async () => {
      appends += 1;
      if (appends > 4) throw new Error("journal failed");
    },
    onEvent: collectEvents(events),
    runHeadlessTurn: async (input) => {
      const outcome: LaneOutcome = {
        agent: "claude",
        text: "done",
        exitCode: 0,
        state: "completed",
        messageId: "message-1",
        messageCreatedAt: "2026-01-01T00:00:00.000Z",
      };
      if (outcome.messageId === undefined || outcome.messageCreatedAt === undefined)
        throw new Error("fixture requires a durable agent identity");
      await recordChatMessage({
        ...roomPaths(root),
        sessionId: input.session.id,
        messageId: outcome.messageId,
        turn: input.turn,
        role: "agent",
        agent: "claude",
        text: outcome.text,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        tokenEstimate: 1,
      });
      await input.onLaneSettled?.("claude", outcome);
      return [outcome];
    },
  });
  await host.submit({ requestId: "request-1", text: "@claude start" });
  await expect(host.shutdown()).rejects.toThrow("journal failed");
  expect(events.some((event) => event.type === "session.saved")).toBe(false);
}, 90_000);

// FL-175: measured exceeding the vitest 30_000 ms global default under load (verify:staged tree 4087a2f).
it("recovers a DB-committed lane whose message event was lost before the journal write", async () => {
  const root = await tempGitRoot("zer0-room-recovery-");
  const { dbPath, blobRoot } = roomPaths(root);
  const runs = { value: 0 };
  const host = await createHost({
    repoRoot: root,
    dbPath,
    blobRoot,
    appendJournal: async (journalPath, line) => {
      const event = JSON.parse(line) as RoomEvent;
      if (event.type === "message.committed") throw new Error("injected commit write loss");
      await appendFile(journalPath, line, "utf8");
    },
    runHeadlessTurn: lostCommitTurn(dbPath, blobRoot, runs),
  });
  await host.submit({ requestId: "recovery-1", text: "@claude answer" });
  await waitFor(() => runs.value === 1);
  await expect(host.shutdown()).rejects.toThrow("injected commit write loss");

  let replayed = 0;
  const published: RoomEvent[] = [];
  const recovered = await createHost({
    repoRoot: root,
    dbPath,
    blobRoot,
    continueSessionId: host.sessionId() as `chat-${string}`,
    onEvent: collectEvents(published),
    startEagerSessionBoot: readyEagerBoot,
    runLane: async () => {
      replayed += 1;
      return { text: "should not run", status: "completed" };
    },
  });
  expect(
    recovered.eventsAfter("0").filter((event) => event.payload.recovered === true),
  ).toHaveLength(3);
  expect(published).toEqual([]);
  await recovered.activateRecovered();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(replayed).toBe(0);
  await recovered.control({ requestId: "publish-after-attach", command: "pause" });
  expect(published.map((event) => event.type)).toEqual(["agent.mode", "room.paused"]);
  await recovered.shutdown();
}, 90_000);

function lostCommitTurn(dbPath: string, blobRoot: string, runs: { value: number }) {
  return async (input: HeadlessTurnInput) => {
    runs.value += 1;
    const messageId = input.messageId;
    if (messageId === undefined)
      throw new Error("fixture requires a durable room message identity");
    return recordAndSettle(input, dbPath, blobRoot, {
      agent: "claude",
      text: "durable answer",
      exitCode: 0,
      state: "completed",
      messageId,
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
    });
  };
}

function emitActivityFixture(input: HeadlessTurnInput): void {
  input.bus.emit({
    kind: "permission.ask",
    agent: "claude",
    askId: "ask-safe-display",
    phase: "pending",
    toolTitle: "run migration\u001b[31m\u202e",
    options: [{ optionId: "allow-once", kind: "allow\u0007", name: "Allow\u200b once" }],
  });
  input.bus.emit({
    kind: "permission.ask",
    agent: "claude",
    askId: "ask-safe-display",
    phase: "settled",
    outcome: "invalidated",
  });
  input.bus.emit({
    kind: "agent.status",
    agent: "claude",
    auth: "limited",
    usage: {
      label: "sensitive display prose stays local",
      exhausted: true,
      contextUsedPct: 42.4,
      fiveHourUsedPct: 71,
      fiveHourResetsAtMs: 4_102_444_800_000,
      weeklyUsedPct: 81,
    },
    availability: {
      state: "needs_auth",
      reason: "raw remediation stays local",
      resetsAtMs: 4_102_444_800_000,
    },
  });
  input.onLaneActivity?.("claude", {
    update: "tool_call",
    toolCallId: "tool-read-1",
    title: "Read src/room/room-host.ts",
    kind: "read",
    status: "in_progress",
  });
}

function activityTurn(root: string): HeadlessTurnRunner {
  return async (input) => {
    emitActivityFixture(input);
    const { dbPath, blobRoot } = roomPaths(root);
    return recordAndSettle(input, dbPath, blobRoot, {
      agent: "claude",
      text: "done",
      exitCode: 0,
      state: "completed",
      messageId: "message-activity-1",
      messageCreatedAt: "2026-01-01T00:00:00.000Z",
    });
  };
}

it("falsifier: provider activity and privacy-safe status cross the real room bus", async () => {
  const root = await tempGitRoot("zer0-room-activity-");
  const events: RoomEvent[] = [];
  const host = await createHost({
    repoRoot: root,
    ...roomPaths(root),
    onEvent: collectEvents(events),
    runHeadlessTurn: activityTurn(root),
  });
  const { turnId } = await host.submit({ requestId: "activity-1", text: "@claude inspect" });
  await host.shutdown();
  expectLaneActivity(events, turnId);
  expect(events.filter((event) => event.type === "agent.status")).toEqual([
    expect.objectContaining({
      turnId,
      payload: {
        agent: "claude",
        auth: "limited",
        usage: {
          exhausted: true,
          contextUsedPct: 42,
          fiveHourUsedPct: 71,
          fiveHourResetsAtMs: 4_102_444_800_000,
          weeklyUsedPct: 81,
        },
        availability: { state: "needs_auth", resetsAtMs: 4_102_444_800_000 },
      },
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("sensitive display prose");
  expect(JSON.stringify(events)).not.toContain("raw remediation");
  const permission = events.find((event) => event.type === "permission.requested");
  expect(permission?.payload).toMatchObject({
    toolTitle: "run migration\\x1b[31m\\u202e",
    options: [{ optionId: "allow-once", kind: "allow\\x07", name: "Allow\\u200b once" }],
  });
  expect(JSON.stringify(permission)).not.toContain("\u001b");
}, 90_000);

// FL-175: same real-headroom rationale as the recovery test above (two host lifecycles, one waitFor).
it("preserves a paused queued lane across shutdown and starts it once after resume", async () => {
  const root = await tempGitRoot("zer0-room-queued-reopen-");
  const { dbPath, blobRoot } = roomPaths(root);
  let firstRuns = 0;
  const first = await createHost({
    repoRoot: root,
    dbPath,
    blobRoot,
    runLane: async () => {
      firstRuns += 1;
      return { text: "unexpected", status: "completed" };
    },
  });
  await first.control({ requestId: "pause", command: "pause" });
  await first.submit({ requestId: "queued", text: "@claude work" });
  expect(firstRuns).toBe(0);
  const sessionId = first.sessionId() as `chat-${string}`;
  await first.shutdown();

  let recoveredRuns = 0;
  const recovered = await createHost({
    repoRoot: root,
    dbPath,
    blobRoot,
    continueSessionId: sessionId,
    runLane: recoveredQueuedLane(() => {
      recoveredRuns += 1;
    }),
  });
  const queued = recovered.eventsAfter("0").filter((event) => event.type === "lane.queued");
  await recovered.activateRecovered();
  expect(recoveredRuns).toBe(0);
  await recovered.control({ requestId: "resume", command: "resume" });
  await waitFor(() => recoveredRuns === 1);
  const events = recovered.eventsAfter("0");
  expect(queued).toHaveLength(1);
  expect(events.filter((event) => event.type === "lane.started")).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "lane.cancelled" && event.payload.queued === true),
  ).toHaveLength(0);
  await recovered.shutdown();
}, 90_000);

function recoveredQueuedLane(onRun: () => void) {
  return async (lane: import("./room-engine.js").RoomLane) => {
    if (lane.expectedMessageId === undefined)
      throw new Error("recovered lane lacks durable output identity");
    onRun();
    return {
      text: "done",
      status: "completed" as const,
      messageId: lane.expectedMessageId,
      ledgerSeq: "2",
    };
  };
}

it("falsifier: the scoped project lock rejects a second host and releases after shutdown", async () => {
  const root = await tempGitRoot("zer0-room-lock-");
  const options = {
    repoRoot: root,
    ...roomPaths(root),
  };
  const first = await createHost(options);
  await expect(createHost(options)).rejects.toThrow("exclusive scoped project liveness lock");
  await first.shutdown();
  const reopened = await createHost(options);
  await reopened.shutdown();
}, 90_000);
