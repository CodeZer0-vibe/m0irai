/**
 * @file src/shared/logger.failsoft.test.ts
 * @purpose Sol wave-8 DECISION 3 — proves writeLog's OWN defensive wrapping around the
 *   appendTuiSuppressed branch specifically (screen-claimed path), independent of
 *   appendTuiSuppressed's already-established internal fail-soft guarantee
 *   (tui-suppressed-log.ts's own total try/catch). Mocks the tui-suppressed-log module at file scope
 *   to force that branch to throw — a module mock logger.test.ts and logger.screen-claimed.test.ts
 *   cannot carry (their own tests assert REAL sink-file content, which a mock would break), hence a
 *   dedicated companion file, mirroring logger.screen-claimed.test.ts's own scoped-file precedent.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./logger, ./screen-claim, ./tui-suppressed-log
 */
import { afterEach, expect, it, vi } from "vitest";

const mockAppendTuiSuppressed = vi.hoisted(() => vi.fn());
vi.mock("./tui-suppressed-log.js", () => ({
  appendTuiSuppressed: mockAppendTuiSuppressed,
  TUI_SUPPRESSED_LOG_PATH: ".zer0/tui-suppressed.log",
}));

afterEach(() => {
  vi.restoreAllMocks();
  mockAppendTuiSuppressed.mockReset();
});

it("FAIL-SOFT (sol wave-8 DECISION 3): a throwing appendTuiSuppressed never propagates out of the logger while the screen is claimed", async () => {
  const { claimScreen, releaseScreen } = await import("./screen-claim.js");
  const { createLogger, loggerSinkFailureCount, resetLoggerSinkFailureCount } = await import(
    "./logger.js"
  );
  mockAppendTuiSuppressed.mockImplementation(() => {
    throw new Error("EACCES: permission denied, open '.zer0/debug/x/suppressed.log'");
  });
  resetLoggerSinkFailureCount();
  claimScreen();
  try {
    const logger = createLogger();
    const before = loggerSinkFailureCount();

    expect(() => logger.error({ phase: "test" }, "screen claimed, sink throws")).not.toThrow();

    expect(mockAppendTuiSuppressed).toHaveBeenCalledTimes(1);
    expect(loggerSinkFailureCount()).toBe(before + 1);
  } finally {
    releaseScreen();
    resetLoggerSinkFailureCount();
  }
});
