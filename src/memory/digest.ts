/**
 * @file src/memory/digest.ts
 * @purpose The digest PASS (D3/D4/J3): reads the transcript via the real loader (the authority — a message
 *   there but absent from the DB mirror is still digested + traced), filters completed messages NOT in the
 *   watermark set, extracts facts via the seamed CLI, and writes journal entries + watermark ids ATOMICALLY
 *   (one IMMEDIATE tx reusing appendEntry). M3: a decision's settled speaker rides onto entries.agent
 *   (author stays "ledger"); unattributable -> agent:null, counted + traced. Failure = classified row, retry.
 * @exports DigestDeps, DigestOutcome, MapEntry, readWatermarkSet, runDigestPass, generateMapSection
 * @depends ../chat/events, ../chat/session-store, ../chat/types, ../evidence/db, ../shared/debug-mode, ./digest-extractor, ./journal-classifier, ./journal-store
 */
import type { MemoryTracePhase } from "../chat/events.js";
import { loadSession } from "../chat/session-store.js";
import type { ChatMessage } from "../chat/types.js";
import type { Db } from "../evidence/db.js";
import { debugEnabled } from "../shared/debug-mode.js";
import { type DigestDispatch, type ExtractionResult, extractDigest } from "./digest-extractor.js";
import { type JournalCategory, classifyPlacement } from "./journal-classifier.js";
import { type JournalAppend, type MemoryTraceBus, appendEntry } from "./journal-store.js";

/** Everything the pass needs. `now` is caller-supplied (determinism); `trace` is absent when debug is off. */
export interface DigestDeps {
  readonly db: Db;
  readonly sessionId: `chat-${string}`;
  readonly repoRoot: string;
  readonly projectId: string;
  readonly dispatch: DigestDispatch;
  readonly now: string;
  readonly trace?: MemoryTraceBus;
  // Test-only barrier seam (MT3d): fires AFTER this pass read the watermark + extracted, BEFORE it writes — so
  // a test can interleave a racing sibling's commit between our check and our use (the TOCTOU). Never set in
  // production; the async gap it opens is exactly the window the in-tx re-read (writeDigestAtomic) must defeat.
  readonly onBeforeWrite?: () => void | Promise<void>;
}

export type DigestOutcome =
  | {
      readonly ok: true;
      readonly digested: number;
      /** DECISIONS (not messages) that landed agent:null — no in-set agent-seat speaker (M3); may exceed
       *  `digested`, which counts messages. Absent when 0. */
      readonly unattributed?: number;
    }
  | { readonly ok: false; readonly classification: string; readonly detail: string };

/** One work-map row derived from a reconciler-verified report. `verified: false` renders as "unverified". */
export interface MapEntry {
  readonly agent: string;
  readonly files: readonly string[];
  readonly summary: string;
  readonly verified: boolean;
}

const WATERMARK_SQL =
  "SELECT message_id FROM digest_watermark WHERE project_id = ? AND session_id = ?";
const INSERT_WATERMARK_SQL =
  "INSERT OR IGNORE INTO digest_watermark (project_id, session_id, message_id, created_at) VALUES (?, ?, ?, ?)";
const MIRROR_SQL = "SELECT 1 AS present FROM chat_messages WHERE id = ?";
const MAP_SQL =
  "SELECT agent, claimed_json, status FROM agent_reports WHERE project_id = ? AND status IN ('verified','mismatch') ORDER BY seq ASC";

/**
 * Runs one digest pass for a session. Idempotent + gap-tolerant via the watermark SET (a message is processed
 * iff completed AND not already in the set). On success the facts + the processed ids commit together; on an
 * extraction failure a classified record lands and the watermark does NOT advance (D4 → retry).
 */
