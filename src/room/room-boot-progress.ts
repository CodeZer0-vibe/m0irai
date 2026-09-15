/**
 * @file src/room/room-boot-progress.ts
 * @purpose The `zer0/room/boot_progress` wire notification: the host telling its own terminal which
 *   startup stage it is inside, so the terminal can wait on PROGRESS instead of on a wall clock.
 * @exports BOOT_PROGRESS_METHOD, BootProgressStage, BootProgressReporter, BOOT_PROGRESS_STAGES,
 *   bootProgressNotification, validateBootProgressFrame, SIMULATE_SLOW_BOOT_ENV, simulatedSlowBootMs,
 *   delaySimulatedSlowBoot
 * @depends ../shared/hermetic
 *
 * THIS IS WIRE, NOT ROOM PROTOCOL, and the distinction is the whole safety of it. A `zer0.room` event
 * is durable: it carries a sequence number, it is journaled, it is replayed on every load, and the
 * reducer kills the terminal on a hole. Boot progress is none of those things — it is a transient
 * message between one terminal and the host process it started, it carries no sequence, nothing stores
 * it, and a dropped one costs nothing but a stale stage name. So it deliberately does NOT go through
 * `validateJsonRpcServerFrame` (`room-protocol.ts:51-72`), which is the durable room frame's validator
 * and stays frozen: this module carries its own, and the writer keeps the two paths apart.
 *
 * IT IS EMITTED WHILE A REQUEST IS IN FLIGHT. `session/new` is answered only after the evidence open,
 * the project lock, the carrier migration, the session open and the journal replay have all run
 * (`room-host.ts` `AliveRoomHost.create`). Progress therefore interleaves with nothing else: the room
 * is not attached yet, so no room event can be on the wire, and the response follows the last stage.
 */
import { hermeticEnabled } from "../shared/hermetic.js";

/** The JSON-RPC method name. Under the existing `zer0/room/` namespace, and a NOTIFICATION: it has no
 *  id and the terminal never answers it. */
export const BOOT_PROGRESS_METHOD = "zer0/room/boot_progress";

/**
 * The startup stages, in the order `AliveRoomHost.create` runs them.
 *
 * These are MACHINE KEYS, not operator text. The terminal owns the words (`boot_progress.rs`), because
 * the terminal is what puts them on a screen and a wire string is not a place to keep wording. A key
 * the terminal does not recognise is still treated as progress and shown verbatim, so adding a stage
 * here never requires a matching terminal release.
 */
export const BOOT_PROGRESS_STAGES = [
  "evidence",
  "liveness",
  "migrate",
  "session",
  "journal",
] as const;

export type BootProgressStage = (typeof BOOT_PROGRESS_STAGES)[number];

/** What the room host is handed so it can report a stage. Returns a promise so the simulated-slow-boot
 *  seam can hold the stage open; production resolves after one stdout write. */
export type BootProgressReporter = (stage: BootProgressStage, detail?: string) => Promise<void>;

/** Detail is a short human phrase (`14 → 14,15,16,20,21`), never a payload. Bounded so a stall message
 *  stays one line on a narrow terminal.
 *
 *  Counted in CODE POINTS on both sides of the wire. The Rust decoder has always bounded
 *  `chars().count()` (`boot_progress.rs`), and this side used to bound `String.length`, which counts
 *  UTF-16 units — so the two agreed only on text inside the Basic Multilingual Plane. */
const MAX_DETAIL_LENGTH = 80;
/** The simulated-slow-boot seam refuses anything longer: a test seam that can hang a boot for an hour
 *  is a defect generator, not a seam. */
const MAX_SIMULATED_SLOW_BOOT_MS = 60_000;
/** C0 plus DEL. A detail reaches the operator's terminal as text on a cooked-mode line, so an escape
 *  sequence hidden in it would be executed by the terminal rather than shown. */
const CONTROL_CHARACTER_CEILING = 0x20;
const DELETE_CHARACTER = 0x7f;

/** The frame the host writes. Exactly three keys, matching the room event notification's own shape so
 *  the two are decoded by the same reader on the far side. */
export function bootProgressNotification(
  stage: BootProgressStage,
  detail?: string,
): Readonly<Record<string, unknown>> {
  const clipped = detail === undefined ? undefined : clipToCodePoints(detail);
  return {
    jsonrpc: "2.0",
    method: BOOT_PROGRESS_METHOD,
    params: clipped === undefined ? { stage } : { stage, detail: clipped },
  };
}

/**
 * The strict validator for one boot-progress frame, applied by the writer BEFORE the bytes leave and
 * again after a round trip through the encoder — the same double check `JsonRpcWriter.write` applies to
 * a room frame, for the same reason: a frame the far side rejects is a fatal transport error there, and
 * the cheapest place to catch it is here.
 *
 * @throws Error when the value is not exactly a boot-progress notification.
 */
