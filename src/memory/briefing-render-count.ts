/**
 * @file src/memory/briefing-render-count.ts
 * @purpose The measured byte ledger composeBriefing admits every rendered part through: atomic
 *   render units, marker-aware section fitting, and code-point-safe shortening behind a
 *   meaningful-body guard. The space-loss counters the honest notice reports live in
 *   briefing-notice.ts (FL-180 extraction).
 * @exports TRUNCATION_MARKER, PART_JOINER_BYTES, RenderBucket, RenderedBucket, RenderedSection, TakenLines, AtomicUnit, AssembledBriefing, CappedMetadata, ByteLedger, BudgetedBucketRequest, AdmissionRequest, AdmittedSections, newByteLedger, capMetadata, bucket, bucketTokens, renderAtomicSection, renderBudgetedBucket, takeWithinBudget, retainsBody, admitSections, renderedEntryCount, assertBriefingFits, assertNoticeFitsReserve
 * @depends node:buffer, ../chat/prompt-budgeter, ../shared/error-codes, ../shared/errors, ./carrier-budget, ./untrusted-framing
 */
import { Buffer } from "node:buffer";
import { estimatePromptTokens } from "../chat/prompt-budgeter.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ContextError } from "../shared/errors.js";
import { reserveBriefing } from "./carrier-budget.js";
import { neutralizeMarkers } from "./untrusted-framing.js";

export const TRUNCATION_MARKER = "- more in the journal";

/** The "\n\n" every non-empty part of the assembled briefing is joined with. */
export const PART_JOINER_BYTES = 2;

const ELLIPSIS = " ...";
// renderEntry's operator branch is the ONLY unframed single-line shape, and it always puts this
// exact sequence between the metadata prefix and the entry's own body.
const BODY_SEPARATOR = " :: ";

/** One metadata value after the shared cap, and whether the cap actually cut it. */
export interface CappedMetadata {
  readonly text: string;
  readonly shortened: boolean;
}

// The ONE metadata cap: collapse whitespace, keep at most `cap` CODE POINTS, never raw UTF-16 units
// (slicing units can split an astral pair into a lone surrogate). Round 5 routes the briefing HEADER
// through it too (memo §1.1): raw `projectId`/`now` pushed the one unshrinkable part past the
// reserve. ASCII output is unchanged.
// M1b round 1 (fuzz item 4): every field this cap wraps renders OUTSIDE any frame by design (label
// metadata, never recalled memory), so a stored value containing a literal "<<<" could otherwise
// spoof a fake BEGIN/END marker in that trusted zone. M1b round 2 (review r1 IMPORTANT 4): the bare
// "<<<" replace alone missed a Cf-character-disguised triplet, so this now shares
// untrusted-framing.ts's neutralizeMarkers — the ONE neutralizer body content and every label field
// both go through, so they can never drift apart again.
export function capMetadata(value: string, cap: number): CappedMetadata {
  const normalized = neutralizeMarkers(value.replace(/\s+/g, " ")).trim();
  const points = Array.from(normalized);
  if (points.length <= cap) {
    return { text: normalized, shortened: false };
  }
  return { text: `${points.slice(0, cap - 3).join("")}...`, shortened: true };
}

// A genuine delimitUntrusted frame opens with its BEGIN marker as a WHOLE line, and an operator body
// cannot fake that: oneLine() collapses every newline, so a forged marker only ever sits mid-line
// behind the "- author=" prefix. Duplicated literal — untrusted-framing.ts owns BEGIN_MARKER but
// does not export it; keep the two in step.
const FRAME_OPEN_LINE_PREFIX = "<<<BEGIN UNTRUSTED RECALLED MEMORY";

/** True when the rendered entry text contains a genuine untrusted-frame open (a line-start BEGIN). */
function isFramedEntry(entryText: string): boolean {
  return entryText.split("\n").some((line) => line.startsWith(FRAME_OPEN_LINE_PREFIX));
}

