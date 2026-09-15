/**
 * @file tests/helpers/terminal-screen.test.ts
 * @purpose Proof for the measuring instrument the ghost-composer ConPTY falsifier depends on. If this
 *   model mis-reads a byte stream, that falsifier reports a clean screen while the operator is looking
 *   at a stacked composer — so the instrument is tested before it is trusted. Covers the paint
 *   commands ConPTY actually emits (absolute CUP, CUF, ECH, EL, ED, its CSI 8 resize report), the
 *   right-margin wrap, and the wrap-aware counting that decides "one copy or two".
 * @exports (none — test suite)
 * @depends vitest, ./terminal-screen
 */
import { describe, expect, it } from "vitest";
import { countOnScreen, createScreen, feedBytes, screenText } from "./terminal-screen.js";

const ESC = String.fromCharCode(27);

describe("terminal-screen — replaying ConPTY paint commands", () => {
  it("writes text and advances on newline", () => {
    const screen = feedBytes(createScreen(10, 3), "ab\ncd");
    expect(screenText(screen)).toBe("ab\ncd\n");
  });

  it("wraps at the right margin", () => {
    const screen = feedBytes(createScreen(4, 3), "abcdef");
    expect(screenText(screen)).toBe("abcd\nef\n");
  });

  it("places text at an ABSOLUTE position (CUP) — how ConPTY repaints", () => {
    const screen = feedBytes(createScreen(8, 3), `${ESC}[3;2Hxy`);
    expect(screenText(screen)).toBe("\n\n xy");
  });

  it("moves the cursor forward without erasing (CUF)", () => {
    const screen = feedBytes(createScreen(8, 1), `ab${ESC}[3Cz`);
    expect(screenText(screen)).toBe("ab   z");
  });

  it("BLANKS the grid on ConPTY's CSI 8 geometry report — the repaint that follows is the screen", () => {
    // ConPTY reflows its buffer on resize and then repaints the whole viewport from home. Keeping
    // old cells at their old coordinates would invent content the operator cannot see: their text
    // moved when the buffer reflowed. Anything ConPTY does not repaint afterwards is simply not
    // there, so the grid starts blank and the repaint fills it.
    const screen = feedBytes(createScreen(10, 3), `abcdefgh${ESC}[8;3;4t`);
    expect(screen.columns).toBe(4);
    expect(screen.rowCount).toBe(3);
    expect(screenText(screen)).toBe("\n\n");
  });

  it("takes the repaint that follows a geometry report as the truth", () => {
    const screen = feedBytes(createScreen(10, 3), `stale text${ESC}[8;3;6t${ESC}[Hfresh`);
    expect(screenText(screen)).toBe("fresh\n\n");
  });
});

describe("terminal-screen — erasing", () => {
  it("erases n cells in place (ECH) leaving the cursor put", () => {
    // Cursor to column 2 (index 1), erase 3 cells: b, c and d go, e and f stay put.
    const screen = feedBytes(createScreen(8, 1), `abcdef${ESC}[1;2H${ESC}[3X`);
    expect(screenText(screen)).toBe("a   ef");
  });

  it("erases to end of line (EL) and to end of display (ED)", () => {
    const line = feedBytes(createScreen(8, 1), `abcdef${ESC}[1;3H${ESC}[K`);
    expect(screenText(line)).toBe("ab");
    // ED 0 from the start of row 2 wipes that row and everything below; row 1 survives, and the
    // two emptied rows are still rows — screenText renders every row the screen has.
    const display = feedBytes(createScreen(4, 3), `aa\nbb\ncc${ESC}[2;1H${ESC}[J`);
    expect(screenText(display)).toBe("aa\n\n");
  });

  it("clears everything on ED 2", () => {
    const screen = feedBytes(createScreen(4, 2), `ab\ncd${ESC}[2J`);
    expect(screenText(screen)).toBe("\n");
  });
});

describe("terminal-screen — counting what is visible", () => {
  it("counts a WRAPPED copy exactly once — a reflowed ghost must not hide behind the margin", () => {
    const screen = feedBytes(createScreen(6, 2), "aaoperator ");
    // "operator" straddles the wrap: rows are "aaoper" / "ator  ".
    expect(screenText(screen)).toBe("aaoper\nator");
    expect(countOnScreen(screen, "operator")).toBe(1);
  });

  it("counts two separate copies as TWO — the ghost signature the falsifier asserts on", () => {
    const screen = feedBytes(createScreen(12, 3), "operator\noperator");
    expect(countOnScreen(screen, "operator")).toBe(2);
  });
});