export function validateBootProgressFrame(value: unknown): void {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.method !== BOOT_PROGRESS_METHOD)
    throw new Error("invalid boot-progress notification");
  if (Object.keys(value).length !== 3 || !isRecord(value.params))
    throw new Error("invalid boot-progress notification");
  const params = value.params;
  const keys = Object.keys(params);
  if (keys.length > 2 || !keys.every((key) => key === "stage" || key === "detail"))
    throw new Error("invalid boot-progress params");
  if (typeof params.stage !== "string" || !isStage(params.stage))
    throw new Error("invalid boot-progress stage");
  if (params.detail !== undefined && !isDetail(params.detail))
    throw new Error("invalid boot-progress detail");
}

/** The env var that makes a boot artificially slow so the wait can be exercised without load. */
export const SIMULATE_SLOW_BOOT_ENV = "ZER0_SIMULATE_SLOW_BOOT_MS";

/**
 * How long each stage should be held open, or 0 for the default: not at all.
 *
 * REFUSED OUTSIDE TEST SUPPORT. The value is honoured only when `ZER0_HERMETIC=1` is also set — the
 * marker the standalone oracle and the room's own tests already use to say "this process is a proof,
 * not a session" (`src/shared/hermetic.ts`). A production boot with the variable set ignores it
 * completely, so a variable left in a shell profile cannot slow a real start, and the operator cannot
 * be handed a build whose boot can be stalled from the environment. Read fresh on every call rather
 * than latched at import, the rule the sibling `ZER0_SIMULATE_EXHAUSTED` seam follows.
 *
 * A malformed, negative or absurd value reads as 0 rather than throwing: this is a switch typed by hand
 * at a shell prompt, and refusing to boot because someone wrote `abc` would make a test aid into an
 * outage.
 */
export function simulatedSlowBootMs(): number {
  if (!hermeticEnabled()) return 0;
  const raw = process.env[SIMULATE_SLOW_BOOT_ENV];
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_SIMULATED_SLOW_BOOT_MS);
}

/** Holds one stage open for {@link simulatedSlowBootMs}. A no-op — not even a microtask turn's worth of
 *  delay — when the seam is off, which is every production boot. */
export async function delaySimulatedSlowBoot(): Promise<void> {
  const delay = simulatedSlowBootMs();
  if (delay === 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Shortens to at most {@link MAX_DETAIL_LENGTH} CODE POINTS, never UTF-16 units.
 *
 * A `.slice` cut lands between the halves of an astral pair and emits a LONE SURROGATE. Nothing on this
 * side notices: the validator checks length and control characters, and Node's own `JSON.parse` round
 * trip accepts the escaped half happily. The failure surfaces on the far side, where `serde_json`
 * rejects the escape, the line falls through to the room transport, that rejects it too, and the boot
 * the operator is watching dies with a transport error. Same defect class the repo ratcheted on at
 * `459540b` ("no shortening splits a code point").
 *
 * NOT `capMetadata` from `src/memory/briefing-render-count.ts`, which is that lane's exported helper.
 * It is the right ALGORITHM and the wrong function here: it also collapses whitespace, neutralizes
 * untrusted framing markers and appends an ellipsis — three content changes a wire field must not
 * make — and importing it would drag the journal store and digest modules into the import graph of the
 * RPC writer, which is the coupling this module was split out to avoid. The pattern is copied; the
 * dependency is not.
 */
function clipToCodePoints(detail: string): string {
  const points = Array.from(detail);
  return points.length <= MAX_DETAIL_LENGTH ? detail : points.slice(0, MAX_DETAIL_LENGTH).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: string): value is BootProgressStage {
  return (BOOT_PROGRESS_STAGES as readonly string[]).includes(value);
}

/** Printable, single-line, bounded. A detail carrying a control character would be pasted straight into
 *  a terminal line by the far side.
 *
 *  The bound counts CODE POINTS, matching the Rust decoder's `chars().count()`. It used to count UTF-16
 *  units, so an 80-emoji detail this side accepted was 80 code points there and passed, while a
 *  50-emoji one this side clipped had already been corrupted by the clip — the two ends only ever
 *  agreed on text inside the Basic Multilingual Plane. */
function isDetail(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= MAX_DETAIL_LENGTH &&
    !hasControlCharacter(value)
  );
}

/** Scanned by code point rather than matched by a regular expression, so the check itself contains no
 *  control bytes and survives every editor and diff between here and the terminal. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < CONTROL_CHARACTER_CEILING || code === DELETE_CHARACTER) return true;
  }
  return false;
}
