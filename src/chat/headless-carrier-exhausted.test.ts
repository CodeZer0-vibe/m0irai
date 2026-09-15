/**
 * @file src/chat/headless-carrier-exhausted.test.ts
 * @purpose THE OPERATOR'S 15:20 SIGHTING, pinned on the shipped lane: codex answered with its vendor
 *   limit sentence, the row said `codex — failed: carrier failed`, and the status bar kept reading
 *   `codex auto` — no meters, no offline. The bridge did not REJECT that turn: it delivered the
 *   sentence as ordinary assistant text and ended with a non-`end_turn` stop reason, so
 *   `lane-hold.ts`'s `sendHeld` returned `message: "stopReason=<x>"` and the classifier
 *   (`lane-availability.ts`'s `classifyLaneFailure`) was handed a five-word diagnostic that says
 *   nothing about usage. The sentence itself — the only carrier of the fact — was never offered to it.
 * @exports (test suite — no runtime exports)
 * @depends node:fs/promises, node:os, node:path, vitest, ../evidence/db, ../shared/agent-grant,
 *   ../shared/types, ./dispatch-headless, ./events, ./evidence, ./evidence-identity, ./headless-turn,
 *   ./lane-availability-store, ./lane-transport, ./types
 *
 * THE WHOLE LANE, not a unit of it: `runHeadlessTurn` -> `runCarrierHeadlessLane` ->
 * `dispatchAcpCarrier` -> the real held transport -> `recordLaneDispatchResult`. `openConnection` is
 * the ONE injected seam, standing where the codex bridge child would be, and its `prompt` reproduces
 * exactly what the vendor did: stream the limit sentence, then answer with a stop reason that is not
 * `end_turn`.
 *
 * WHY `refusal` IS THE STOP REASON NAMED HERE. The ACP schema's `StopReason` is
 * `"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"`
 * (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:3040`), and a turn the agent
 * declined to complete is `refusal` by elimination — it was not cancelled, it did not run out of
 * tokens or turns, and it plainly did not end its turn. I could NOT capture the real value: that
 * needs a live codex bridge at its usage limit, which is operator-gated and, by definition, only
 * reproducible when the account is actually spent. UNVERIFIED, and deliberately not load-bearing —
 * the assertions below hold for EVERY non-`end_turn` value, which is why the second case runs
 * `max_tokens` through the same fixture and demands the opposite answer.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenAcpLaneConnectionInput } from "../adapters/acp/acp-lane-connection.js";
import { deliverLaneUpdate, laneEmitSlot } from "../adapters/acp/acp-lane-update-routing.js";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import type { AgentResult } from "../shared/types.js";
import { resetClaudeWindowFold } from "./claude-usage-fold.js";
import type { HeadlessDispatch } from "./dispatch-headless.js";
import { ChatEventBus } from "./events.js";
import { chatRunId } from "./evidence-identity.js";
import { recordChatSession } from "./evidence.js";
import { runHeadlessTurn } from "./headless-turn.js";
import { getLaneAvailability, resetLaneAvailabilityStore } from "./lane-availability-store.js";
import { plausiblyReset } from "./lane-availability.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";
import type { ChatSession } from "./types.js";

/** The operator's own row, verbatim from the 15:20 screenshot and the `chat_messages` blob. */
const VENDOR_LIMIT_TEXT =
  "You’ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at Aug 27th, 2026 8:54 AM.";

const dirs: string[] = [];
const savedFlags = { memory: process.env.ZER0_MEMORY, resume: process.env.ZER0_NATIVE_RESUME };

