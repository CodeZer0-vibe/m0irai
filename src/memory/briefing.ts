/**
 * @file src/memory/briefing.ts
 * @purpose Compose a deterministic static memory briefing for one project and agent from journal rows, map rows, conflict scans and injected router pulls, preserving provenance and untrusted framing.
 * @exports BriefingPull, ComposeBriefingOptions, BriefingResult, composeBriefing
 * @depends node:buffer, node:crypto, ../evidence/db, ../shared/debug-mode, ../shared/types, ./briefing-labels, ./briefing-notice, ./briefing-render-count, ./carrier-budget, ./digest, ./journal-store, ./memory-safety, ./untrusted-framing
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Db } from "../evidence/db.js";
import { debugEnabled } from "../shared/debug-mode.js";
import type { AgentName } from "../shared/types.js";
import {
  METADATA_CAP,
  dateOnly,
  entryLabel,
  mapProvenance,
  provenance,
  safeMeta,
  untrustedProvenance,
} from "./briefing-labels.js";
import {
  type SpaceLoss,
  emptyRecallLine,
  formatSpaceNotice,
  noticeReserveBytes,
  spaceLossIsEmpty,
  spaceLossOf,
  worstCaseLoss,
} from "./briefing-notice.js";
import {
  type AdmissionRequest,
  type AssembledBriefing,
  type AtomicUnit,
  type RenderBucket,
  admitSections,
  assertBriefingFits,
  assertNoticeFitsReserve,
  bucket,
  bucketTokens,
  capMetadata,
  newByteLedger,
  renderedEntryCount,
  takeWithinBudget,
} from "./briefing-render-count.js";
import { reserveBriefing } from "./carrier-budget.js";
import { type MapEntry, generateMapSection } from "./digest.js";
import { type JournalRow, type MemoryTraceBus, readByProject } from "./journal-store.js";
import { isSafeSharedMemoryBody } from "./memory-safety.js";
import { delimitUntrusted } from "./untrusted-framing.js";

export interface BriefingPull {
  readonly entry: JournalRow;
  /** The pulled row's origin: a peer agent, or "ledger" for digest-extracted rows (W3). */
  readonly sourceAgent: AgentName | "ledger";
}

export interface ComposeBriefingOptions {
  readonly db: Db;
  readonly projectId: string;
  readonly agent: AgentName;
  readonly now: string;
  readonly tokenBudget?: number;
  readonly pulls?: readonly BriefingPull[];
  readonly trace?: MemoryTraceBus;
  /** Provider prompt boundary: admit only operator-authored journal rows, never derived memory. */
  readonly operatorOnly?: boolean;
}

export interface BriefingResult {
  readonly text: string;
  readonly hash: string;
  readonly byteCount: number;
  readonly entryCount: number;
  readonly conflictCount: number;
}

const DEFAULT_TOKEN_BUDGET = 2_000;
const JOURNAL_LIMIT = 5_000;
const CATEGORY_FLOOR = 400;
const PULL_CAP = 400;
const CORE_CATEGORIES = new Set([
  "decision",
  "contract",
  "schema-change",
  "api-change",
  "verification",
]);
const OWN_CATEGORIES = new Set(["reasoning", "scratch", "summary"]);

interface BriefingBuckets {
  readonly anchors: RenderBucket;
  readonly core: RenderBucket;
  readonly map: RenderBucket;
  readonly own: RenderBucket;
  readonly pulls: RenderBucket;
}

interface Allocations {
  readonly core: number;
  readonly map: number;
  readonly own: number;
  readonly pulls: number;
}

interface AllocationStep {
  readonly value: number;
  readonly remaining: number;
}

interface ConflictBlock {
  readonly topicKey: string;
  readonly lines: readonly string[];
}

interface BriefingRenderInput {
  readonly options: ComposeBriefingOptions;
  readonly rows: readonly JournalRow[];
  readonly map: readonly MapEntry[];
  readonly pulls: readonly BriefingPull[];
  readonly conflicts: readonly ConflictBlock[];
  readonly buckets: BriefingBuckets;
  readonly budgets: Allocations;
}

