/**
 * @file src/room/room-host-support.ts
 * @purpose Owns room-host bootstrap, projection, routing, catalog, cancel-drop, timeout, and journal helpers.
 * @exports ActivePermissionContext, initializeRoomSession, buildRoomCatalogSnapshot, roomSessionTitle, readinessEvent, roomEventNotification, roomPermissionText, roomAgentStatusPayload, parseRoomInput, dropCancelledLaneHold, beforeDeadline, asError, appendJournalLine, loadRoomJournal
 * @depends ./room-boot-stages, ./room-usage-fold, node:fs/promises, ../adapters/acp/acp-permission, ../chat/agent-commands/catalog, ../chat/agent-commands/types, ../chat/events, ../chat/lane-transport, ../chat/message-router, ../chat/session-store, ../chat/types, ../shared/render-escape, ../shared/room-notice, ./room-host-contract, ./room-transcript-recovery
 */
import { appendFile, readFile, stat, truncate } from "node:fs/promises";
import type { PermissionDecider } from "../adapters/acp/acp-permission.js";
import { loadAgentCommands } from "../chat/agent-commands/catalog.js";
import { isSafeCommandName } from "../chat/agent-commands/types.js";
import {
  type AgentStatusUpdateEvent,
  ChatEventBus,
  type ModeSessionEvent,
} from "../chat/events.js";
import { dropLaneHold, initCarrierRuntime, setCarrierLaneScope } from "../chat/lane-transport.js";
import { parseInput } from "../chat/message-router.js";
import { createSession } from "../chat/session-store.js";
import type { AgentName, ChatSession } from "../chat/types.js";
import { escapeUntrusted } from "../shared/render-escape.js";
import type { RoomNotice } from "../shared/room-notice.js";
import { bootProgressSteps } from "./room-boot-stages.js";
import type { RoomEvent, RoomEventType, RoomLane } from "./room-engine-contract.js";
import type { RoomHostOptions } from "./room-host-contract.js";
import { openRoomTranscript } from "./room-transcript-recovery.js";
import type { RoomUsageFold } from "./room-usage-fold.js";

export interface ActivePermissionContext {
  readonly lane: RoomLane;
  readonly bus: ChatEventBus;
  readonly decider?: PermissionDecider;
}

export async function initializeRoomSession(
  options: RoomHostOptions,
  projectId: string,
  signal: AbortSignal,
): Promise<ChatSession> {
  initCarrierRuntime({
    projectId,
    dbPath: options.dbPath,
    repoRoot: options.repoRoot,
    cwd: options.repoRoot,
    signal,
    ...(options.openConnection === undefined ? {} : { openConnection: options.openConnection }),
  });
  // The carrier open above is where a first boot pays the lane-tier migration; the session read below
  // is a separate cost with a separate failure mode, so the two are separate stages on the wire.
  await bootProgressSteps(options.onBootProgress).session();
  const session =
    options.continueSessionId === undefined
      ? await createSession(options.repoRoot)
      : await openRoomTranscript({
          sessionId: options.continueSessionId,
          repoRoot: options.repoRoot,
          // Reopening a damaged room is the one boot event an operator must hear about, and stderr is
          // where every other host diagnostic already goes.
          report: (line) => process.stderr.write(`${line}\n`),
        });
  setCarrierLaneScope(session.id);
  return session;
}

const ROOM_CATALOG_AGENTS = ["claude", "codex", "gemini"] as const satisfies readonly AgentName[];
const ROOM_CATALOG_ROW_LIMIT = 64;
const ROOM_CATALOG_DESCRIPTION_BYTES = 240;
const ROOM_SESSION_TITLE_SOURCE_CHARS = 120;

export function buildRoomCatalogSnapshot(repoRoot: string): Readonly<Record<string, unknown>> {
  const agents = Object.fromEntries(
    ROOM_CATALOG_AGENTS.map((agent) => [
      agent,
      loadAgentCommands(agent, { cwd: repoRoot })
        .filter((row) => agent !== "gemini" || row.kind !== "skill")
        .filter((row) => isSafeCommandName(row.name))
        .slice(0, ROOM_CATALOG_ROW_LIMIT)
        .map((row) => ({
          name: row.name,
          description: clipUtf8(
            escapeUntrusted(row.description, { maxLen: ROOM_CATALOG_DESCRIPTION_BYTES }),
            ROOM_CATALOG_DESCRIPTION_BYTES,
          ),
          kind: row.kind,
          trusted: row.trusted,
        })),
    ]),
  );
  return { version: 1, agents };
}

export function roomSessionTitle(session: ChatSession): string {
  const firstPrompt = session.messages.find((message) => message.role === "user")?.text;
  const source = (firstPrompt ?? session.summary.text).replace(/\s+/gu, " ").trim();
  if (source.length === 0) return "New Zer0 conversation";
  return clipUtf8(
    escapeUntrusted(source, { maxLen: ROOM_SESSION_TITLE_SOURCE_CHARS }),
    ROOM_CATALOG_DESCRIPTION_BYTES,
  );
}

