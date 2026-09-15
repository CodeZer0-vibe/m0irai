/**
 * @file src/chat/chat-trace.ts
 * @purpose Real-app observability tap for the chat cockpit: subscribes EVERY ChatEvent kind on a bus
 *   and appends one NDJSON line per event ({ ts, turn, kind, ...payload }) to a file, so a real run
 *   is fully auditable end-to-end (the operator's "track / interrogate / audit the whole process").
 *   Off by default — the cockpit only attaches this when ZER0_CHAT_TRACE names a file (zero IO cost
 *   otherwise). `ts` comes from an injectable clock so the unit test is deterministic.
 * @exports attachTraceSink, TraceClock, ALL_EVENT_KINDS
 * @depends node:fs, node:path, ./events, ./ui
 */
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatEvent, ChatEventBus, ChatEventKind } from "./events.js";
import { printChatError } from "./ui.js";

/** Injectable wall-clock for the trace `ts`. Default is real ISO time (chat/CLI layer). */
export type TraceClock = () => string;

const NDJSON_LINE_TERMINATOR: string = "\n";

/**
 * Every {@link ChatEventKind} the sink subscribes to. Exhaustive by construction: the
 * `Record<ChatEventKind, true>` keys force a compile error if a new kind is added to the
 * {@link ChatEvent} union without being listed here, so the trace can never silently drop a kind.
 */
const EVENT_KIND_PRESENCE: Readonly<Record<ChatEventKind, true>> = {
  "agent.status": true,
  "agent.stderr": true,
  "agent.stdout": true,
  "build.card": true,
  "build.lane.captured": true,
  "build.lane.created": true,
  "build.lane.dispatched": true,
  "build.lane.empty": true,
  "build.lane.escaped": true,
  "build.lane.failed": true,
  "build.reviewed": true,
  "build.run.started": true,
  "council.agent.done": true,
  "council.complete": true,
  "council.started": true,
  "debate.agent-result": true,
  "debate.round-complete": true,
  "debate.round-start": true,
  "diff.ready": true,
  "dispatch.completed": true,
  "dispatch.failed": true,
  "dispatch.started": true,
  "lane.queued": true,
  "memory.trace": true,
  "mode.session": true,
  "permission.ask": true,
  "room.notice": true,
  "route.classified": true,
  "route.decision": true,
  "route.pick": true,
  "route.resolved": true,
  "session.saved": true,
  "tui.feed": true,
  "usage.payload": true,
  "undo.result": true,
  "user.message": true,
};

export const ALL_EVENT_KINDS: readonly ChatEventKind[] = Object.keys(
  EVENT_KIND_PRESENCE,
) as ChatEventKind[];

/**
 * Subscribes a handler to ALL event kinds that appends one NDJSON line per event to `filePath`.
 * Each line is `{ ts, ...event }` where `ts` is `clock()` at emit time and the spread carries the
 * full payload (including the event's own `turn`/`kind`). `appendFileSync` keeps writes ordered
 * with the synchronous emit loop, so the trace mirrors emit order exactly.
 *
 * Validates the destination AT ATTACH TIME — creates the parent dir (`mkdirSync recursive`) and
 * proves the file is openable for append — and THROWS a clear, `ZER0_CHAT_TRACE`-named error BEFORE
 * subscribing if either fails. This is load-bearing: {@link ChatEventBus.emit} swallows handler
 * throws (handler isolation), so a per-event write failure would silently drop trace lines — an
 * observability instrument must fail visibly at startup, not vanish mid-run. The probe fd is closed
 * immediately (no held handle, so the trace file stays removable and unlocked on Windows); each
 * event then `appendFileSync`s into the now-proven dir. A later per-event write failure is surfaced
 * ONCE to stderr (best-effort, guarded) rather than swallowed.
 *
 * @param eventBus the SAME bus the renderer is attached to (single tap point for the whole turn).
 * @param filePath NDJSON destination; its dir is created and append-writability proven here.
 * @param clock injectable ISO-time source (default real time); the test injects a fixed clock.
 * @throws Error if the trace destination cannot be created or opened for append.
 */
export function attachTraceSink(
  eventBus: ChatEventBus,
  filePath: string,
  clock: TraceClock = () => new Date().toISOString(),
): void {
  prepareTraceDestination(filePath);
  let writeFailed = false;
  const write = (event: ChatEvent): void => {
    const line = `${JSON.stringify({ ts: clock(), ...event })}${NDJSON_LINE_TERMINATOR}`;
    try {
      appendFileSync(filePath, line);
    } catch (cause) {
      if (writeFailed) return; // surface once, not per-event, to avoid stderr floods
      writeFailed = true;
      try {
        printChatError(`ZER0_CHAT_TRACE write failed for ${filePath}: ${messageOf(cause)}`);
      } catch {
        // stderr is best-effort; a failed surface must not abort the emit loop
      }
    }
  };
  for (const kind of ALL_EVENT_KINDS) {
    eventBus.on(kind, write);
  }
}

/**
 * Creates the parent dir and proves `filePath` is openable for append by opening then immediately
 * closing a probe fd (no held handle → the file stays unlocked/removable on Windows). Throws a
 * clear, actionable error (naming the env var + the path + the underlying cause) if the destination
 * is unwritable — so a misconfigured `ZER0_CHAT_TRACE` fails at attach, before any subscription.
 */
function prepareTraceDestination(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    closeSync(openSync(filePath, "a"));
  } catch (cause) {
    throw new Error(
      `ZER0_CHAT_TRACE destination is not writable: ${filePath} (${messageOf(cause)})`,
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
