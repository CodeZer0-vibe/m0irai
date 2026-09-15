/**
 * @file tests/helpers/terminal-screen.ts
 * @purpose Test support for the ConPTY falsifiers: replay a ConPTY byte stream onto a cell grid so a
 *   test can assert what the operator's terminal ACTUALLY SHOWS, not what bytes went past.
 *
 *   Deliberately NOT a terminal emulator. ConPTY is the emulator: it owns the screen buffer, it
 *   performs the reflow when the pty is resized, and it repaints downstream using ABSOLUTE cursor
 *   positioning (CUP/CUF/ECH/EL). This model only replays those already-absolute paint commands —
 *   it implements no reflow of its own, so the hard part of the measurement belongs to the real
 *   terminal rather than to this file. That is what makes it honest evidence.
 * @exports TerminalScreen, createScreen, resizeScreen, feedBytes, screenText, countOnScreen
 * @depends (none)
 */

const ESC = String.fromCharCode(27);
const CSI_RE = new RegExp(`^${ESC}\\[([0-9;?]*)([A-Za-z])`);
const OSC_RE = new RegExp(
  `^${ESC}\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)`,
);
const SHORT_ESC_RE = new RegExp(`^${ESC}[=>c]`);

export interface TerminalScreen {
  rows: string[][];
  columns: number;
  rowCount: number;
  cursorRow: number;
  cursorColumn: number;
}

function blankRow(columns: number): string[] {
  return Array.from({ length: columns }, () => " ");
}

/** A blank grid of `columns` × `rows` cells with the cursor homed. */
export function createScreen(columns: number, rows: number): TerminalScreen {
  return {
    columns,
    rowCount: rows,
    cursorRow: 0,
    cursorColumn: 0,
    rows: Array.from({ length: rows }, () => blankRow(columns)),
  };
}

/**
 * Reshape the grid to a new geometry. CALL THIS FROM THE HARNESS whenever it resizes the pty — do
 * NOT rely on ConPTY announcing the new size. Measured across captures, ConPTY emits its
 * `CSI 8 ; rows ; cols t` report only SOMETIMES (a 120->60 column change produced one; a
 * 140x34 -> 70x22 change produced none at all). A model that resizes only on that report silently
 * keeps painting the new content into the OLD grid, which manufactures ghosts that are not on the
 * operator's screen. The report is still handled below, harmlessly, for when it does arrive.
 *
 * The grid is BLANKED rather than carrying old cells across by index: the terminal reflowed its
 * buffer, so a cell's old (row, column) is not where its content lives now, and ConPTY homes and
 * repaints the whole viewport afterwards. What it paints after the resize IS the screen.
 */
export function resizeScreen(screen: TerminalScreen, columns: number, rows: number): void {
  screen.columns = columns;
  screen.rowCount = rows;
  screen.rows = Array.from({ length: rows }, () => blankRow(columns));
  screen.cursorRow = 0;
  screen.cursorColumn = 0;
}

function scrollUp(screen: TerminalScreen): void {
  screen.rows.shift();
  screen.rows.push(blankRow(screen.columns));
}

function newline(screen: TerminalScreen): void {
  screen.cursorRow += 1;
  screen.cursorColumn = 0;
  if (screen.cursorRow >= screen.rowCount) {
    scrollUp(screen);
    screen.cursorRow = screen.rowCount - 1;
  }
}

function putChar(screen: TerminalScreen, char: string): void {
  if (screen.cursorColumn >= screen.columns) {
    newline(screen);
  }
  screen.rows[screen.cursorRow]?.splice(screen.cursorColumn, 1, char);
  screen.cursorColumn += 1;
}

function eraseInLine(screen: TerminalScreen, mode: number): void {
  const row = screen.rows[screen.cursorRow];
  if (row === undefined) return;
  const from = mode === 1 ? 0 : screen.cursorColumn;
  const to = mode === 1 ? screen.cursorColumn + 1 : screen.columns;
  for (let x = from; x < to; x += 1) row[x] = " ";
}

function eraseInDisplay(screen: TerminalScreen, mode: number): void {
  if (mode === 2 || mode === 3) {
    screen.rows = Array.from({ length: screen.rowCount }, () => blankRow(screen.columns));
    return;
  }
  if (mode !== 0) return;
  eraseInLine(screen, 0);
  for (let y = screen.cursorRow + 1; y < screen.rowCount; y += 1) {
    screen.rows[y] = blankRow(screen.columns);
  }
}