export function readinessEvent(sessionId: string): RoomEvent {
  return {
    protocol: "zer0.room",
    version: 1,
    sessionId,
    eventSeq: "0",
    eventId: "room-ready",
    turnId: "room",
    occurredAt: new Date().toISOString(),
    type: "session.saved",
    payload: { ready: true },
  };
}

export function roomEventNotification(event: RoomEvent): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", method: "zer0/room/event", params: event };
}

function clipUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let clipped = bytes.subarray(0, maxBytes);
  while (clipped.length > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(clipped);
    } catch {
      clipped = clipped.subarray(0, clipped.length - 1);
    }
  }
  return "";
}

interface RoomBusOptions {
  readonly turnId: string;
  /** FL-094: the room-owned, per-agent fold that makes every outgoing status carry every window the room
   *  still knows about. OWNED by AliveRoomHost and injected, never constructed here — createBus runs once
   *  per boot and once per lane (room-host.ts), so a fold born in this function would be reborn every turn
   *  and carry nothing forward. */
  readonly usageFold: RoomUsageFold;
  readonly lane?: RoomLane;
  readonly isShuttingDown: () => boolean;
  readonly notify: (
    turnId: string,
    type: RoomEventType,
    payload: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onMode: (event: ModeSessionEvent) => void;
  /** Raises one non-fatal condition. The ENGINE owns the once-per-cause rule, not this bus: a bus is
   *  built per lane and per boot, so a gate living here would be reborn every turn and forget. */
  readonly notice: (turnId: string, notice: RoomNotice) => void;
}

export function createRoomBus(input: RoomBusOptions): ChatEventBus {
  const bus = new ChatEventBus();
  bus.on("agent.status", (event) => {
    if (!input.isShuttingDown())
      input.notify(input.turnId, "agent.status", roomAgentStatusPayload(foldUsage(input, event)));
  });
  bus.on("mode.session", (event) => {
    if (!input.isShuttingDown()) input.onMode(event);
  });
  bus.on("permission.ask", (event) => {
    if (input.isShuttingDown()) return;
    input.notify(
      input.turnId,
      event.phase === "pending" ? "permission.requested" : "permission.resolved",
      permissionPayload(event),
    );
  });
  bus.on("room.notice", (event) => {
    // Suppressed during shutdown for the same reason every other bus row is: during teardown every
    // lane is being torn down anyway, and a notice minted there describes the shutdown, not the room.
    if (input.isShuttingDown()) return;
    input.notice(input.turnId, {
      cause: event.cause,
      ...(event.agent === undefined ? {} : { agent: event.agent }),
      detail: event.detail,
    });
  });
  if (input.lane !== undefined) bus.on("agent.stdout", (event) => input.lane?.onChunk(event.chunk));
  return bus;
}

/**
 * A status with NO usage object is passed through untouched, and that is load-bearing twice over: the
 * reducer INHERITS the prior usage for exactly that shape (reducer.rs:668), and eager boot publishes
 * auth-only statuses — attaching a usage object here would resurrect the boot meters P1 removes.
 */
function foldUsage(input: RoomBusOptions, event: AgentStatusUpdateEvent): AgentStatusUpdateEvent {
  const usage = event.usage;
  return usage === undefined
    ? event
    : { ...event, usage: input.usageFold.fold(event.agent, usage) };
}

function permissionPayload(
  event: Parameters<Parameters<ChatEventBus["on"]>[1]>[0] & { readonly kind: "permission.ask" },
): Readonly<Record<string, unknown>> {
  return {
    agent: event.agent,
    askId: event.askId,
    ...(event.options === undefined
      ? {}
      : {
          options: event.options.slice(0, 9).map((option) => ({
            optionId: option.optionId,
            ...(option.kind === undefined ? {} : { kind: roomPermissionText(option.kind, 120) }),
            ...(option.name === undefined ? {} : { name: roomPermissionText(option.name, 120) }),
          })),
        }),
    ...(event.toolTitle === undefined
      ? {}
      : { toolTitle: roomPermissionText(event.toolTitle, 240) }),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(event.optionId === undefined ? {} : { optionId: event.optionId }),
  };
}

export function roomPermissionText(value: string, maxBytes: number): string {
  const escaped = escapeUntrusted(value, { maxLen: maxBytes });
  if (Buffer.byteLength(escaped, "utf8") <= maxBytes) return escaped;
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let clipped = "";
  for (const character of escaped) {
    if (Buffer.byteLength(clipped + character, "utf8") > budget) break;
    clipped += character;
  }
  return `${clipped}${suffix}`;
}

export function roomAgentStatusPayload(
  event: AgentStatusUpdateEvent,
): Readonly<Record<string, unknown>> {
  const usage = event.usage;
  const availability = event.availability;
  return {
    agent: event.agent,
    ...(event.auth === undefined ? {} : { auth: event.auth }),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            exhausted: usage.exhausted,
            ...roomPercent("contextUsedPct", usage.contextUsedPct),
            ...roomPercent("fiveHourUsedPct", usage.fiveHourUsedPct),
            ...roomReset("fiveHourResetsAtMs", usage.fiveHourResetsAtMs),
            ...roomPercent("weeklyUsedPct", usage.weeklyUsedPct),
            ...roomReset("weeklyResetsAtMs", usage.weeklyResetsAtMs),
          },
        }),
    ...(availability === undefined
      ? {}
      : {
          availability: {
            state: availability.state,
            ...roomReset("resetsAtMs", availability.resetsAtMs),
          },
        }),
  };
}

