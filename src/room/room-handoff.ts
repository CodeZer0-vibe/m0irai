/**
 * @file src/room/room-handoff.ts
 * @purpose Extract the one allowed final-line, read-only room handoff before a carrier result becomes
 * durable visible prose.
 * @exports RoomHandoff, RoomHeadlessOutcome, extractRoomHandoff, isAllowedRoomHandoff
 * @depends ../chat/types
 */
import type { AgentName } from "../chat/types.js";

export const MAX_ROOM_HANDOFF_TEXT_BYTES = 2_048;

export interface RoomHandoff {
  readonly target: AgentName;
  readonly text: string;
}

export interface RoomHeadlessOutcome {
  readonly text: string;
  readonly handoff?: RoomHandoff;
}

const FINAL_DIRECTIVE = /^@(claude|codex|gemini):[ \t]*(.+)$/iu;

/**
 * The room prompt asks for a directive on the final non-empty line. Extract it at the carrier boundary
 * so the scheduler never reparses arbitrary persisted model prose. Invalid directives remain ordinary
 * visible text and therefore cannot become an implicit dispatch.
 */
export function extractRoomHandoff(source: AgentName, text: string): RoomHeadlessOutcome {
  const lines = text.split(/\r?\n/u);
  let index = -1;
  for (let candidate = lines.length - 1; candidate >= 0; candidate -= 1) {
    if ((lines[candidate] ?? "").trim().length > 0) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return { text };
  const line = (lines[index] ?? "").trim();
  const match = line.match(FINAL_DIRECTIVE);
  if (match === null) return { text };
  const target = match[1] as AgentName;
  const request = (match[2] ?? "").trim();
  const handoff = { target, text: request } satisfies RoomHandoff;
  if (!isAllowedRoomHandoff(source, handoff)) return { text };
  lines.splice(index, 1);
  return { text: lines.join("\n").trimEnd(), handoff };
}

/** Validate a structured handoff again at scheduler admission without reparsing visible prose. */
export function isAllowedRoomHandoff(source: AgentName, handoff: RoomHandoff): boolean {
  return (
    handoff.target !== source &&
    handoff.text.trim().length > 0 &&
    Buffer.byteLength(handoff.text, "utf8") <= MAX_ROOM_HANDOFF_TEXT_BYTES &&
    !hasUnsafeControl(handoff.text)
  );
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x2060 ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    );
  });
}
