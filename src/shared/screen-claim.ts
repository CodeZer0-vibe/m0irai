/**
 * @file src/shared/screen-claim.ts
 * @purpose A process-wide flag: is a full-screen TUI (the Ink cockpit) currently OWNING the terminal? While
 *   claimed, the legacy readline-CLI writers (the chat `ui` prints, the council answers, synthesis output,
 *   the logger's stderr) MUST NOT write to the real stdout/stderr — those raw bytes corrupt Ink's frame. The
 *   cockpit renders that content via the event bus instead. The `zer0 council` / other CLI paths never claim.
 *   Also owns the ALTERNATE-screen takeover (enter/leave) — the scrollback-free viewport that renders the rich
 *   cockpit ghost-free even in VS Code / Cursor's xterm.js (inline in-place redraws ghost there).
 * @exports claimScreen, releaseScreen, screenClaimed, clearScreen, clearTerminalFull
 * @depends node:process
 */
import process from "node:process";

const ESC = String.fromCharCode(27); // built at runtime so the ESC byte can't be stripped from source
const BEL = String.fromCharCode(7); // OSC string terminator for the tab-title sequence (set in enterAltScreen)

let claimed = false;

/** Mark the terminal as owned by a full-screen TUI — legacy stdout/stderr writers go silent. */
export function claimScreen(): void {
  claimed = true;
}

/** Release the terminal — stdout/stderr writers print normally again (idempotent). */
export function releaseScreen(): void {
  claimed = false;
}

/** Whether a full-screen TUI currently owns the terminal (so direct stdout/stderr writes must be suppressed). */
export function screenClaimed(): boolean {
  return claimed;
}

/**
 * The cockpit's clean start at launch (NORMAL buffer — NO alt-screen): clear the visible screen + home the
 * cursor so the launch shell prompt/command scroll out of view and the cockpit begins clean, then SET THE TAB
 * TITLE (OSC 0) to the app. The conversation then flows into the terminal's OWN scrollback (native scroll).
 * TTY-only (never emits escapes into a pipe/test).
 */
export function clearScreen(): void {
  if (process.stdout.isTTY === true) {
    // Clear + home + set the tab title. BEL-terminated; built from char codes so no raw ESC/BEL in src.
    process.stdout.write(`${ESC}[3J${ESC}[2J${ESC}[H${ESC}]0;zer0 chat${BEL}`);
  }
}

/**
 * The sanctioned /clear erase (INV-EF6a): wipe the VIEWPORT and the SCROLLBACK, then home the cursor —
 * the literal 2J (viewport erase, legacy fallback) + 3J (scrollback erase) + H (home). NOT
 * ansiEscapes.clearTerminal, whose win32 branch is 2J+0f with NO 3J and would leave settled history in
 * scrollback while a Static remount re-paints the leader (a doubled-content ghost on the operator's
 * platform). No tab-title OSC — that is clearScreen's job at boot. A guard-exempt DIRECT writer like
 * clearScreen: it fires whether or not the screen is claimed. TTY-only (a pipe/test gets zero bytes).
 * Windows Terminal honors 3J; legacy conhost ignores it (viewport-only degrade — documented limit).
 */
export function clearTerminalFull(): void {
  if (process.stdout.isTTY === true) {
    process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`);
  }
}