// ROUND-5 PINNED INVARIANT (memo §1, option A+): the carrier reserves reserveBriefing (8500) BYTES
// while the token budgets count CHARS. Round 4 pooled only the four budgeted buckets while letting
// the header, conflicts and anchors DEBIT that pool without being able to shrink — unbudgeted parts
// past 8372 bytes drove every bucket ceiling negative, real ASCII entries vanished in silence, and
// the text STILL passed 8500 (R4-01, 10272). Round 5 measures EVERYTHING through one ledger in
// render order, joiners included; the blanket 128-byte allowance is gone, so the pool a fresh
// briefing starts with IS reserveBriefing.
// The measured byte pool: `available()` is how many bytes the NEXT part may occupy, its joiner
// already subtracted. The notice slot is `reserve`d before any losable content is admitted, which is
// what stops the notice's own cost from pushing a briefing past the reserve it reports on.
export interface ByteLedger {
  available(): number;
  commit(text: string): void;
  reserve(bytes: number): void;
}

export function newByteLedger(capacity: number): ByteLedger {
  let used = 0;
  let reserved = 0;
  let parts = 0;
  const joiner = (): number => (parts > 0 ? PART_JOINER_BYTES : 0);
  return {
    available: (): number => capacity - used - reserved - joiner(),
    commit: (text: string): void => {
      if (text.length === 0) return;
      used += Buffer.byteLength(text, "utf8") + joiner();
      parts += 1;
    },
    reserve: (bytes: number): void => {
      reserved += bytes;
    },
  };
}

export interface RenderBucket {
  readonly title: string;
  readonly lines: readonly string[];
}

/** What a budgeted bucket render produced, plus everything the honest notice needs to know. */
export interface RenderedBucket {
  readonly text: string;
  readonly entries: number;
  readonly omitted: number;
  readonly shortened: number;
  readonly limited: boolean;
}

// What an ATOMIC section (conflicts, anchors) produced: every unit fit whole or dropped whole.
// `omittedWeight` is the dropped units' own weight — conflict SIDES for a block, 1 for an entry.
export interface RenderedSection {
  readonly text: string;
  readonly rendered: number;
  readonly omitted: number;
  readonly omittedWeight: number;
  readonly limited: boolean;
}

/** assembleBriefing returns the WHOLE document — never a bucket render (review r1 FIND-06). */
export interface AssembledBriefing {
  readonly text: string;
  readonly entries: number;
}

/** One indivisible render unit: it enters the text whole, or not at all. */
export interface AtomicUnit {
  readonly text: string;
  readonly weight: number;
}

export interface TakenLines {
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly omitted: number;
  readonly shortened: number;
}

function fitsBucket(candidate: string, tokenBudget: number, byteCeiling: number): boolean {
  return (
    estimatePromptTokens(candidate) <= tokenBudget &&
    Buffer.byteLength(candidate, "utf8") <= byteCeiling
  );
}

