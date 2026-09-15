import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import {
  claimScreen,
  clearScreen,
  clearTerminalFull,
  releaseScreen,
  screenClaimed,
} from "./screen-claim.js";

const ESC = String.fromCharCode(27);
// The literal erase INV-EF6a expects: 2J (viewport) + 3J (scrollback) + H (home), no tab-title OSC.
const FULL_ERASE = `${ESC}[2J${ESC}[3J${ESC}[H`;
const BOOT_ERASE = `${ESC}[3J${ESC}[2J${ESC}[H${ESC}]0;zer0 chat${String.fromCharCode(7)}`;
const ORIGINAL_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
}

function restoreTTY(): void {
  if (ORIGINAL_TTY === undefined) {
    Reflect.deleteProperty(process.stdout, "isTTY");
  } else {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_TTY);
  }
}

afterEach(() => {
  releaseScreen();
  vi.restoreAllMocks();
  restoreTTY();
});

describe("screen-claim — legacy stderr/stdout writers go silent while a TUI owns the screen", () => {
  it("defaults to unclaimed so the CLI prints normally", () => {
    expect(screenClaimed()).toBe(false);
  });

  it("the logger does NOT write to stderr while claimed, and prints again once released", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createLogger();
    claimScreen();
    logger.error({ phase: "test" }, "this would corrupt the cockpit's Ink frame");
    expect(spy).not.toHaveBeenCalled(); // silenced — the cockpit owns the screen
    releaseScreen();
    logger.error({ phase: "test" }, "but prints normally once the screen is released");
    expect(spy).toHaveBeenCalled();
  });
});

describe("clearScreen — boot erase", () => {
  it("on a TTY: clears scrollback before the first normal-buffer frame and preserves tab title", () => {
    setTTY(true);
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearScreen();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(BOOT_ERASE);
  });

  it("on a non-TTY: zero bytes written", () => {
    setTTY(undefined);
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearScreen();
    expect(spy).not.toHaveBeenCalled();
  });
});
describe("clearTerminalFull — the sanctioned /clear erase (INV-EF6a)", () => {
  it("on a TTY: one write of exactly 2J -> 3J -> H, and no tab-title OSC", () => {
    setTTY(true);
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearTerminalFull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(FULL_ERASE);
  });

  it("on a non-TTY (pipe/test): zero bytes written", () => {
    setTTY(undefined);
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    clearTerminalFull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fires whether the screen is CLAIMED or RELEASED — a guard-exempt direct writer", () => {
    setTTY(true);
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    claimScreen();
    clearTerminalFull();
    releaseScreen();
    clearTerminalFull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, FULL_ERASE);
    expect(spy).toHaveBeenNthCalledWith(2, FULL_ERASE);
  });
});