export async function runDigestPass(deps: DigestDeps): Promise<DigestOutcome> {
  const { db, sessionId, repoRoot, projectId, dispatch, now, trace } = deps;
  const session = await loadSession(sessionId, repoRoot);
  const digested = readWatermarkSet(db, projectId, sessionId);
  const pending = session.messages.filter((m) => m.status === "completed" && !digested.has(m.id));
  if (pending.length === 0) {
    return { ok: true, digested: 0 };
  }
  traceSplitTruth(db, pending, trace);
  const result = await extractDigest(pending, dispatch);
  if (!result.ok) {
    writeFailureRecord(db, projectId, result, now);
    emitTrace(trace, "digest", `digest-failed ${result.classification} session=${sessionId}`);
    return { ok: false, classification: result.classification, detail: result.detail };
  }
  const facts = extractionToFacts(result, projectId, now);
  await deps.onBeforeWrite?.(); // test seam: lets a racing sibling commit between our watermark read and write
  const committed = writeDigestAtomic(db, { projectId, sessionId, facts, pending, now, trace });
  if (!committed) {
    // A racing sibling committed these messages first (MT3d TOCTOU) — the extraction is wasted but nothing is
    // duplicated. Report zero digested; the trace makes the raced-skip observable rather than silent.
    emitTrace(
      trace,
      "digest",
      `skipped ${pending.length} (raced — already digested) session=${sessionId}`,
    );
    return { ok: true, digested: 0 };
  }
  const shared = facts.filter(
    (f) => classifyPlacement(f.category as JournalCategory) === "shared",
  ).length;
  // M3: the agent:null fallback is COUNTED (outcome) and TRACED (this line) — a session whose extractor
  // names no in-set speaker is observable, never a silent return to the all-NULL journal.
  const unattributed = result.unattributed;
  emitTrace(
    trace,
    "digest",
    `digested ${pending.length} (shared=${shared}${unattributed > 0 ? `, unattributed=${unattributed}` : ""}) session=${sessionId}`,
  );
  return {
    ok: true,
    digested: pending.length,
    ...(unattributed > 0 ? { unattributed } : {}),
  };
}

/**
 * Derives the work map ONLY from reconciler-verified rows (J3). A claims-only report (never reconciled) is
 * absent from the status filter and produces NO entry; a `verified` report is a fact; a `mismatch` report
 * surfaces with `verified: false` ("unverified"). Pure read.
 */
export function generateMapSection(db: Db, projectId: string): readonly MapEntry[] {
  const rows = db.prepare(MAP_SQL).all(projectId) as {
    agent: string;
    claimed_json: string | null;
    status: string;
  }[];
  return rows.map((r) => {
    const claimed = parseClaimed(r.claimed_json);
    return {
      agent: r.agent,
      files: claimed.files,
      summary: claimed.summary,
      verified: r.status === "verified",
    };
  });
}

/**
 * The set of message ids this session has already digested. Exported so the detached entry can settle on
 * the SAME predicate over a READ-ONLY handle before it opens for write (FL-074) - a copied query there
 * could drift from this one and start skipping work that was never actually done.
 *
 * @param db - any open memory-schema handle, including a read-only one
 * @param projectId - the project the session belongs to
 * @param sessionId - the session whose watermark is read
 * @returns the digested message ids; empty when the session has no watermark rows yet
 */
export function readWatermarkSet(
  db: Db,
  projectId: string,
  sessionId: string,
): ReadonlySet<string> {
  const rows = db.prepare(WATERMARK_SQL).all(projectId, sessionId) as { message_id: string }[];
  return new Set(rows.map((r) => r.message_id));
}

// D3 split-truth: a completed message in the transcript whose id is absent from the DB mirror (chat_messages)
// is STILL digested (the transcript is the authority); the divergence is traced, one event per message id.
function traceSplitTruth(
  db: Db,
  pending: readonly ChatMessage[],
  trace: MemoryTraceBus | undefined,
): void {
  if (trace === undefined || !debugEnabled()) {
    return;
  }
  const mirror = db.prepare(MIRROR_SQL);
  for (const m of pending) {
    if (mirror.get(m.id) === undefined) {
      emitTrace(trace, "digest", `${m.id} absent from DB mirror`);
    }
  }
}

