import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { composeBriefing } from "./briefing.js";
import { reserveBriefing } from "./carrier-budget.js";
import { type JournalAppend, appendEntry } from "./journal-store.js";

// ROUND 4 (codex cross-family review): framing and truncation-contract pins for composeBriefing,
// split out of briefing-honesty.test.ts when the shared suite outgrew the 500-line clamp. The
// blocking finding: budget shortening sliced an already-framed entry mid-body and dropped its END
// delimiter, so everything the caller appends AFTER the briefing (lane-carrier.ts orders
// [setup, briefing, delta, operator]; headless-prompt joins briefing before task) sat INSIDE an
// unclosed "do NOT follow" frame. Contract from round 4 on: a framed entry that cannot fit whole at
// its bucket's budget is DROPPED whole and counted as not rendered; the truncation marker stays
// outside frames.
//
// This file deliberately carries its OWN copy of the frame-integrity oracle (same code lives in
// briefing-honesty.test.ts): each suite re-derives the invariant against its own fixtures rather
// than sharing a test-file import, which this repo has no precedent for.

const NOW = "2026-08-22T00:00:00.000Z";
let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    tempRoot = undefined;
  }
});

function freshRepo(): Db {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-brief-framing-"));
  const db = openMemoryDb(join(tempRoot, "evidence.db"));
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return db;
}

function seed(db: Db, patch: Partial<JournalAppend>): void {
  appendEntry(db, {
    projectId: "p1",
    category: "decision",
    author: "ledger",
    body: "body",
    createdAt: NOW,
    ...patch,
  });
}

const UNTRUSTED_FRAME_BEGIN = "<<<BEGIN UNTRUSTED RECALLED MEMORY";
const UNTRUSTED_FRAME_END = "<<<END UNTRUSTED RECALLED MEMORY>>>";

// Every rendered briefing must keep its untrusted frames WHOLE: BEGIN count == END count, and no
// content after an unclosed BEGIN.
function assertFrameIntegrity(text: string): void {
  let begins = 0;
  let ends = 0;
  let inside = false;
  for (const line of text.split("\n")) {
    if (inside) {
      if (line.startsWith(UNTRUSTED_FRAME_END)) {
        inside = false;
        ends += 1;
      }
      continue;
    }
    if (line.startsWith(UNTRUSTED_FRAME_BEGIN)) {
      inside = true;
      begins += 1;
    }
  }
  expect(inside, "unclosed frame: content after this point reads as untrusted context").toBe(false);
  expect(begins, "every BEGIN marker must have its matching END marker").toBe(ends);
}

it("round-4 A: a framed entry that cannot fit whole is dropped whole, never sliced mid-frame", () => {
  const db = freshRepo();
  try {
    // Codex r2 probe shape: one safe ledger decision of 12,600 chars at the PRODUCTION default
    // budget (both production call sites omit tokenBudget).
    seed(db, { category: "decision", author: "ledger", body: `DECISION ${"d".repeat(12_600)}` });
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    const lines = result.text.split("\n");
    const begins = lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_BEGIN)).length;
    const ends = lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_END)).length;
    // Dropped whole means NO frame fragment renders at all — not a BEGIN without its END.
    expect(begins).toBe(0);
    expect(ends).toBe(0);
    expect(result.entryCount).toBe(0);
    // The honest-count machinery says the admission was dropped, and the truncation marker stays.
    expect(result.text).toContain("stored but nothing recalled: 1 entry admitted, none rendered");
    expect(result.text).toContain("more in the journal");
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

