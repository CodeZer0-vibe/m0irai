/**
 * @file src/memory/briefing-notice.ts
 * @purpose The honest space-loss notice composeBriefing appends after its header: what was omitted,
 *   shortened or limited, the worst-case bound that sizes its own reserved slot, and the empty-recall
 *   line covering the "stored but nothing rendered" case. Extracted from briefing-render-count.ts
 *   along the seam FL-180 named and left untaken; moved now because M1b round 2 (header agent=
 *   defense-in-depth) needed one more clippable header field and both files were already at the
 *   500-line clamp with no room for it.
 * @exports SpaceLoss, spaceLossOf, worstCaseLoss, spaceLossIsEmpty, formatSpaceNotice, emptyRecallLine, noticeReserveBytes
 * @depends node:buffer, ./briefing-render-count
 */
import { Buffer } from "node:buffer";
import {
  type AdmissionRequest,
  type AdmittedSections,
  PART_JOINER_BYTES,
} from "./briefing-render-count.js";

// Six limitable sections (conflicts, anchors, core, map, own, pulls) — SECTION_COUNT stays 6, this
// file does not change section accounting — and THREE clippable header fields as of M1b round 2
// (project, agent, opened — agent joined as defense-in-depth; review r1 IMPORTANT 3): the ceilings
// the worst-case notice reserve is built from.
const SECTION_COUNT = 6;
const HEADER_METADATA_FIELDS = 3;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Every way this briefing lost content, in the units the notice announces. */
export interface SpaceLoss {
  readonly omittedEntries: number;
  readonly shortenedEntries: number;
  readonly omittedConflictBlocks: number;
  readonly omittedConflictSides: number;
  readonly limitedSections: number;
  readonly shortenedHeaderFields: number;
}

export function spaceLossOf(sections: AdmittedSections, shortenedHeaderFields: number): SpaceLoss {
  const all = [sections.conflicts, sections.anchors, ...sections.buckets];
  return {
    omittedEntries: sections.anchors.omitted + sum(sections.buckets.map((e) => e.omitted)),
    shortenedEntries: sum(sections.buckets.map((entry) => entry.shortened)),
    omittedConflictBlocks: sections.conflicts.omitted,
    omittedConflictSides: sections.conflicts.omittedWeight,
    limitedSections: all.filter((section) => section.limited).length,
    shortenedHeaderFields,
  };
}

/** The maximum every counter could reach for THIS input — an upper BOUND, never an estimate. */
export function worstCaseLoss(request: AdmissionRequest): SpaceLoss {
  const entryLines =
    request.anchors.length + sum(request.buckets.map((entry) => entry.bucket.lines.length));
  return {
    omittedEntries: entryLines,
    shortenedEntries: entryLines,
    omittedConflictBlocks: request.conflicts.length,
    omittedConflictSides: sum(request.conflicts.map((unit) => unit.weight)),
    limitedSections: SECTION_COUNT,
    shortenedHeaderFields: HEADER_METADATA_FIELDS,
  };
}

// Every SpaceLoss field is a count, so a new counter is covered here the day it is added.
export function spaceLossIsEmpty(loss: SpaceLoss): boolean {
  return Object.values(loss).every((count) => count === 0);
}

// The space-loss line (memo §1.5). Fixed keys, decimal integers, appended whenever ANY counter is
// nonzero — a rendered conflict can never suppress it. That suppression IS finding R4-01: two real
// ASCII entries vanished silently because `conflictCount > 0`.
export function formatSpaceNotice(loss: SpaceLoss): string {
  if (spaceLossIsEmpty(loss)) {
    return "";
  }
  return [
    "briefing limited by space:",
    `omitted_entries=${loss.omittedEntries}`,
    `shortened_entries=${loss.shortenedEntries}`,
    `omitted_conflict_blocks=${loss.omittedConflictBlocks}`,
    `omitted_conflict_sides=${loss.omittedConflictSides}`,
    `limited_sections=${loss.limitedSections}`,
    `shortened_header_fields=${loss.shortenedHeaderFields}`,
  ].join(" ");
}

// Three states: nothing stored; stored but nothing rendered AND no conflict block rendered (oracle
// §2 "empty renders say so" — silence here is the defect that hid the dead memory); or nothing to
// say, because entries or a conflict block really came out (review r1 FIND-03). The test is what
// actually RENDERED, never what was merely detected.
export function emptyRecallLine(admitted: number, entries: number, conflicts: number): string {
  if (admitted === 0) {
    return "no prior work recorded";
  }
  if (entries === 0 && conflicts === 0) {
    const noun = admitted === 1 ? "entry" : "entries";
    return `stored but nothing recalled: ${admitted} ${noun} admitted, none rendered`;
  }
  return "";
}

// The notice SLOT's size, from THIS formatter and THIS sentence at the maximum counts THIS input
// could produce — never a fixed estimate. Pass 2 reserves exactly this many bytes before admitting
// losable content, removing the notice-overflow fixpoint.
export function noticeReserveBytes(worst: SpaceLoss, admitted: number): number {
  const widest = [emptyRecallLine(admitted, 0, 0), formatSpaceNotice(worst)].join("\n");
  return Buffer.byteLength(widest, "utf8") + PART_JOINER_BYTES;
}