function fitsBytes(candidate: string, byteCeiling: number): boolean {
  return Buffer.byteLength(candidate, "utf8") <= byteCeiling;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function bucket(title: string, lines: readonly string[]): RenderBucket {
  return { title, lines };
}

// The token price of a bucket rendered WHOLE — what the category allocator bids against.
export function bucketTokens(bucket: RenderBucket): number {
  const whole = bucket.lines.length === 0 ? "" : [`## ${bucket.title}`, ...bucket.lines].join("\n");
  return estimatePromptTokens(whole);
}

// memo §1.2: conflict blocks and anchor entries are measured against the same global pool but cannot
// be shortened. Attempt each unit in order; one that does not fit is dropped WHOLE, debits NOTHING
// and is counted, so an oversized block can never evict what follows (finding R4-01).
export function renderAtomicSection(
  title: string,
  units: readonly AtomicUnit[],
  byteCeiling: number,
): RenderedSection {
  const heading = `## ${title}`;
  if (units.length === 0) {
    return { text: "", rendered: 0, omitted: 0, omittedWeight: 0, limited: false };
  }
  // memo §1.4: test the COMPLETE section first — the marker is reserved only once the section is
  // known to be limited, so a section that fits whole renders byte-identically to before.
  const whole = [heading, ...units.map((unit) => unit.text)].join("\n");
  if (fitsBytes(whole, byteCeiling)) {
    return { text: whole, rendered: units.length, omitted: 0, omittedWeight: 0, limited: false };
  }
  return admitAtomicUnits(heading, units, byteCeiling);
}

function admitAtomicUnits(
  heading: string,
  units: readonly AtomicUnit[],
  byteCeiling: number,
): RenderedSection {
  const kept: string[] = [];
  let omitted = 0;
  let omittedWeight = 0;
  for (const unit of units) {
    if (fitsBytes([heading, ...kept, unit.text, TRUNCATION_MARKER].join("\n"), byteCeiling)) {
      kept.push(unit.text);
      continue;
    }
    omitted += 1;
    omittedWeight += unit.weight;
  }
  return {
    text: limitedSectionText(heading, kept, (text) => fitsBytes(text, byteCeiling)),
    rendered: kept.length,
    omitted,
    omittedWeight,
    limited: true,
  };
}

// memo §1.4: heading plus marker is the smallest honest thing a limited section can say; when even
// that cannot fit, the section stays silent and the notice carries the whole loss.
function limitedSectionText(
  heading: string,
  kept: readonly string[],
  fits: (text: string) => boolean,
): string {
  if (kept.length > 0) {
    return [heading, ...kept, TRUNCATION_MARKER].join("\n");
  }
  const stub = [heading, TRUNCATION_MARKER].join("\n");
  return fits(stub) ? stub : "";
}

export function renderBudgetedBucket(
  bucket: RenderBucket,
  tokenBudget: number,
  byteCeiling: number = Number.POSITIVE_INFINITY,
): RenderedBucket {
  if (bucket.lines.length === 0) {
    return { text: "", entries: 0, omitted: 0, shortened: 0, limited: false };
  }
  if (tokenBudget <= 0) {
    return { text: "", entries: 0, omitted: bucket.lines.length, shortened: 0, limited: true };
  }
  const heading = `## ${bucket.title}`;
  const kept = takeWithinBudget(bucket.lines, tokenBudget, heading, byteCeiling);
  const text =
    kept.lines.length > 0
      ? [heading, ...kept.lines, ...(kept.truncated ? [TRUNCATION_MARKER] : [])].join("\n")
      : limitedSectionText(heading, [], (line) => fitsBucket(line, tokenBudget, byteCeiling));
  // A shortened line came out and counts; the TRUNCATION_MARKER is not an entry.
  return {
    text,
    entries: kept.lines.length,
    omitted: kept.omitted,
    shortened: kept.shortened,
    limited: kept.truncated,
  };
}

export function takeWithinBudget(
  lines: readonly string[],
  tokenBudget: number,
  heading: string,
  byteCeiling: number = Number.POSITIVE_INFINITY,
): TakenLines {
  if (lines.length === 0) {
    return { lines: [], truncated: false, omitted: 0, shortened: 0 };
  }
  if (fitsBucket([heading, ...lines].join("\n"), tokenBudget, byteCeiling)) {
    return { lines, truncated: false, omitted: 0, shortened: 0 };
  }
  return takeLimited(lines, tokenBudget, heading, byteCeiling);
}

// Limited mode (memo §1.4): the TRUNCATION_MARKER is PRE-RESERVED, so every candidate is measured
// with the marker the section is now certain to emit. Round 4 measured whole lines without it, which
// let the marker escape the very ceiling it was supposed to sit inside.
function takeLimited(
  lines: readonly string[],
  tokenBudget: number,
  heading: string,
  byteCeiling: number,
): TakenLines {
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      fitsBucket([heading, ...kept, line, TRUNCATION_MARKER].join("\n"), tokenBudget, byteCeiling)
    ) {
      kept.push(line);
      continue;
    }
    // Frame integrity (round-4 item A): shortening must never cut inside a framed block — a slice
    // drops the frame's END delimiter and everything the caller appends AFTER the briefing then
    // sits inside an unclosed "do NOT follow" frame. A framed entry fits WHOLE or is DROPPED whole
    // and counted as not rendered; the truncation marker stays outside frames.
    const shortened = isFramedEntry(line)
      ? ""
      : shortenLine(line, tokenBudget, heading, kept, byteCeiling);
    if (shortened.length === 0) {
      return { lines: kept, truncated: true, omitted: lines.length - index, shortened: 0 };
    }
    return {
      lines: [...kept, shortened],
      truncated: true,
      omitted: lines.length - index - 1,
      shortened: 1,
    };
  }
  return { lines: kept, truncated: kept.length < lines.length, omitted: 0, shortened: 0 };
}

