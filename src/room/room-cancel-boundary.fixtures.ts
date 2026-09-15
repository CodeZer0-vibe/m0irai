/**
 * @file src/room/room-cancel-boundary.fixtures.ts
 * @purpose The room-seam cancel harness (FL-133): a REAL AliveRoomHost over FAKE agent processes, so a
 *   cancel can be issued at the room boundary against lanes that are genuinely in flight.
 * @exports Gate, GeminiSlot, LaneScript, RoomCancelHarness, createRoomCancelHarness, terminalFor, authDownEvents
 * @depends node:fs/promises, node:os, node:path, execa, ../adapters/acp/acp-lane-session, ../chat/types,
 *   ./room-engine, ./room-host
 *
 * Real engine, real headless turn, real lane gate, real hold/transport, real carrier — every layer the
 * four cancellation defects live in. The ONLY thing replaced is the process seam itself: the ACP bridge
 * (`openConnection`, a first-class RoomHostOptions seam) and agy's dispatch (vi.mock'd by the consuming
 * test into {@link LaneScript}).
 *
 * WHY NOT THE STANDALONE ORACLE, which the brief pointed at: `ZER0_HERMETIC=1` refuses at the TOP of
 * every spawn function, before any I/O — `acp-session.ts:51`, `acp-turn-session.ts:339` and
 * `agy-pty-spawn.ts:20,39` all call `assertNotHermetic` as their first statement. A hermetic lane
 * therefore reaches its terminal within one microtask of `lane.started`; there is no in-flight window to
 * cancel into, and a cancel racing that refusal would be a flaky proof. A BLOCKING fake connection is
 * what creates the window, and it is the same seam `room-host-carrier.test.ts` already builds on.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import type { AgentName } from "../chat/types.js";
import type { RoomEvent } from "./room-engine.js";
import { AliveRoomHost } from "./room-host.js";

/** A promise plus its settlers — the only way a test can hold a seam open across an await boundary. */
export interface Gate<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Several gates are left unsettled or rejected-unobserved by design (the FL-146 window, teardown);
  // this keeps that from taking the whole vitest worker down as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * One fake agent process, scripted by the test.
 *
 * `opening` / `prompting` fire when a seam is ENTERED; `openRelease` / `promptRelease` decide when it
 * returns. That pair is what makes a race deterministic: the test cancels while the seam is provably
 * parked inside the window, instead of hoping the timing lands there.
 */
export class LaneScript {
  /** Fires the first time `openConnection` is entered for this agent. */
  public readonly opening: Gate<void> = gate<void>();
  /** Fires the first time the prompt seam is entered for this agent. */
  public readonly prompting: Gate<void> = gate<void>();
  /** Releases a parked open. Pre-settled: an open returns immediately unless {@link parkOpen} re-arms it. */
  public openRelease: Gate<void> = gate<void>();
  /** How an in-flight prompt ends when nothing kills it first. */
  public readonly promptRelease: Gate<string> = gate<string>();
  /** THE FL-146 OBSERVABLE: prompts actually delivered to the agent. A cancelled lane must show zero. */
  public prompts = 0;
  public opens = 0;
  private alive = true;
  private live: Gate<string> | undefined;

  public constructor(public readonly agent: AgentName) {
    this.openRelease.resolve(undefined);
  }

  /**
   * Re-arms the open gate so the next `openConnection` PARKS — the FL-146 window, held open on demand.
   * Returns the release, so the test can let the open finish after the cancel has already landed.
   */
  public parkOpen(): { release(): void } {
    const parked = gate<void>();
    this.openRelease = parked;
    return { release: () => parked.resolve(undefined) };
  }

  public async open(): Promise<LaneConnection> {
    this.opens += 1;
    this.opening.resolve(undefined);
    await this.openRelease.promise;
    return this.connection();
  }

  /**
   * gemini's seam, shaped like `dispatchAgy.withLaneState`. Its abort contract is production's:
   * `agy-runner.ts:113-115` REJECTS on abort rather than returning, which is why gemini already
   * reported `cancelled` correctly before any of this wave's fixes — and why gemini alone proves
   * nothing about the defect the operator saw.
   */
  public async agyDispatch(input: {
    readonly input: { readonly signal: AbortSignal };
  }): Promise<never> {
    this.prompts += 1;
    this.prompting.resolve(undefined);
    const signal = input.input.signal;
    return new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(new Error("agy dispatch aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      this.promptRelease.promise.then(
        () => reject(new Error("agy capture produced nothing")),
        (error: Error) => reject(error),
      );
    });
  }

  /**
   * Production's cancel throws no AbortError anywhere on the ACP path: the room drops the hold,
   * `closeConnection` (acp-lane-session.ts:206-220) closes the bridge child, and the in-flight
   * `prompt()` REJECTS with an ordinary transport message that `sendHeld`'s catch turns into a
   * `failed` send result. Reproduced exactly — a fake that rejected with an AbortError would let a
   * signal-blind carrier pass by accident, which is the whole defect FL-125 was.
   */
  private connection(): LaneConnection {
    return {
      initialize: async () => ({}),
      newSession: async () => ({ sessionId: `native-${this.agent}-1` }),
      resumeSession: async () => ({}),
      prompt: async () => this.runPrompt(),
      setMode: async () => undefined,
      close: () => {
        this.alive = false;
        this.live?.reject(new Error("bridge connection closed"));
      },
      waitForExit: async () => true,
      killTree: async () => undefined,
      isAlive: () => this.alive,
      pid: () => 4242,
    };
  }

  private runPrompt(): Promise<string> {
    this.prompts += 1;
    this.prompting.resolve(undefined);
    const live = gate<string>();
    this.live = live;
    this.promptRelease.promise.then(
      (reason) => live.resolve(reason),
      (error: Error) => live.reject(error),
    );
    return live.promise;
  }
}

