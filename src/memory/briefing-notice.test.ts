import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import {
  emptyRecallLine,
  formatSpaceNotice,
  noticeReserveBytes,
  spaceLossIsEmpty,
  spaceLossOf,
  worstCaseLoss,
} from "./briefing-notice.js";
import type {
  AdmissionRequest,
  AdmittedSections,
  AtomicUnit,
  BudgetedBucketRequest,
  RenderedBucket,
  RenderedSection,
} from "./briefing-render-count.js";

// Unit home for the honest space-loss notice (FL-180 extraction from briefing-render-count.ts, M1b
// round 2). Previously these functions had no direct sibling test at all — only indirect coverage
// through composeBriefing's end-to-end honesty pins in briefing-honesty.test.ts/briefing-framing.
// test.ts, which still exercise them through the real pipeline. These pin the mechanics directly.

function section(overrides: Partial<RenderedSection> = {}): RenderedSection {
  return { text: "", rendered: 0, omitted: 0, omittedWeight: 0, limited: false, ...overrides };
}

function bucketResult(overrides: Partial<RenderedBucket> = {}): RenderedBucket {
  return { text: "", entries: 0, omitted: 0, shortened: 0, limited: false, ...overrides };
}

it("spaceLossOf sums omitted/shortened across every budgeted bucket plus anchors, and counts limited sections", () => {
  const sections: AdmittedSections = {
    conflicts: section({ omitted: 2, omittedWeight: 5, limited: true }),
    anchors: section({ omitted: 3, limited: true }),
    buckets: [
      bucketResult({ omitted: 1, shortened: 1, limited: true }),
      bucketResult({ omitted: 0, shortened: 0, limited: false }),
    ],
  };
  const loss = spaceLossOf(sections, 2);
  expect(loss).toEqual({
    omittedEntries: 3 + 1, // anchors.omitted + sum(bucket.omitted)
    shortenedEntries: 1,
    omittedConflictBlocks: 2,
    omittedConflictSides: 5,
    limitedSections: 3, // conflicts + anchors + the one limited bucket
    shortenedHeaderFields: 2,
  });
});

it("spaceLossOf reports zero limited sections when nothing was limited", () => {
  const sections: AdmittedSections = {
    conflicts: section(),
    anchors: section(),
    buckets: [bucketResult(), bucketResult()],
  };
  expect(spaceLossOf(sections, 0).limitedSections).toBe(0);
});

it("worstCaseLoss bounds every counter by the request's OWN size, never an estimate", () => {
  const conflicts: readonly AtomicUnit[] = [
    { text: "a", weight: 2 },
    { text: "b", weight: 3 },
  ];
  const anchors: readonly AtomicUnit[] = [{ text: "x", weight: 1 }];
  const buckets: readonly BudgetedBucketRequest[] = [
    { bucket: { title: "Core", lines: ["l1", "l2"] }, tokenBudget: 100 },
    { bucket: { title: "Map", lines: ["l3"] }, tokenBudget: 50 },
  ];
  const request: AdmissionRequest = { conflicts, anchors, buckets };
  const worst = worstCaseLoss(request);
  expect(worst).toEqual({
    omittedEntries: 1 + 3, // anchors.length + sum(bucket lines)
    shortenedEntries: 1 + 3,
    omittedConflictBlocks: 2,
    omittedConflictSides: 5, // sum of conflict weights
    // Fixed structural bounds, independent of the request's size:
    limitedSections: 6,
    // M1b round 2 (review r1 IMPORTANT 3): agent= joined project=/opened= as a clippable header
    // field, so the worst case moved from 2 to 3. A regression here silently under-reserves the
    // notice slot the day a THIRD header field really does get shortened.
    shortenedHeaderFields: 3,
  });
});

it("worstCaseLoss on an empty request bounds everything to the fixed structural counts only", () => {
  const worst = worstCaseLoss({ conflicts: [], anchors: [], buckets: [] });
  expect(worst.omittedEntries).toBe(0);
  expect(worst.shortenedEntries).toBe(0);
  expect(worst.omittedConflictBlocks).toBe(0);
  expect(worst.omittedConflictSides).toBe(0);
  expect(worst.limitedSections).toBe(6);
  expect(worst.shortenedHeaderFields).toBe(3);
});

it("spaceLossIsEmpty is true only when every counter is zero", () => {
  expect(
    spaceLossIsEmpty({
      omittedEntries: 0,
      shortenedEntries: 0,
      omittedConflictBlocks: 0,
      omittedConflictSides: 0,
      limitedSections: 0,
      shortenedHeaderFields: 0,
    }),
  ).toBe(true);
  expect(
    spaceLossIsEmpty({
      omittedEntries: 0,
      shortenedEntries: 0,
      omittedConflictBlocks: 0,
      omittedConflictSides: 0,
      limitedSections: 0,
      shortenedHeaderFields: 1,
    }),
  ).toBe(false);
});

it("formatSpaceNotice renders nothing for an empty loss, and every fixed key for a nonzero one", () => {
  const empty = {
    omittedEntries: 0,
    shortenedEntries: 0,
    omittedConflictBlocks: 0,
    omittedConflictSides: 0,
    limitedSections: 0,
    shortenedHeaderFields: 0,
  };
  expect(formatSpaceNotice(empty)).toBe("");
  const nonEmpty = { ...empty, omittedEntries: 4, shortenedHeaderFields: 1 };
  expect(formatSpaceNotice(nonEmpty)).toBe(
    "briefing limited by space: omitted_entries=4 shortened_entries=0 omitted_conflict_blocks=0 omitted_conflict_sides=0 limited_sections=0 shortened_header_fields=1",
  );
});

// A rendered conflict must NEVER suppress this line by itself (R4-01): the third argument is the
// COUNT of rendered conflicts, and it plays no role in whether entries/conflicts are both zero.
it("emptyRecallLine covers the three honest states", () => {
  expect(emptyRecallLine(0, 0, 0)).toBe("no prior work recorded");
  expect(emptyRecallLine(1, 0, 0)).toBe(
    "stored but nothing recalled: 1 entry admitted, none rendered",
  );
  expect(emptyRecallLine(3, 0, 0)).toBe(
    "stored but nothing recalled: 3 entries admitted, none rendered",
  );
  expect(emptyRecallLine(3, 2, 0)).toBe("");
  expect(emptyRecallLine(3, 0, 1)).toBe(""); // a rendered CONFLICT counts as "something recalled" too
});

it("noticeReserveBytes matches the byte length of the widest possible notice this input could produce", () => {
  const worst = {
    omittedEntries: 999,
    shortenedEntries: 999,
    omittedConflictBlocks: 99,
    omittedConflictSides: 99,
    limitedSections: 6,
    shortenedHeaderFields: 3,
  };
  const reserved = noticeReserveBytes(worst, 12);
  const widest = [emptyRecallLine(12, 0, 0), formatSpaceNotice(worst)].join("\n");
  expect(reserved).toBe(Buffer.byteLength(widest, "utf8") + 2); // + PART_JOINER_BYTES
});
