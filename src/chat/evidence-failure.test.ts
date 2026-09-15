/**
 * @file src/chat/evidence-failure.test.ts
 * @purpose Behavioral tests for surfaceEvidenceFailure: error classification, SQLITE_BUSY swallow,
 *   disk-full/schema-drift/unknown surfacing, non-Error passthrough. Falsifying per case.
 * @exports (none)
 * @depends vitest, ./evidence-failure, ./ui
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock ./ui.js because printChatError writes to stdout/stderr (terminal IO); the behavioral
// contract under test is CALL vs NO-CALL + the reason substring, not the rendering.
// Real path covered at src/chat/ui.ts terminal tests.
vi.mock("./ui.js", () => ({
  printChatError: vi.fn(),
  printChatStatus: vi.fn(),
  printAgentLabel: vi.fn(),
  attachTurnUi: vi.fn(),
}));

// mock ../shared/logger.js because it opens file handles and emits to pino destinations.
// Real path covered at shared logger integration tests. warn() is a SHARED hoisted spy (not a
// fresh vi.fn() per createLogger call) because FL-077 round 2 needs to read the warn line itself:
// "no error printed" alone is satisfied by a bare `return;` in the busy branch.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("../shared/logger.js", () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { surfaceEvidenceFailure } from "./evidence-failure.js";
import { printChatError } from "./ui.js";

const mockPrintChatError = vi.mocked(printChatError);

function makeError(message: string, code?: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  if (code !== undefined) err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("surfaceEvidenceFailure", () => {
  it("SQLITE_BUSY → swallowed; printChatError NOT called (FALSIFYING)", async () => {
    await surfaceEvidenceFailure(makeError("database is locked", "SQLITE_BUSY"), "recordRun");
    expect(mockPrintChatError).not.toHaveBeenCalled();
  });

  it("SQLITE_FULL → printChatError called with 'disk-full' reason", async () => {
    await surfaceEvidenceFailure(makeError("disk full", "SQLITE_FULL"), "recordArtifact");
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
    expect(mockPrintChatError.mock.calls[0]?.[0]).toContain("disk-full");
  });

  it("ENOSPC → printChatError called with 'disk-full' reason", async () => {
    await surfaceEvidenceFailure(makeError("no space left", "ENOSPC"), "recordArtifact");
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
    expect(mockPrintChatError.mock.calls[0]?.[0]).toContain("disk-full");
  });

  it("SQLITE_CONSTRAINT_FOREIGNKEY → printChatError called with 'schema-drift'", async () => {
    await surfaceEvidenceFailure(
      makeError("FOREIGN KEY constraint failed", "SQLITE_CONSTRAINT_FOREIGNKEY"),
      "recordAssignment",
    );
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
    expect(mockPrintChatError.mock.calls[0]?.[0]).toContain("schema-drift");
  });

  it("error message containing 'FOREIGN KEY' → 'schema-drift' (no code needed)", async () => {
    await surfaceEvidenceFailure(makeError("FOREIGN KEY constraint violation"), "recordAssignment");
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
    expect(mockPrintChatError.mock.calls[0]?.[0]).toContain("schema-drift");
  });

  it("unknown error code → 'unknown' reason surfaced", async () => {
    await surfaceEvidenceFailure(makeError("something exploded", "SQLITE_CORRUPT"), "recordRun");
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
    expect(mockPrintChatError.mock.calls[0]?.[0]).toContain("unknown");
  });

  it("non-Error string passed → does NOT throw", async () => {
    await expect(surfaceEvidenceFailure("raw string error", "recordRun")).resolves.toBeUndefined();
    // A non-Error string has no code → surfaces as unknown.
    expect(mockPrintChatError).toHaveBeenCalledTimes(1);
  });
});

// FL-077 second half: SQLite's EXTENDED busy codes are real busy conditions (a stale-snapshot
// write upgrade reports SQLITE_BUSY_SNAPSHOT even under busy_timeout). Each must take the same
// swallow branch as bare SQLITE_BUSY, never the user-facing failure surface. Own describe so the
// main suite stays under the 50-line function clamp; hooks repeated for mock isolation.
describe("surfaceEvidenceFailure extended busy codes (FL-077)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT"] as const)(
    "%s → swallowed like SQLITE_BUSY; printChatError NOT called (FALSIFYING)",
    async (extendedCode) => {
      await surfaceEvidenceFailure(makeError("database is locked", extendedCode), "recordRun");
      expect(mockPrintChatError).not.toHaveBeenCalled();
    },
  );

  // FL-077 round 2 (review finding 6): the three cases above pin only "nothing was printed", and
  // a bare `return;` at the top of the busy branch satisfies that while logging nothing at all.
  // Acceptance 5 says the extended codes are classified AND LOGGED exactly as SQLITE_BUSY is
  // today, so the warn line is pinned by PARITY against a live SQLITE_BUSY call measured in the
  // same test — a copied literal would rot the day the log line changes. The literal anchor on
  // the message keeps parity honest: without it, deleting the whole busy branch would leave both
  // codes on the "failed" line and parity would still hold.
  it.each(["SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT"] as const)(
    "%s → logs the SAME warn line as SQLITE_BUSY, only the code differs (FALSIFYING)",
    async (extendedCode) => {
      await surfaceEvidenceFailure(makeError("database is locked", "SQLITE_BUSY"), "recordRun");
      const baseline = warnSpy.mock.calls.at(-1);
      expect(baseline?.[1]).toBe("chat evidence write busy"); // anchor: parity to the RIGHT line
      expect(mockPrintChatError).not.toHaveBeenCalled();
      vi.clearAllMocks();

      await surfaceEvidenceFailure(makeError("database is locked", extendedCode), "recordRun");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const observed = warnSpy.mock.calls.at(-1);
      expect(observed?.[0]).toEqual(baseline?.[0]);
      expect(observed?.[1]).toBe(baseline?.[1]);
      expect(observed?.[2]).toEqual({ ...(baseline?.[2] as object), code: extendedCode });
      expect(mockPrintChatError).not.toHaveBeenCalled();
    },
  );
});