function eraseChars(screen: TerminalScreen, count: number): void {
  const row = screen.rows[screen.cursorRow];
  if (row === undefined) return;
  for (let k = 0; k < count && screen.cursorColumn + k < screen.columns; k += 1) {
    row[screen.cursorColumn + k] = " ";
  }
}

function moveCursor(screen: TerminalScreen, cmd: string, n: number, nums: number[]): void {
  if (cmd === "H" || cmd === "f") {
    screen.cursorRow = Math.max(0, (nums[0] ?? 1) - 1);
    screen.cursorColumn = Math.max(0, (nums[1] ?? 1) - 1);
    return;
  }
  if (cmd === "A") screen.cursorRow = Math.max(0, screen.cursorRow - n);
  if (cmd === "B") screen.cursorRow = Math.min(screen.rowCount - 1, screen.cursorRow + n);
  if (cmd === "C") screen.cursorColumn = Math.min(screen.columns - 1, screen.cursorColumn + n);
  if (cmd === "D") screen.cursorColumn = Math.max(0, screen.cursorColumn - n);
  if (cmd === "G") screen.cursorColumn = Math.max(0, n - 1);
}

function applyCsi(screen: TerminalScreen, params: string, cmd: string): void {
  const nums = params
    .split(";")
    .filter((part) => part !== "" && !part.startsWith("?"))
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
  const n = nums[0] ?? 1;
  if ("HfABCDG".includes(cmd)) {
    moveCursor(screen, cmd, n, nums);
    return;
  }
  if (cmd === "X") eraseChars(screen, n);
  if (cmd === "K") eraseInLine(screen, nums[0] ?? 0);
  if (cmd === "J") eraseInDisplay(screen, nums[0] ?? 0);
  if (cmd === "t" && nums[0] === 8 && nums[1] !== undefined && nums[2] !== undefined) {
    resizeScreen(screen, nums[2], nums[1]);
  }
  // Everything else (SGR `m`, cursor visibility, mode sets) changes no cell.
}

/** Consume the escape sequence starting at `rest`, applying it; returns how many chars it spanned. */
function consumeEscape(screen: TerminalScreen, rest: string): number {
  const csi = CSI_RE.exec(rest);
  if (csi) {
    applyCsi(screen, csi[1] ?? "", csi[2] as string);
    return csi[0].length;
  }
  const skipped = OSC_RE.exec(rest) ?? SHORT_ESC_RE.exec(rest);
  return skipped ? skipped[0].length : 1;
}

/** Apply one non-escape character: the three control codes that move the cursor, else a glyph. */
function applyChar(screen: TerminalScreen, char: string): void {
  if (char === "\n") newline(screen);
  else if (char === "\r") screen.cursorColumn = 0;
  else if (char === "\b") screen.cursorColumn = Math.max(0, screen.cursorColumn - 1);
  else putChar(screen, char);
}

/** Replay one chunk of ConPTY output onto the grid. Safe to call repeatedly as data arrives. */
export function feedBytes(screen: TerminalScreen, data: string): TerminalScreen {
  let i = 0;
  while (i < data.length) {
    const char = data[i] as string;
    if (char === ESC) {
      i += consumeEscape(screen, data.slice(i));
      continue;
    }
    applyChar(screen, char);
    i += 1;
  }
  return screen;
}

/** The visible screen as text, one line per row, trailing blanks trimmed. */
export function screenText(screen: TerminalScreen): string {
  return screen.rows.map((row) => row.join("").replace(/\s+$/, "")).join("\n");
}

/**
 * How many times `needle` is visible, counting a copy that the terminal WRAPPED across two rows.
 * Rows are joined at full width with no separator, which is exactly how a wrapped line continues
 * (a continuation only happens on a row whose every cell is filled), so a wrapped copy reads
 * through the boundary and still counts once.
 */
export function countOnScreen(screen: TerminalScreen, needle: string): number {
  const flat = screen.rows.map((row) => row.join("")).join("");
  let count = 0;
  let at = flat.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = flat.indexOf(needle, at + 1);
  }
  return count;
}