/** Compose a byte-stable static briefing for the morning preview and later prompt injection. */
export function composeBriefing(options: ComposeBriefingOptions): BriefingResult {
  const rows = oldestFirst(
    readByProject(options.db, options.projectId, { limit: JOURNAL_LIMIT }).filter((row) =>
      isAllowedBriefingRow(row, options.operatorOnly === true),
    ),
  );
  const map = options.operatorOnly
    ? []
    : generateMapSection(options.db, options.projectId).filter((entry) =>
        isSafeSharedMemoryBody(entry.summary),
      );
  const pulls = dedupePullsAgainstRenderedCore(
    options,
    rows,
    map,
    (options.pulls ?? []).filter((pull) =>
      isAllowedBriefingRow(pull.entry, options.operatorOnly === true),
    ),
  );
  const conflicts = conflictBlocks(conflictScanRows(rows, pulls));
  const buckets = buildBuckets(options, rows, map, pulls);
  const budgets = allocateBudgets(options.tokenBudget ?? DEFAULT_TOKEN_BUDGET, buckets);
  const assembled = assembleBriefing({ options, rows, map, pulls, conflicts, buckets, budgets });
  // Honest count (oracle §2): entryCount is what the TEXT renders — never rows/pulls admitted.
  const result = toResult(assembled.text, assembled.entries, conflicts.length);
  emitTrace(options.trace, result);
  return result;
}

function isAllowedBriefingRow(row: JournalRow, operatorOnly: boolean): boolean {
  return row.author === "operator" || (!operatorOnly && isSafeSharedMemoryBody(row.body));
}

// The ONE core-row selection both the renderer and the W2 pull-dedupe recompute share (drift guard).
function coreRowsOf(rows: readonly JournalRow[]): readonly JournalRow[] {
  return rows.filter((r) => CORE_CATEGORIES.has(r.category) && !r.anchor);
}

// MT6a-completion W2 (eviction-reachability): a pull duplicating a core row the budget WILL render
// wastes pull budget; a row the budget EVICTS is exactly what pulls exist for. Recompute the
// surviving core prefix with the SAME takeWithinBudget the renderer uses, then drop pulls whose seq
// the rendered core already carries.
function dedupePullsAgainstRenderedCore(
  options: ComposeBriefingOptions,
  rows: readonly JournalRow[],
  map: readonly MapEntry[],
  pulls: readonly BriefingPull[],
): readonly BriefingPull[] {
  if (pulls.length === 0) {
    return pulls;
  }
  const probe = buildBuckets(options, rows, map, []);
  const budgets = allocateBudgets(options.tokenBudget ?? DEFAULT_TOKEN_BUDGET, probe);
  // The probe runs BEFORE assembly knows the pool's real remaining size, so it uses the FULL initial
  // ceiling: a smaller keptCount only re-delivers an already-rendered row (wasteful, safe), while
  // assuming MORE headroom could silently drop an evicted row's pull channel (content loss).
  const keptCount =
    budgets.core <= 0 || probe.core.lines.length === 0
      ? 0
      : takeWithinBudget(probe.core.lines, budgets.core, `## ${probe.core.title}`, reserveBriefing)
          .lines.length;
  const renderedSeqs = new Set(
    coreRowsOf(rows)
      .slice(0, keptCount)
      .map((r) => r.seq),
  );
  return pulls.filter((p) => !renderedSeqs.has(p.entry.seq));
}

function buildBuckets(
  options: ComposeBriefingOptions,
  rows: readonly JournalRow[],
  map: readonly MapEntry[],
  pulls: readonly BriefingPull[],
): BriefingBuckets {
  const coreRows = coreRowsOf(rows);
  const ownRows = rows.filter((r) => OWN_CATEGORIES.has(r.category) && r.agent === options.agent);
  return {
    anchors: bucket("Anchors", rows.filter((r) => r.anchor).map(renderEntry)),
    core: bucket("Core decisions", coreRows.map(renderEntry)),
    map: bucket(
      "Work map",
      map.map((m) => renderMap(m, options.now)),
    ),
    own: bucket("Own journal", ownRows.map(renderEntry)),
    pulls: bucket("Router pulls", pulls.map(renderPull)),
  };
}

interface BriefingAdmission {
  readonly text: string;
  readonly entries: number;
  readonly loss: SpaceLoss;
  readonly noticeBytes: number;
}

// TWO-PASS ADMISSION (memo §1.5). Pass 1 renders with NO space-loss notice: if nothing was omitted,
// shortened or clipped, that rendering IS the answer and stays byte-identical to what it always was.
// Otherwise the document is rebuilt from scratch with a slot reserved for the WORST-CASE notice this
// input could produce, so announcing a loss can never cause more of it.
function assembleBriefing(input: BriefingRenderInput): AssembledBriefing {
  const request = admissionRequest(input);
  const first = admitBriefing(input, request, 0);
  if (spaceLossIsEmpty(first.loss)) {
    return assertBriefingFits(first.text, first.entries);
  }
  const reserve = noticeReserveBytes(worstCaseLoss(request), admittedCount(input));
  const second = admitBriefing(input, request, reserve);
  assertNoticeFitsReserve(second.noticeBytes, reserve);
  return assertBriefingFits(second.text, second.entries);
}