function extractionToFacts(
  result: Extract<ExtractionResult, { ok: true }>,
  projectId: string,
  now: string,
): readonly JournalAppend[] {
  const facts: JournalAppend[] = result.extraction.decisions.map((d) => ({
    projectId,
    category: "decision",
    author: "ledger",
    // M3 attribution: the extractor's SETTLED speaker rides onto the row (author stays "ledger" — the
    // digest is still the writer); absent -> the column lands NULL, the deliberate counted fallback.
    ...(d.agent ? { agent: d.agent } : {}),
    body: d.body,
    topicKey: d.topic,
    createdAt: now,
    ...(d.files ? { touchedFiles: d.files } : {}),
  }));
  if (result.extraction.summary.trim().length > 0) {
    // MT6a-completion W1: the summary carries the session's file set (the deduped union of the
    // extraction's decision files) so the router's file-intersection can pull it cross-session —
    // the filed follow-up: "summary auto-participates once summaries gain files".
    const summaryFiles = [...new Set(result.extraction.decisions.flatMap((d) => d.files ?? []))];
    facts.push({
      projectId,
      category: "summary",
      author: "ledger",
      body: result.extraction.summary,
      createdAt: now,
      ...(summaryFiles.length > 0 ? { touchedFiles: summaryFiles } : {}),
    });
  }
  return facts;
}

interface DigestWrite {
  readonly projectId: string;
  readonly sessionId: string;
  readonly facts: readonly JournalAppend[];
  readonly pending: readonly ChatMessage[];
  readonly now: string;
  readonly trace: MemoryTraceBus | undefined;
}

// The facts + the processed message ids commit TOGETHER (D3 atomicity). IMMEDIATE takes the write lock at
// BEGIN, so appendEntry's seq-select+insert cannot race a cockpit writer — its retry loop stays dormant.
// MT3d TOCTOU guard: re-read the watermark INSIDE the write lock. Under fail-open single-flight two children
// can both pre-read an empty watermark and extract the SAME messages; IMMEDIATE serialises their writes, so
// whoever commits SECOND sees the first's watermark rows here and writes NOTHING — exactly-once facts (the
// wasted extraction is the only cost). Any overlap aborts the whole batch (batch facts aren't per-message
// separable); the un-committed messages stay pending and are gap-tolerantly re-digested next pass. Returns
// whether it committed.
function writeDigestAtomic(db: Db, write: DigestWrite): boolean {
  const { projectId, sessionId, facts, pending, now, trace } = write;
  const insertWatermark = db.prepare(INSERT_WATERMARK_SQL);
  const opts = trace ? { trace } : undefined;
  let committed = false;
  const tx = db.transaction(() => {
    const already = readWatermarkSet(db, projectId, sessionId);
    if (pending.some((m) => already.has(m.id))) {
      return; // a racing sibling committed one of our messages first — skip to keep facts exactly-once
    }
    for (const fact of facts) {
      appendEntry(db, fact, opts);
    }
    for (const m of pending) {
      insertWatermark.run(projectId, sessionId, m.id, now);
    }
    committed = true;
  });
  tx.immediate();
  return committed;
}

// D4: a durable, classified failure record as a ledger scratch entry — the watermark is NOT touched, so the
// pending messages stay pending and the next boot pass retries. No stdout/stderr (acceptance 8).
function writeFailureRecord(
  db: Db,
  projectId: string,
  result: Extract<ExtractionResult, { ok: false }>,
  now: string,
): void {
  appendEntry(db, {
    projectId,
    category: "scratch",
    author: "ledger",
    body: `[digest-failed] ${result.classification}: ${result.detail}`,
    createdAt: now,
  });
}

function parseClaimed(claimedJson: string | null): { files: readonly string[]; summary: string } {
  if (claimedJson === null) {
    return { files: [], summary: "" };
  }
  try {
    const parsed = JSON.parse(claimedJson) as { files_touched?: unknown; summary?: unknown };
    const files = Array.isArray(parsed.files_touched) ? (parsed.files_touched as string[]) : [];
    return { files, summary: typeof parsed.summary === "string" ? parsed.summary : "" };
  } catch {
    return { files: [], summary: "" };
  }
}

function emitTrace(
  trace: MemoryTraceBus | undefined,
  phase: MemoryTracePhase,
  detail: string,
): void {
  if (trace === undefined || !debugEnabled()) {
    return;
  }
  trace.emit({ kind: "memory.trace", phase, turn: 0, detail });
}