afterEach(async () => {
  resetCarrierRuntime();
  resetLaneAvailabilityStore();
  restoreFlag("ZER0_MEMORY", savedFlags.memory);
  restoreFlag("ZER0_NATIVE_RESUME", savedFlags.resume);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function restoreFlag(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

interface Fixture {
  readonly session: ChatSession;
  readonly dbPath: string;
  readonly blobRoot: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "day2b-exhausted-"));
  dirs.push(root);
  const runDir = path.join(root, "run");
  await mkdir(path.join(runDir, "prompts"), { recursive: true });
  await mkdir(path.join(runDir, "responses"), { recursive: true });
  const blobRoot = path.join(root, "blobs");
  await mkdir(blobRoot, { recursive: true });
  const dbPath = path.join(root, "evidence.db");
  const now = new Date().toISOString();
  const id = "chat-day2b-exhausted" as const;
  await recordChatSession({
    dbPath,
    sessionId: id,
    runId: chatRunId(id),
    repoRoot: root,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "codex",
    lastAgent: null,
    summaryText: "",
    summaryThroughTurn: 0,
  });
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", root, path.join(root, ".git"), now);
  closeDb(db);
  return {
    session: {
      id,
      repoRoot: root,
      runDir,
      createdAt: now,
      updatedAt: now,
      defaultAgent: "codex" as const,
      lastAgent: null,
      summary: { text: "", throughTurn: 0 },
      messages: [],
    },
    dbPath,
    blobRoot,
  };
}

/** The real carrier registry and the real held transport; this fake stands where the codex bridge
 *  child is and reproduces the vendor's shape — text out, then a stop reason that is not end_turn. */
function initLimitedCarrier(fx: Fixture, text: string, stopReason: string): void {
  initCarrierRuntime({
    projectId: "p1",
    dbPath: fx.dbPath,
    repoRoot: fx.session.repoRoot,
    cwd: fx.session.repoRoot,
    openConnection: async (input) => ({
      initialize: async () => ({}),
      newSession: async () => ({ sessionId: "s-codex" }),
      resumeSession: async () => ({}),
      prompt: async () => {
        input.onText?.(text);
        return stopReason;
      },
      setMode: async () => undefined,
      close: () => undefined,
      waitForExit: async () => true,
      killTree: async () => undefined,
      isAlive: () => true,
      pid: () => 31337,
    }),
  });
}

async function runOneCodexTurn(fx: Fixture, bus: ChatEventBus) {
  const dispatch: HeadlessDispatch = async (): Promise<AgentResult> => {
    throw new Error("the buffered non-carrier dispatch must not run on this path");
  };
  return runHeadlessTurn({
    session: fx.session,
    addresses: [{ agent: "codex", prompt: "answer me" }],
    bus,
    turn: 1,
    laneClass: "chat",
    grant: CHAT_GRANT,
    config: { dbPath: fx.dbPath, blobRoot: fx.blobRoot },
    signal: new AbortController().signal,
    dispatch,
  });
}

/** Collects every `agent.status` this turn publishes. The bus is per-kind, so this subscribes to the
 *  one kind the chip rides on rather than to everything. */
function collectStatuses(bus: ChatEventBus): unknown[] {
  const seen: unknown[] = [];
  bus.on("agent.status", (event) => seen.push(event));
  return seen;
}

/** The availability half of those chips, in order — an `auth`-only status carries none. */
function availabilityChips(statuses: readonly unknown[]): unknown[] {
  return statuses
    .map((event) => (event as { availability?: unknown }).availability)
    .filter((availability) => availability !== undefined);
}

it("codex answering with its usage-limit sentence marks the lane exhausted, so the chip reads offline", async () => {
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const fx = await makeFixture();
  initLimitedCarrier(fx, VENDOR_LIMIT_TEXT, "refusal");
  const bus = new ChatEventBus();
  const statuses = collectStatuses(bus);

  const outcomes = await runOneCodexTurn(fx, bus);

  // THE DEFECT, in one assertion. `exhausted` is the state the Rust footer renders as " offline"
  // (room_runtime.rs's agent_is_offline / footer_agent_cell); on the merged tree this list is empty,
  // because a failure that never classified records nothing at all and the chip keeps its old word.
  const chips = availabilityChips(statuses);
  expect(
    chips,
    "codex hit its usage limit and no availability chip was published - the status bar keeps reading `codex auto`",
  ).toContainEqual(
    expect.objectContaining({
      state: "exhausted",
      // The zer0 wording, never the vendor's remediation line (lane-availability.ts's reasonForClass).
      reason: "this lane is out of usage for now",
    }),
  );
  // A block that can never lift is the other half of the bug: recovery must always be reachable — but
  // ITEM B moved that deadline OFF the published chip. The vendor reported no rate window here (the
  // fact arrived as prose, not as structured data), so a published instant could only ever have been
  // the fallback cooldown — and the terminal retires the painted health state the moment that instant
  // passes, so the operator's red `out of usage` would vanish 15 minutes into a multi-day exhaustion.
  // So the two halves are now asserted where each is true: the chip carries NO reset, and reachability
  // is checked on the durable record the gate actually reads.
  const chip = chips.at(-1) as { resetsAtMs?: number };
  expect(
    chip.resetsAtMs,
    "the fallback cooldown was published as a reset instant - the footer drops `out of usage` fifteen minutes into an exhaustion the vendor said lasts days",
  ).toBeUndefined();
  const durable = getLaneAvailability("codex");
  expect(
    durable.probeAtMs,
    "an exhausted lane with no probe deadline is blocked forever",
  ).toBeTypeOf("number");
  expect(plausiblyReset(durable, (durable.probeAtMs ?? 0) + 1)).toBe(true);

  // AND THE OPERATOR STILL SEES THE VENDOR'S SENTENCE. It is the useful half of the row — the
  // classification rides beside it, never in place of it.
  expect(outcomes[0]?.text, "the vendor's own sentence must still reach the row").toContain(
    "usage limit",
  );
  expect(outcomes[0]?.state).toBe("failed");
});

it("the same lane on max_tokens is NOT a death - an ordinary non-end_turn stop leaves it ready", async () => {
  // THE FALSIFIER, and the reason the fix reads the TEXT rather than the stop reason. Every signal
  // here fires on "not end_turn"; if that alone marked a lane dead, a turn truncated at the token
  // ceiling would take codex offline for fifteen minutes. The delivered text is what separates them.
  process.env.ZER0_MEMORY = "1";
  process.env.ZER0_NATIVE_RESUME = "1";
  const fx = await makeFixture();
  initLimitedCarrier(fx, "here is the first half of the answer", "max_tokens");
  const bus = new ChatEventBus();
  const statuses = collectStatuses(bus);

  await runOneCodexTurn(fx, bus);

  expect(
    availabilityChips(statuses),
    "an ordinary truncated turn must never mark the lane dead",
  ).toEqual([]);
});

/**
 * A2 — THE SUPPLY CHAIN, END TO END, WITH NOTHING CONSTRUCTED BY HAND.
 *
 * `fe3c939` closed one link of this chain and its own commit message named the disease: "the guard
 * could be perfect and dead at the same time." That was still true of the two links ABOVE it. The
 * reviewer proved it: dropping the spread at `lane-hold.ts:188` (so the opener is never handed
 * `onSessionUpdate`) left 1056 tests green, and dropping `standing: input.onSessionUpdate` in
 * `acp-lane-connection.ts` left 1056 tests green. Sever either and `slot.standing` is `undefined` in
 * production while every routing test passes, because they all build their `EmitSlot` themselves.
 *
 * So this builds nothing itself. It drives the REAL `runHeadlessTurn` -> `headless-carrier` ->
 * `lane-transport` -> `lane-hold` chain with `openConnection` as the only seam, captures the input the
 * opener is ACTUALLY handed, feeds that input to the REAL `laneEmitSlot` that `openAcpLaneConnection`
 * uses, and routes a post-settle update through the REAL `deliverLaneUpdate` into a REAL usage
 * reporter. Every link is production code; a break anywhere along it fails here.
 */
/** The real carrier registry with a fake bridge child that CAPTURES the input the opener is handed.
 *  A getter rather than a value, because the open happens inside the turn. */
function initCapturingCarrier(fx: Fixture): () => OpenAcpLaneConnectionInput | undefined {
  let opened: OpenAcpLaneConnectionInput | undefined;
  initCarrierRuntime({
    projectId: "p1",
    dbPath: fx.dbPath,
    repoRoot: fx.session.repoRoot,
    cwd: fx.session.repoRoot,
    openConnection: async (input) => {
      opened = input;
      return {
        initialize: async () => ({}),
        newSession: async () => ({ sessionId: "s-codex" }),
        resumeSession: async () => ({}),
        prompt: async () => {
          input.onText?.("done");
          return "end_turn";
        },
        setMode: async () => undefined,
        close: () => undefined,
        waitForExit: async () => true,
        killTree: async () => undefined,
        isAlive: () => true,
        pid: () => 31337,
      };
    },
  });
  return () => opened;
}

/** The late `/usage` answer, in the shape the fixed bridge forwards after losing its own 3 s race. */
const LATE_WINDOWS_UPDATE = {
  sessionUpdate: "usage_update",
  used: 40,
  size: 100,
  _meta: { "_claude/usageWindows": { five_hour: { utilization: 71, resets_at: 1_800_000_000 } } },
} as const;

it("A2: the LIVE chain supplies onSessionUpdate all the way to the slot, and a post-settle update publishes meters", async () => {
  resetClaudeWindowFold();
  const fx = await makeFixture();
  const bus = new ChatEventBus();
  const statuses = collectStatuses(bus);
  const capturedInput = initCapturingCarrier(fx);

  await runOneCodexTurn(fx, bus);
  const opened = capturedInput();

  // LINK 1 — lane-hold.ts's openFresh actually spreads the tap onto the opener's input.
  expect(
    typeof opened?.onSessionUpdate,
    "the LIVE caller did not supply onSessionUpdate - slot.standing would be undefined in production",
  ).toBe("function");

  // LINK 2 — the slot the real opener builds from that input installs it as the STANDING listener.
  const slot = laneEmitSlot(opened as OpenAcpLaneConnectionInput);
  expect(
    typeof slot.standing,
    "openAcpLaneConnection built a slot with no standing listener - a late /usage answer has nowhere to land",
  ).toBe("function");

  // ...and the whole thing carries a real reading. The turn is over; this is the late answer.
  const before = statuses.length;
  deliverLaneUpdate(slot, LATE_WINDOWS_UPDATE, "s-codex");
  expect(
    statuses.length,
    "the live chain is wired but a post-settle update still published nothing",
  ).toBeGreaterThan(before);
  expect(statuses.at(-1)).toMatchObject({ usage: { fiveHourUsedPct: 71 } });
});