function admissionRequest(input: BriefingRenderInput): AdmissionRequest {
  const { anchors, core, map, own, pulls } = input.buckets;
  return {
    conflicts: conflictUnits(input.conflicts),
    anchors: anchors.lines.map((text) => ({ text, weight: 1 })),
    buckets: [
      { bucket: core, tokenBudget: input.budgets.core },
      { bucket: map, tokenBudget: input.budgets.map },
      { bucket: own, tokenBudget: input.budgets.own },
      { bucket: pulls, tokenBudget: input.budgets.pulls },
    ],
  };
}

function admitBriefing(
  input: BriefingRenderInput,
  request: AdmissionRequest,
  noticeReserve: number,
): BriefingAdmission {
  const head = boundedHeader(input.options);
  const ledger = newByteLedger(reserveBriefing);
  ledger.commit(head.text);
  ledger.reserve(noticeReserve);
  const sections = admitSections(request, ledger);
  const entries = renderedEntryCount(sections);
  const loss = spaceLossOf(sections, head.shortenedFields);
  const notice = briefingNotice(input, entries, sections.conflicts.rendered, loss);
  const head_ = [head.text, notice, sections.conflicts.text, sections.anchors.text];
  const parts = [...head_, ...sections.buckets.map((rendered) => rendered.text)];
  const text = parts.filter((part) => part.length > 0).join("\n\n");
  return { text, entries, loss, noticeBytes: Buffer.byteLength(notice, "utf8") };
}

function admittedCount(input: BriefingRenderInput): number {
  return input.rows.length + input.map.length + input.pulls.length;
}

function allocateBudgets(tokenBudget: number, buckets: BriefingBuckets): Allocations {
  const total = Math.max(0, Math.trunc(tokenBudget));
  const anchorTokens = bucketTokens(buckets.anchors);
  const floors = floorAllocations(Math.max(0, total - anchorTokens));
  let remaining = Math.max(0, total - anchorTokens - floors.core - floors.map - floors.own);
  const core = growAllocation(floors.core, bucketTokens(buckets.core), remaining);
  remaining = core.remaining;
  const map = growAllocation(floors.map, bucketTokens(buckets.map), remaining);
  remaining = map.remaining;
  const own = growAllocation(floors.own, bucketTokens(buckets.own), remaining);
  remaining = own.remaining;
  return {
    core: core.value,
    map: map.value,
    own: own.value,
    pulls: pullBudget(buckets.pulls, remaining),
  };
}

function floorAllocations(remaining: number): Omit<Allocations, "pulls"> {
  let left = remaining;
  const next = (): number => {
    const value = Math.min(CATEGORY_FLOOR, left);
    left -= value;
    return value;
  };
  return { core: next(), map: next(), own: next() };
}

function growAllocation(current: number, demand: number, remaining: number): AllocationStep {
  const extra = Math.min(Math.max(0, demand - current), remaining);
  return { value: current + extra, remaining: remaining - extra };
}

function pullBudget(bucket: RenderBucket, remaining: number): number {
  return Math.min(PULL_CAP, bucketTokens(bucket), remaining);
}

// Round 5 (memo §1.1): the header is the ONE part that can never shrink — `projectId`/`now` reached
// it raw, a 4053-byte header was reachable from a long projectId alone. Same METADATA_CAP as every
// field: at most 24 + (8+320) + (6+6) + (7+320) + 3 = 694 bytes for `project=`/`now=`; AgentName is
// closed to 6 ASCII bytes (DB CHECK, evidence/schema.sql:285-286). M1b r2 (review r1 IMPORTANT 3):
// `agent=` had neither cap nor neutralizer — unreachable without a cast, but capMetadata-wrapped too
// now as defense in depth; the closed union/DB CHECK stay primary. Each clipped field COUNTS.
interface BoundedHeader {
  readonly text: string;
  readonly shortenedFields: number;
}

function boundedHeader(options: ComposeBriefingOptions): BoundedHeader {
  const project = capMetadata(options.projectId, METADATA_CAP);
  const agent = capMetadata(options.agent, METADATA_CAP);
  const opened = capMetadata(options.now, METADATA_CAP);
  const text = [
    "# Static memory briefing",
    `project=${project.text}`,
    `agent=${agent.text}`,
    `opened=${opened.text}`,
  ].join("\n");
  return {
    text,
    shortenedFields:
      (project.shortened ? 1 : 0) + (agent.shortened ? 1 : 0) + (opened.shortened ? 1 : 0),
  };
}

// The notice slot, right after the header: at most two lines. The first answers "did anything come
// out", the second "what was lost", and they are INDEPENDENT (memo §1.6) — round 4 let a rendered
// conflict suppress the whole slot, which is how two real ASCII entries vanished (R4-01).
function briefingNotice(
  input: BriefingRenderInput,
  renderedEntries: number,
  renderedConflicts: number,
  loss: SpaceLoss,
): string {
  const empty = emptyRecallLine(admittedCount(input), renderedEntries, renderedConflicts);
  return [empty, formatSpaceNotice(loss)].filter((line) => line.length > 0).join("\n");
}

