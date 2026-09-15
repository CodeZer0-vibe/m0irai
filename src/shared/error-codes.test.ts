import { describe, expect, it } from "vitest";
import {
  ERROR_CODE_METADATA,
  NON_RETRYABLE_ERROR_TYPES,
  Zer0ErrorCode,
  getErrorMetadata,
  isZer0ErrorCode,
} from "./error-codes.js";

describe("error code catalog", () => {
  it("has metadata for every enum value", () => {
    const codes = Object.values(Zer0ErrorCode);

    expect(Object.keys(ERROR_CODE_METADATA).sort()).toEqual([...codes].sort());
    expect(codes.every((code) => getErrorMetadata(code).code === code)).toBe(true);
  });

  it("detects known Zer0 error codes", () => {
    expect(isZer0ErrorCode(Zer0ErrorCode.AgentDispatchFailed)).toBe(true);
    expect(isZer0ErrorCode("CONFIG_INVALID")).toBe(false);
  });

  it("derives frozen non-retryable error types from metadata", () => {
    const expectedTypes = Object.values(ERROR_CODE_METADATA)
      .filter((metadataEntry) => metadataEntry.retryability !== "yes")
      .map((metadataEntry) => metadataEntry.code);

    expect(Object.isFrozen(NON_RETRYABLE_ERROR_TYPES)).toBe(true);
    expect(NON_RETRYABLE_ERROR_TYPES).toHaveLength(expectedTypes.length);
    expect(NON_RETRYABLE_ERROR_TYPES).toEqual(expectedTypes);
  });

  it("includes terminal retry policy error types", () => {
    expect(NON_RETRYABLE_ERROR_TYPES).toEqual(
      expect.arrayContaining([
        Zer0ErrorCode.ContextReadFailed,
        Zer0ErrorCode.ConfigInvalid,
        Zer0ErrorCode.AgentDispatchFailed,
        Zer0ErrorCode.SchemaValidationFailed,
        Zer0ErrorCode.ContextBudgetExceeded,
        Zer0ErrorCode.RevertNonTipCommit,
      ]),
    );
  });

  it("excludes retryable transient error types", () => {
    for (const retryableCode of [
      Zer0ErrorCode.TemporalUnreachable,
      Zer0ErrorCode.DbLocked,
      Zer0ErrorCode.AgentTimeout,
      Zer0ErrorCode.AgentRateLimited,
      // SPEC-7: malformed reviewer output is retriable (re-dispatch), then escalated.
      Zer0ErrorCode.ReviewerOutputMalformed,
    ]) {
      expect(NON_RETRYABLE_ERROR_TYPES).not.toContain(retryableCode);
    }
  });
});
