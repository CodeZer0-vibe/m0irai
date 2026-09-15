import { expect, it } from "vitest";
import {
  MAX_ROOM_NOTICE_DETAIL_CODE_POINTS,
  ROOM_NOTICE_CAUSES,
  boundRoomNoticeDetail,
  isRoomNoticeCause,
} from "./room-notice.js";

function hasControlOrBidi(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0xfeff
    );
  });
}

it("names every cause exactly once and refuses a cause this host has no phrase for", () => {
  expect(new Set(ROOM_NOTICE_CAUSES).size).toBe(ROOM_NOTICE_CAUSES.length);
  for (const cause of ROOM_NOTICE_CAUSES) expect(isRoomNoticeCause(cause)).toBe(true);
  expect(isRoomNoticeCause("memory-db-open-failed ")).toBe(false);
  expect(isRoomNoticeCause("some-future-cause")).toBe(false);
  expect(isRoomNoticeCause(undefined)).toBe(false);
});

it("bounds a detail by CODE POINTS, not by UTF-16 units, so both halves count the same length", () => {
  // Astral characters are two UTF-16 units each; a length check on `.length` would cut this in half
  // and disagree with the Rust `chars()` count and the schema's own maxLength.
  const astral = "\u{1f600}".repeat(MAX_ROOM_NOTICE_DETAIL_CODE_POINTS + 40);
  const bounded = boundRoomNoticeDetail(new Error(astral));
  expect([...bounded]).toHaveLength(MAX_ROOM_NOTICE_DETAIL_CODE_POINTS);
  expect(bounded.length).toBeGreaterThan(MAX_ROOM_NOTICE_DETAIL_CODE_POINTS);
});

it("neutralizes control and bidi bytes into visible literals a log can carry", () => {
  const detail = boundRoomNoticeDetail(
    new Error("SQLITE_CORRUPT: database\n disk image\r\n[31mmalformed‮"),
  );
  // Nothing terminal-active survives. The escape runs BEFORE the whitespace collapse, so a real
  // newline is already the two characters `\` and `n` by the time the collapse looks at the string.
  expect(hasControlOrBidi(detail)).toBe(false);
  expect(detail).toBe("SQLITE_CORRUPT: database\\n disk image\\r\\n\\x1b[31mmalformed\\u202e");
});

it("collapses runs of real whitespace so one failure stays one log line", () => {
  expect(boundRoomNoticeDetail(new Error("  open   failed  on   disk  "))).toBe(
    "open failed on disk",
  );
});

it("never returns an empty detail, because the wire requires a nonempty one", () => {
  for (const empty of ["", "   ", undefined, null]) {
    expect(boundRoomNoticeDetail(empty).length).toBeGreaterThan(0);
  }
  // Total over a value whose own coercion throws: the notice must survive its own diagnostics.
  const hostile = {
    toString() {
      throw new Error("toString exploded");
    },
  };
  expect(boundRoomNoticeDetail(hostile).length).toBeGreaterThan(0);
});