/** The mutable slot a `vi.mock` factory reads gemini's script out of (the factory is hoisted above imports). */
export interface GeminiSlot {
  script?: LaneScript;
}

export interface RoomCancelHarness {
  readonly host: AliveRoomHost;
  readonly repoRoot: string;
  readonly events: RoomEvent[];
  readonly claude: LaneScript;
  readonly codex: LaneScript;
  readonly gemini: LaneScript;
  /** Resolves once every lane's prompt seam has been entered — the turn is genuinely in flight. */
  inFlight(): Promise<void>;
  dispose(): Promise<void>;
}

/** Stands up the room over the fake process seams. The caller owns `dispose()`. */
export async function createRoomCancelHarness(slot: GeminiSlot): Promise<RoomCancelHarness> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "room-cancel-"));
  // AliveRoomHost.create resolves its project liveness lock by shelling git, so the temp root has to be
  // a real repository. Checked rather than assumed: a silent `git init` failure would surface much later
  // as an unrelated "requires an exclusive scoped project liveness lock" throw out of create().
  const init = await execa("git", ["init", "-q"], { cwd: repoRoot, shell: false, reject: false });
  if (init.exitCode !== 0) {
    throw new Error(
      `room cancel harness could not git-init ${repoRoot} (exit ${String(init.exitCode)}): ${init.stderr}`,
    );
  }
  const scripts = new Map<AgentName, LaneScript>([
    ["claude", new LaneScript("claude")],
    ["codex", new LaneScript("codex")],
    ["gemini", new LaneScript("gemini")],
  ]);
  slot.script = scriptFor(scripts, "gemini");
  const events: RoomEvent[] = [];
  const host = await AliveRoomHost.create({
    repoRoot,
    dbPath: path.join(repoRoot, ".zer0", "evidence.db"),
    blobRoot: path.join(repoRoot, ".zer0", "blobs"),
    openConnection: async (input) => scriptFor(scripts, input.agent).open(),
    // Eager provider warm-up would spawn real bridges at boot. Its own room-level falsifier lives in
    // room-host-eager.test.ts; here it is stubbed so the cancel is the only thing under test.
    startEagerSessionBoot: () => ({
      claude: Promise.resolve({ outcome: "ready" as const }),
      codex: Promise.resolve({ outcome: "ready" as const }),
      gemini: Promise.resolve({ outcome: "ready" as const }),
    }),
    onEvent: (event) => {
      events.push(event);
    },
  });
  return {
    host,
    repoRoot,
    events,
    claude: scriptFor(scripts, "claude"),
    codex: scriptFor(scripts, "codex"),
    gemini: scriptFor(scripts, "gemini"),
    inFlight: async () => {
      await Promise.all([...scripts.values()].map((script) => script.prompting.promise));
    },
    dispose: async () => disposeHarness(host, repoRoot, scripts),
  };
}

async function disposeHarness(
  host: AliveRoomHost,
  repoRoot: string,
  scripts: Map<AgentName, LaneScript>,
): Promise<void> {
  for (const script of scripts.values()) {
    script.openRelease.resolve(undefined);
    script.promptRelease.reject(new Error("harness torn down"));
  }
  await host.shutdown().catch(() => undefined);
  await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
}

function scriptFor(scripts: Map<AgentName, LaneScript>, agent: AgentName): LaneScript {
  const script = scripts.get(agent);
  if (script === undefined) throw new Error(`no lane script for ${agent}`);
  return script;
}

/**
 * The terminal room event for one agent — the row the operator reads. The reducer maps exactly these
 * three to a transcript word (`reducer.rs:969` LanePhase, rendered by `room_scrollback.rs:705`).
 */
export function terminalFor(events: readonly RoomEvent[], agent: AgentName): RoomEvent | undefined {
  return events.find(
    (event) =>
      /^lane\.(cancelled|failed|completed)$/.test(event.type) && event.payload.agent === agent,
  );
}

/**
 * The room events that paint ` offline` on a chip. `room_runtime.rs`'s agent_is_offline reads
 * `auth == Down`, and `room-host-support.ts:140-142` is the ONE place a lane's `agent.status` becomes a
 * room event. The cancel contract says this list stays EMPTY.
 */
export function authDownEvents(
  events: readonly RoomEvent[],
  agent: AgentName,
): readonly RoomEvent[] {
  return events.filter(
    (event) =>
      event.type === "agent.status" &&
      event.payload.agent === agent &&
      event.payload.auth === "down",
  );
}
