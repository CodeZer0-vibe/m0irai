/**
 * @file src/memory/briefing-labels.ts
 * @purpose Every trusted, unframed label field a rendered briefing entry carries — author/origin/
 *   date/provenance and the shared metadata cap they render through. Extracted from briefing.ts
 *   (M1b round 2, FL-180 ratchet): this is the exact seam the M1b review's whole finding set is
 *   about ("audit every label field"), and both briefing.ts and briefing-render-count.ts were at the
 *   500-line clamp with no room for round 2's fixes.
 * @exports METADATA_CAP, safeMeta, dateOnly, entryLabel, provenance, untrustedProvenance, mapProvenance, authorLabel
 * @depends ./briefing-render-count, ./digest, ./journal-store
 */
import { capMetadata } from "./briefing-render-count.js";
import type { MapEntry } from "./digest.js";
import type { JournalRow } from "./journal-store.js";

export const METADATA_CAP = 80;

// One cap, one implementation: capMetadata owns the code-point-safe truncation the header and every
// metadata field share, so the two can never drift apart.
export function safeMeta(value: string): string {
  return capMetadata(value, METADATA_CAP).text;
}

// M1b r1 (codex-sealed-lanes-out.md §1): was a raw `value.slice(0, 10)` UTF-16 cut of the stored,
// never-validated created_at, rendered BEFORE framing — a stored newline split the label unframed, an
// astral pair on the boundary emitted a lone surrogate. Fix: parse and RE-ENCODE, never slice raw
// text; unparsable -> "unknown". M1b r2 (review r1 IMPORTANT 2): a bare `new Date(string)` on an
// offset-less timestamp parses in the HOST's local timezone — differs by machine, and
// BriefingResult.hash is a determinism contract. No live writer emits one today, but this closes the
// host-clock input entirely.
//
// M1b r3 (review r1 round-2 delta nit 2): the regex is a strict SUBSET of ISO 8601, not the whole
// standard — it requires seconds (`2026-08-22T01:30Z`, valid ISO 8601, renders "unknown" here) and a
// colon in the offset (`+0200` renders "unknown"). Erring toward "unknown" is the right direction and
// matches the only live writer, `toISOString()` (`YYYY-MM-DDTHH:mm:ss.sssZ`), so this narrowness costs
// nothing in practice.
//
// M1b r3 (review r1 round-2 delta nit 3): `date=` renders the UTC CALENDAR DAY of the parsed instant,
// not the offset-local day — `2026-08-22T01:30:00+02:00` (01:30 in Bucharest on the 22nd) renders
// `2026-08-21`. Deliberate: the UTC day is a property of the instant itself, not of any reader's
// timezone, so it is the one choice that stays deterministic and matches every live `Z`-suffixed
// writer exactly. Unreachable today — no writer emits a non-Z offset — so this is a reasoned choice
// for if one ever does, not a live behavior change.
const ISO_TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function dateOnly(value: string): string {
  if (!ISO_TIMESTAMP_WITH_OFFSET.test(value)) {
    return "unknown";
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  const year = parsed.getUTCFullYear();
  if (Number.isNaN(time) || year < 0 || year > 9999) {
    return "unknown";
  }
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

export function entryLabel(row: JournalRow): string {
  return `author=${authorLabel(row)} origin=${safeMeta(row.author)} date=${dateOnly(row.createdAt)} provenance=${provenance(row)}`;
}

export function provenance(row: JournalRow): string {
  return safeMeta(`${authorLabel(row)}:${row.author}:${dateOnly(row.createdAt)}:seq${row.seq}`);
}

export function untrustedProvenance(row: JournalRow): string {
  return safeMeta(`journal:${authorLabel(row)}:${dateOnly(row.createdAt)}:seq${row.seq}`);
}

export function mapProvenance(entry: MapEntry, date: string): string {
  return safeMeta(`map:${entry.agent}:${date}`);
}

export function authorLabel(row: JournalRow): string {
  if (row.author === "agent") {
    return safeMeta(row.agent ?? "agent");
  }
  return safeMeta(row.author);
}