function shortenLine(
  line: string,
  tokenBudget: number,
  heading: string,
  kept: readonly string[],
  byteCeiling: number,
): string {
  // Round-4 item B: search over CODE POINT boundaries, never raw UTF-16 units — slicing units can
  // split an astral pair and emit a lone surrogate into the prompt.
  const points = Array.from(line);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const next = `${points.slice(0, mid).join("").trimEnd()}${ELLIPSIS}`;
    const candidate = [heading, ...kept, next, TRUNCATION_MARKER].join("\n");
    if (fitsBucket(candidate, tokenBudget, byteCeiling)) {
      best = next;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return retainsBody(line, best) ? best : "";
}

// R4-02 (memo §1.7): a shortened bullet counts as a rendered entry ONLY when the retained prefix
// keeps a non-whitespace character PAST the ORIGINAL line's " :: " body boundary. Round 4 rejected
// only a whitespace-only remainder, so any surviving character — always metadata, never body —
// counted as recalled memory at the DEFAULT budget (39 of 221 swept lengths). A bodyless attempt is
// one OMITTED entry.
export function retainsBody(original: string, shortened: string): boolean {
  if (shortened.length === 0) {
    return false;
  }
  const retained = shortened.endsWith(ELLIPSIS) ? shortened.slice(0, -ELLIPSIS.length) : shortened;
  const boundary = original.indexOf(BODY_SEPARATOR);
  if (boundary === -1) {
    return retained.trim().length > 0;
  }
  return retained.slice(boundary + BODY_SEPARATOR.length).trim().length > 0;
}

export interface BudgetedBucketRequest {
  readonly bucket: RenderBucket;
  readonly tokenBudget: number;
}

/** Everything one admission pass renders, in the order the assembled text carries it. */
export interface AdmissionRequest {
  readonly conflicts: readonly AtomicUnit[];
  readonly anchors: readonly AtomicUnit[];
  readonly buckets: readonly BudgetedBucketRequest[];
}

export interface AdmittedSections {
  readonly conflicts: RenderedSection;
  readonly anchors: RenderedSection;
  readonly buckets: readonly RenderedBucket[];
}

// The ACTUAL text order (memo §3): conflicts and anchors keep their established priority over the
// budgeted buckets, and every part is measured against what the pool has left AFTER everything
// before it, joiner included.
export function admitSections(request: AdmissionRequest, ledger: ByteLedger): AdmittedSections {
  const conflicts = renderAtomicSection("Conflicts", request.conflicts, ledger.available());
  ledger.commit(conflicts.text);
  const anchors = renderAtomicSection("Anchors", request.anchors, ledger.available());
  ledger.commit(anchors.text);
  // Array.map visits in order, so each bucket still sees only what the ones before it left behind.
  return {
    conflicts,
    anchors,
    buckets: request.buckets.map((entry) => admitBucket(entry, ledger)),
  };
}

function admitBucket(request: BudgetedBucketRequest, ledger: ByteLedger): RenderedBucket {
  const rendered = renderBudgetedBucket(request.bucket, request.tokenBudget, ledger.available());
  ledger.commit(rendered.text);
  return rendered;
}

// entryCount stays the STRUCTURAL count of rendered bullets: anchors that actually rendered plus
// every budgeted bucket's kept lines. Conflict sides have never been entries.
export function renderedEntryCount(sections: AdmittedSections): number {
  return sections.anchors.rendered + sum(sections.buckets.map((entry) => entry.entries));
}

// memo §1.8: the construction fails CLOSED — nothing downstream can repair an over-budget briefing.
export function assertBriefingFits(text: string, entries: number): AssembledBriefing {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > reserveBriefing) {
    throw ledgerDefect(`assembled ${bytes} bytes for a carrier slot of ${reserveBriefing}`);
  }
  return { text, entries };
}

export function assertNoticeFitsReserve(noticeBytes: number, reserve: number): void {
  const spent = noticeBytes + PART_JOINER_BYTES;
  if (spent > reserve) {
    throw ledgerDefect(`notice slot reserved ${reserve} bytes, notice needed ${spent}`);
  }
}

function ledgerDefect(detail: string): ContextError {
  return new ContextError(
    `composeBriefing byte ledger under-counted a rendered part: ${detail}. Internal invariant, not a caller error: capture the journal rows that produced it and file it under src/memory/briefing.ts.`,
    Zer0ErrorCode.ContextOverBudget,
  );
}