// One conflict block — topic line plus every side and every complete frame — is ONE atomic unit
// (memo §1.2), weighted by its side count so the notice can report blocks and sides separately.
// Rendering is unchanged: a section that fits is byte-identical to before.
function conflictUnits(conflicts: readonly ConflictBlock[]): readonly AtomicUnit[] {
  return conflicts.map((block) => ({
    text: [`CONFLICT topic=${safeMeta(block.topicKey)}`, ...block.lines].join("\n"),
    weight: block.lines.length,
  }));
}

function conflictScanRows(
  rows: readonly JournalRow[],
  pulls: readonly BriefingPull[],
): readonly JournalRow[] {
  const seen = new Set<number>();
  const merged = [
    ...rows,
    ...pulls.map((p) =>
      p.sourceAgent === "ledger" ? p.entry : { ...p.entry, agent: p.sourceAgent },
    ),
  ];
  return merged.filter((row) => {
    if (seen.has(row.seq)) {
      return false;
    }
    seen.add(row.seq);
    return true;
  });
}

function conflictBlocks(rows: readonly JournalRow[]): readonly ConflictBlock[] {
  const grouped = new Map<string, JournalRow[]>();
  for (const row of rows) {
    if ((row.category === "decision" || row.anchor) && row.topicKey !== null) {
      grouped.set(row.topicKey, [...(grouped.get(row.topicKey) ?? []), row]);
    }
  }
  return [...grouped.entries()].flatMap(([topicKey, topicRows]) =>
    buildConflict(topicKey, topicRows),
  );
}

function buildConflict(topicKey: string, rows: readonly JournalRow[]): readonly ConflictBlock[] {
  if (rows.length < 2 || !rows.some((r) => r.category === "decision")) {
    return [];
  }
  const ordered = [...rows].sort(compareConflictRows);
  return [{ topicKey, lines: ordered.map((r, i) => renderConflictSide(r, i + 1)) }];
}

function compareConflictRows(left: JournalRow, right: JournalRow): number {
  if (left.anchor !== right.anchor) {
    return left.anchor ? -1 : 1;
  }
  return left.seq - right.seq;
}

function renderConflictSide(row: JournalRow, side: number): string {
  const prefix = `- side=${side} provenance=${provenance(row)}`;
  // Only operator-authored content is trusted-unframed; every model-derived body (agent OR ledger/digest) is framed; fail-safe: an unknown author is framed.
  if (row.author !== "operator") {
    return `${prefix}\n${delimitUntrusted(row.body, untrustedProvenance(row)).trimEnd()}`;
  }
  return `${prefix} :: ${oneLine(row.body)}`;
}

function renderEntry(row: JournalRow): string {
  const prefix = `- ${entryLabel(row)} category=${safeMeta(row.category)}`;
  if (row.author !== "operator") {
    return `${prefix}\n${delimitUntrusted(row.body, untrustedProvenance(row)).trimEnd()}`;
  }
  return `${prefix} :: ${oneLine(row.body)}`;
}

function renderPull(pull: BriefingPull): string {
  // A ledger pull keeps its row's own agent (null): provenance/framing already carry ledger
  // authorship (MT5d). An agent pull labels the source agent explicitly.
  return renderEntry(
    pull.sourceAgent === "ledger" ? pull.entry : { ...pull.entry, agent: pull.sourceAgent },
  );
}

function renderMap(entry: MapEntry, now: string): string {
  const date = dateOnly(now);
  const provenance = mapProvenance(entry, date);
  const files = entry.files.length > 0 ? entry.files.join(",") : "none";
  const state = entry.verified ? "verified" : "unverified";
  const prefix = `- author=${safeMeta(entry.agent)} origin=ledger date=${date} provenance=${provenance} files=${safeMeta(files)} state=${state}`;
  return `${prefix}\n${delimitUntrusted(entry.summary, provenance).trimEnd()}`;
}

function oldestFirst(rows: readonly JournalRow[]): readonly JournalRow[] {
  return [...rows].sort((a, b) => a.seq - b.seq);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toResult(text: string, entryCount: number, conflictCount: number): BriefingResult {
  const byteCount = Buffer.byteLength(text, "utf8");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { text, hash, byteCount, entryCount, conflictCount };
}

function emitTrace(trace: MemoryTraceBus | undefined, result: BriefingResult): void {
  if (trace === undefined || !debugEnabled()) {
    return;
  }
  const detail = `hash=${result.hash} bytes=${result.byteCount} entries=${result.entryCount} conflicts=${result.conflictCount}`;
  trace.emit({ kind: "memory.trace", phase: "briefing", turn: 0, detail });
}