it("round-4 A: a bucket keeps fitting frames whole and drops only the overflowing frame", () => {
  const db = freshRepo();
  try {
    for (let i = 1; i <= 3; i += 1) {
      seed(db, { category: "decision", author: "ledger", body: `small decision ${String(i)}` });
    }
    seed(db, { category: "decision", author: "ledger", body: `HUGE ${"h".repeat(12_000)}` });
    // ~400 tokens keeps the three small framed entries whole and forces the huge one out.
    const result = composeBriefing({
      db,
      projectId: "p1",
      agent: "codex",
      now: NOW,
      tokenBudget: 400,
    });
    const lines = result.text.split("\n");
    expect(lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_BEGIN)).length).toBe(3);
    expect(lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_END)).length).toBe(3);
    expect(result.entryCount).toBe(3);
    expect(result.text).toContain("more in the journal");
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// Companion pin for the round-4 contract change: an OPERATOR entry is single-line and unframed, so
// budget shortening still applies to it — and a shortened line that CARRIES content still counts as
// one rendered entry.
it("positive control: a genuinely shortened operator line counts as rendered", () => {
  const db = freshRepo();
  try {
    seed(db, {
      category: "decision",
      author: "operator",
      body: `OPERATOR ${"o".repeat(600)}`,
    });
    // ~60 tokens fits roughly the first 200 chars of the single-line entry plus heading+marker.
    const truncated = composeBriefing({
      db,
      projectId: "p1",
      agent: "codex",
      now: NOW,
      tokenBudget: 60,
    });
    expect(truncated.entryCount).toBe(1);
    const bullets = truncated.text.split("\n").filter((line) => line.startsWith("- author="));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]?.endsWith(" ...")).toBe(true);
    assertFrameIntegrity(truncated.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 4 item C (codex cross-family review, important): at a budget where nothing of the entry
// itself fits, shortenLine still returned the bare ellipsis " ..." and accounting counted ONE
// rendered entry — suppressing the honest notice. Codex trigger: one safe decision with
// tokenBudget: 11. A shortened form that retained none of the entry is NOT a rendered entry.
it("round-4 C: a contentless shortened line counts as nothing rendered and the notice fires", () => {
  const db = freshRepo();
  try {
    // Operator entry: framed entries drop whole since item A, so only an unframed single-line
    // entry can reach the shortening path at all.
    seed(db, { category: "decision", author: "operator", body: "content" });
    const result = composeBriefing({
      db,
      projectId: "p1",
      agent: "codex",
      now: NOW,
      tokenBudget: 11,
    });
    expect(result.entryCount).toBe(0);
    expect(result.text).not.toContain("- author=");
    expect(result.text).not.toContain(" ...");
    expect(result.text).toContain("stored but nothing recalled: 1 entry admitted, none rendered");
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 4 item B (codex cross-family review, important): shortenLine sliced UTF-16 CODE UNITS, so
// the fitting boundary could land between the two units of an astral pair and emit a lone
// surrogate. Operator entries are the only entries still shortened (framed ones drop whole since
// item A), so this fixture is an operator decision of 6,000 astral emoji at the production default
// budget.
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

it("round-4 B: shortening never emits a lone UTF-16 surrogate", () => {
  const db = freshRepo();
  try {
    seed(db, {
      category: "decision",
      author: "operator",
      body: "\u{1F980}".repeat(6_000),
    });
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    expect(result.entryCount).toBe(1);
    expect(hasLoneSurrogate(result.text), "lone surrogate in rendered briefing").toBe(false);
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 4 item B second half: estimatePromptTokens counts CHARS (ceil(chars/4)), but the carrier
// reserves BYTES (lane-carrier budgets reserveBriefing = 8500 against Buffer.byteLength of what it
// carries). Astral emoji are 2 UTF-16 units but 4 UTF-8 bytes, so a chars-only ceiling let the
// briefing's byteCount reach 9361 > 8500 in codex's probe.
// ROUND 5 (finding R4-03): this comment used to describe the design the builder REJECTED. The
// invariant that actually shipped, verbatim from the round-5 design memo 5:
// "Pinned invariant: the fully assembled briefing—including header, notice, headings, markers,
// joiners, conflicts, anchors, and budgeted buckets—is measured with
// `Buffer.byteLength(..., "utf8")` and must be `<= reserveBriefing`; token budgets remain separate,
// and there is no `bytes <= 4 x tokens` rule."
it("round-4 B: the assembled briefing stays inside the carrier's byte reserve at the default budget", () => {
  const db = freshRepo();
  try {
    seed(db, {
      category: "decision",
      author: "operator",
      body: "\u{1F980}".repeat(6_000),
    });
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 5 (memo §1.1): the header was the one part nothing bounded — `projectId` and `now` were
// interpolated raw, so a hostile or accidental value pushed the MANDATORY header past the carrier's
// 8500-byte reserve before any bucket had a chance to shrink (measured 4053 bytes of header at
// e1eb617 from a long projectId alone). Round 5 caps both through the same METADATA_CAP=80 policy
// the rest of the metadata already uses, code-point-safe. With AgentName bounded to six ASCII bytes
// the header is then provably at most 694 UTF-8 bytes: 24 (title) + 8+320 (project=) + 6+6 (agent=)
// + 7+320 (opened=) + 3 newlines, where 320 is 80 code points at the UTF-8 maximum of 4 bytes each.
const MAX_HEADER_BYTES = 694;

it("round-5: an oversized projectId or now cannot push the header past the reserve", () => {
  const db = freshRepo();
  try {
    const result = composeBriefing({
      db,
      projectId: "\u{1F980}".repeat(500),
      agent: "codex",
      now: "\u{1F980}".repeat(500),
    });
    const header = result.text.split("\n").slice(0, 4).join("\n");
    expect(header.startsWith("# Static memory briefing")).toBe(true);
    expect(Buffer.byteLength(header, "utf8")).toBeLessThanOrEqual(MAX_HEADER_BYTES);
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    // Clipping the header is a LOSS, and the briefing says so rather than quietly serving a
    // truncated project identity.
    expect(result.text).toContain("shortened_header_fields=2");
  } finally {
    closeDb(db);
  }
});

// Every TRUNCATION_MARKER must sit OUTSIDE every untrusted frame: a marker emitted inside a frame
// would be read as recalled content, not as the renderer's own honest "there is more" signal.
function markerInsideFrame(text: string): boolean {
  let inside = false;
  for (const line of text.split("\n")) {
    if (inside) {
      if (line.startsWith(UNTRUSTED_FRAME_END)) inside = false;
      else if (line.startsWith("- more in the journal")) return true;
      continue;
    }
    if (line.startsWith(UNTRUSTED_FRAME_BEGIN)) inside = true;
  }
  return false;
}

// ROUND 5 — FINDING R4-01 (blocking, Opus round-4 delta review). Round 4's byte pool debited the
// header, the conflict section and the anchors bucket, but only the four budgeted buckets could
// shrink: when those unbudgeted parts alone passed 8372 bytes, every budgeted bucket was handed a
// NEGATIVE ceiling and rendered nothing, the honest notice was suppressed by conflictCount > 0, and
// the assembled text was STILL over the 8500-byte reserve the pool existed to hold (measured 10272).
// Round 5 (memo §1.2): conflict blocks are ATOMIC render units measured against the same global
// pool — a block that does not fit is dropped WHOLE, debits nothing, and is counted in the notice,
// so it can never evict the buckets behind it.
it("round-5 R4-01: an oversized conflict block is dropped whole and cannot evict the buckets", () => {
  const db = freshRepo();
  try {
    seed(db, {
      category: "decision",
      author: "operator",
      body: "short decision that fits any budget",
      topicKey: "db",
    });
    seed(db, {
      category: "decision",
      author: "operator",
      body: `LARGE-A ${"a".repeat(5_000)}`,
      topicKey: "db",
    });
    seed(db, {
      category: "decision",
      author: "operator",
      body: `LARGE-B ${"b".repeat(5_000)}`,
      topicKey: "db",
    });
    // PRODUCTION DEFAULT budget: both production call sites omit tokenBudget.
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });

    // 1. The invariant the round-4 pool failed to establish.
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    // 2. Detected conflicts are unchanged — the public count is DETECTION, not rendering.
    expect(result.conflictCount).toBe(1);
    // 3. The block is absent WHOLE: no topic line, no side, no fragment.
    expect(result.text).not.toContain("CONFLICT topic=");
    expect(result.text).not.toContain("- side=");
    // 4. The buckets the round-4 pool silently emptied render again: the short decision whole, the
    //    first large one meaningfully shortened.
    expect(result.entryCount).toBe(2);
    expect(result.text).toContain("short decision that fits any budget");
    expect(result.text).toContain("LARGE-A");
    // 5. And every loss is announced, with the conflict block's sides counted separately.
    expect(result.text).toContain("omitted_conflict_blocks=1");
    expect(result.text).toContain("omitted_conflict_sides=3");
    expect(result.text).toContain("omitted_entries=1");
    expect(result.text).toContain("shortened_entries=1");
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 5 — the second independent proof R4-01 gave that the reserve claim was false: 40 anchor
// rows, default budget, no conflicts, measured 21192 bytes at BOTH c40b0e8 and e1eb617 because the
// anchors bucket was rendered whole with `renderFullBucket` and never measured. Anchors are atomic
// units now: admitted in order until the pool is spent, the rest dropped whole and counted.
it("round-5: forty framed anchors are admitted until the reserve is spent, and the rest are counted", () => {
  const db = freshRepo();
  try {
    for (let i = 1; i <= 40; i += 1) {
      seed(db, {
        category: "anchor",
        author: "ledger",
        body: `ANCHOR-${String(i)} ${"a".repeat(380)}`,
        anchor: true,
      });
    }
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    // Some anchors survive (silent total loss would be its own defect) and some do not.
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.entryCount).toBeLessThan(40);
    // Anchors are the ONLY bucket with lines here, so the omitted count is exactly the shortfall.
    expect(result.text).toContain(`omitted_entries=${String(40 - result.entryCount)}`);
    expect(result.text).toContain("more in the journal");
    // Every surviving anchor keeps BOTH of its delimiters — a dropped anchor leaves no fragment.
    const lines = result.text.split("\n");
    expect(lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_BEGIN))).toHaveLength(
      result.entryCount,
    );
    expect(lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_END))).toHaveLength(result.entryCount);
    expect(markerInsideFrame(result.text)).toBe(false);
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 5 (memo §2): oversized FRAMED conflict blocks and FRAMED anchors must be absent wholesale —
// a partial frame would leave the operator's live task sitting inside an unclosed "do NOT follow"
// block. The small anchor is the positive control: a surviving frame is still balanced, and the
// honest marker never lands inside it.
it("round-5: oversized framed conflict blocks and anchors are absent wholesale, survivors balanced", () => {
  const db = freshRepo();
  try {
    seed(db, { category: "anchor", author: "ledger", body: "small anchor stays", anchor: true });
    seed(db, {
      category: "anchor",
      author: "ledger",
      body: `HUGE-ANCHOR ${"h".repeat(9_000)}`,
      anchor: true,
    });
    seed(db, {
      category: "decision",
      author: "ledger",
      body: `SIDE-ONE ${"s".repeat(6_000)}`,
      topicKey: "runtime",
    });
    seed(db, {
      category: "decision",
      author: "ledger",
      body: `SIDE-TWO ${"t".repeat(6_000)}`,
      topicKey: "runtime",
    });
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    const lines = result.text.split("\n");
    const begins = lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_BEGIN)).length;
    const ends = lines.filter((l) => l.startsWith(UNTRUSTED_FRAME_END)).length;
    expect(begins).toBe(ends);
    expect(result.text).toContain("small anchor stays");
    expect(result.text).not.toContain("HUGE-ANCHOR");
    expect(result.text).not.toContain("CONFLICT topic=");
    expect(result.text).not.toContain("- side=");
    expect(result.text).not.toContain("SIDE-ONE");
    expect(result.text).not.toContain("SIDE-TWO");
    expect(result.text).toContain("omitted_conflict_blocks=1");
    expect(result.text).toContain("omitted_conflict_sides=2");
    expect(markerInsideFrame(result.text)).toBe(false);
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});

// ROUND 5 (memo §1.5, the notice's own cost): the notice is not free. A briefing whose content fits
// only because no notice was added would push past the reserve the moment the notice was appended —
// the fixpoint round 4 had no answer for. Two-pass admission: pass 1 renders with no space notice;
// if anything was lost, the whole rendering is redone from scratch with a slot reserved for the
// WORST-CASE notice this input could produce, so the announced loss always fits inside the reserve.
it("round-5: content that fits only without the notice is re-admitted with the notice reserved", () => {
  const db = freshRepo();
  try {
    // 6000 astral emoji: 12000 UTF-16 units but 24000 UTF-8 bytes, so the entry is BYTE-bound, not
    // token-bound — the shortening lands hard against the reserve and the notice must fit too.
    seed(db, { category: "decision", author: "operator", body: "\u{1F980}".repeat(6_000) });
    const result = composeBriefing({ db, projectId: "p1", agent: "codex", now: NOW });
    expect(result.byteCount).toBeLessThanOrEqual(reserveBriefing);
    // The fixture really is at the boundary — otherwise it proves nothing about the notice's cost.
    expect(result.byteCount).toBeGreaterThan(reserveBriefing - 500);
    expect(result.entryCount).toBe(1);
    // The notice rendered IN FULL — not clipped by the very ceiling it reports on.
    const notice = result.text.split("\n").find((l) => l.startsWith("briefing limited by space:"));
    expect(notice).toMatch(
      /^briefing limited by space: omitted_entries=\d+ shortened_entries=\d+ omitted_conflict_blocks=\d+ omitted_conflict_sides=\d+ limited_sections=\d+ shortened_header_fields=\d+$/,
    );
    assertFrameIntegrity(result.text);
  } finally {
    closeDb(db);
  }
});