function roomPercent(field: string, value: number | undefined): Readonly<Record<string, number>> {
  return value === undefined ? {} : { [field]: Math.round(value) };
}

function roomReset(field: string, value: number | undefined): Readonly<Record<string, number>> {
  return value === undefined || !Number.isSafeInteger(value) ? {} : { [field]: value };
}

/** Preserve the room's visible @all default for direct protocol clients. */
export function parseRoomInput(
  text: string,
  defaultAgent: AgentName,
): ReturnType<typeof parseInput> {
  const trimmed = text.trim();
  const parsed = /^(?:@(claude|codex|gemini|all)\b|\/)/iu.test(trimmed)
    ? parseInput(text, defaultAgent)
    : parseInput(`@all ${text}`, defaultAgent);
  if (!trimmed.startsWith("/")) return parsed;
  if (parsed.route.slashCommand !== "council") {
    throw new Error("unsupported room command; type /help for available commands");
  }
  if (parsed.text.length === 0) throw new Error("/council requires a topic");
  return parsed;
}

export function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  message: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), remaining);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function appendJournalLine(journalPath: string, line: string): Promise<void> {
  return appendFile(journalPath, line, "utf8");
}

export async function loadRoomJournal(
  journalPath: string,
  maxBytes: number,
  maxEvents: number,
): Promise<RoomEvent[]> {
  try {
    const metadata = await stat(journalPath);
    if (metadata.size > maxBytes) throw new Error(`room journal exceeds ${maxBytes} bytes`);
    let raw = await readFile(journalPath);
    if (raw.length > 0 && raw.at(-1) !== 0x0a) {
      const lastLf = raw.lastIndexOf(0x0a);
      const durableBytes = lastLf + 1;
      await truncate(journalPath, durableBytes);
      raw = raw.subarray(0, durableBytes);
    }
    const lines = raw
      .toString("utf8")
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter(Boolean);
    if (lines.length > maxEvents) throw new Error(`room journal exceeds ${maxEvents} events`);
    return lines.map((line) => JSON.parse(line) as RoomEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * FL-146/FL-150 — WHETHER A CANCEL REACHED AN ACP LANE'S BRIDGE, which the room host used to throw
 * away. `dropLaneHold` has always returned whether it released anything; discarding it is why a cancel
 * that was a complete no-op looked exactly like one that worked — for four review rounds, and for every
 * operator trial where an agent answered through their Esc.
 *
 * WHAT THIS DOES AND DOES NOT ANSWER (FL-150, correcting FL-146's own claim in this header). It answers
 * "did the cancel find a bridge connection to supersede". It does NOT answer "did the turn stop", and
 * FL-146 shipped a comment here that read as if it did — on the operator's own measured path this
 * returned TRUE (it closed a connection that was opening) while the turn went on to open a REPLACEMENT
 * and send to it. The turn's stop is its AbortSignal: `cancelTarget` aborts the lane's controller
 * BEFORE it fires this hook (room-engine.ts), and the stop is enforced where a prompt could still get
 * out — `lane-acquire.ts`'s `throwIfAborted` around the fallback create, and `lane-carrier.ts`'s
 * `throwIfCancelledBeforeSend` immediately before `transport.send`.
 *
 * So only the `false` is reported to the operator, and it is reported because it is genuinely bad news:
 * the scheduler calls this only for a lane that is ACTIVE right now, so on an ACP lane a `false` means
 * the cancel found no connection held, none opening, and no open in flight. A `true` is an ordinary
 * working cancel and stays silent — a room that narrates its successes is the info-glut defect, and the
 * turn-side guards above log the one thing a log reader actually needs.
 *
 * `isShuttingDown` is a thunk, not a snapshot: the drop above it can spend half a second in the close
 * ladder, and a shutdown that begins inside that window must still suppress the line — during teardown
 * every lane is being dropped anyway and this would be noise at the worst possible moment.
 *
 * gemini is not ACP and holds no cross-turn connection — its stop is the turn's own abort signal — so
 * there is nothing here to drop or to report about it either way.
 */
export async function dropCancelledLaneHold(input: {
  readonly agent: AgentName;
  readonly isShuttingDown: () => boolean;
  readonly report: (message: string) => void;
}): Promise<void> {
  const { agent, isShuttingDown, report } = input;
  if (agent !== "claude" && agent !== "codex") return;
  const reached = await dropLaneHold(agent);
  if (reached) return;
  if (isShuttingDown()) return;
  report(`cancel reached ${agent} with no live bridge connection to stop`);
}
