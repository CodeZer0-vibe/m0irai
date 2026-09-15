import { describe, expect, it } from "vitest";
import {
  ULID_REGEX,
  isUlid,
  newDispatchId,
  newErrorId,
  newEventId,
  newFindingId,
  newId,
  newRunId,
  newTaskId,
  seedMonotonicUlid,
} from "./ids.js";

describe("ids", () => {
  it("generates valid ULIDs for every branded ID constructor", () => {
    const ids = [
      newId(),
      newRunId(),
      newTaskId(),
      newDispatchId(),
      newEventId(),
      newErrorId(),
      newFindingId(),
    ];

    expect(ids.every((id) => ULID_REGEX.test(id))).toBe(true);
    expect(ids.every(isUlid)).toBe(true);
  });

  it("creates deterministic monotonic IDs for fixtures", () => {
    const next = seedMonotonicUlid(Date.UTC(2026, 4, 5));
    const first = next();
    const second = next();

    expect(first).toMatch(ULID_REGEX);
    expect(second > first).toBe(true);
  });
});
