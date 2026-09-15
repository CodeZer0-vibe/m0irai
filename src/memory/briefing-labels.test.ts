import { expect, it } from "vitest";
import {
  METADATA_CAP,
  authorLabel,
  dateOnly,
  entryLabel,
  mapProvenance,
  provenance,
  safeMeta,
  untrustedProvenance,
} from "./briefing-labels.js";
import type { JournalRow } from "./journal-store.js";

// Unit home for briefing.ts's label-field renderers (FL-180 extraction, M1b round 2). Integration
// coverage of these through the full composeBriefing pipeline lives in briefing-boundary.test.ts,
// briefing.test.ts and briefing-framing.test.ts; these pin the string-building mechanics directly.

function row(overrides: Partial<JournalRow> = {}): JournalRow {
  return {
    entryId: "e1",
    projectId: "p1",
    category: "decision",
    author: "agent",
    agent: "claude",
    body: "body",
    topicKey: null,
    touchedFiles: null,
    domainTags: null,
    anchor: false,
    supersededBy: null,
    seq: 7,
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

it("safeMeta is the capMetadata text at METADATA_CAP", () => {
  expect(safeMeta("hello")).toBe("hello");
  expect(safeMeta("  a   b  ")).toBe("a b"); // whitespace collapsed
  expect(METADATA_CAP).toBe(80);
  expect(safeMeta("x".repeat(200)).length).toBeLessThanOrEqual(METADATA_CAP);
});

// dateOnly's own contract (M1b rounds 1+2): parse-and-re-encode, never a raw slice; unparsable or
// offset-less input renders the fixed literal "unknown", never any part of the original string.
it("dateOnly re-encodes a Z-suffixed ISO timestamp to its UTC calendar date", () => {
  expect(dateOnly("2026-07-05T00:00:00.000Z")).toBe("2026-07-05");
  expect(dateOnly("2026-01-01T23:59:59Z")).toBe("2026-01-01");
});

it("dateOnly accepts a full ISO timestamp with an explicit numeric offset", () => {
  expect(dateOnly("2026-08-22T01:30:00+02:00")).toBe("2026-08-21"); // resolves to UTC correctly
});

it("dateOnly renders unknown for anything without an explicit Z/offset designator", () => {
  expect(dateOnly("2026-08-22 01:30:00")).toBe("unknown"); // SQLite datetime('now') shape
  expect(dateOnly("2026-08-22")).toBe("unknown"); // date-only, no time/offset
  expect(dateOnly("1234")).toBe("unknown"); // bare digits used to parse as a year
});

it("dateOnly renders unknown for garbage, empty, and calendar-invalid input — never the raw string", () => {
  expect(dateOnly("1234\nESCAPE")).toBe("unknown");
  expect(dateOnly("123456789\u{1F600}")).toBe("unknown");
  expect(dateOnly("")).toBe("unknown");
  expect(dateOnly("not-a-date")).toBe("unknown");
  expect(dateOnly("9999-99-99T99:99:99.999Z")).toBe("unknown");
});

it("entryLabel composes author/origin/date/provenance in the fixed field order", () => {
  const r = row({ author: "agent", agent: "claude", seq: 42 });
  expect(entryLabel(r)).toBe(
    "author=claude origin=agent date=2026-07-05 provenance=claude:agent:2026-07-05:seq42",
  );
});

it("provenance composes authorLabel:author:date:seq and is itself safeMeta-wrapped", () => {
  const r = row({ author: "operator", agent: null, seq: 1 });
  expect(provenance(r)).toBe("operator:operator:2026-07-05:seq1");
});

it("untrustedProvenance prefixes journal: ahead of the same author:date:seq shape", () => {
  const r = row({ author: "ledger", agent: null, seq: 9 });
  expect(untrustedProvenance(r)).toBe("journal:ledger:2026-07-05:seq9");
});

it("mapProvenance composes map:agent:date", () => {
  expect(
    mapProvenance({ agent: "codex", files: [], summary: "s", verified: true }, "2026-01-01"),
  ).toBe("map:codex:2026-01-01");
});

it("authorLabel resolves to the agent name when author is 'agent', and to author otherwise", () => {
  expect(authorLabel(row({ author: "agent", agent: "gemini" }))).toBe("gemini");
  expect(authorLabel(row({ author: "agent", agent: null }))).toBe("agent"); // fallback literal
  expect(authorLabel(row({ author: "operator" }))).toBe("operator");
  expect(authorLabel(row({ author: "ledger" }))).toBe("ledger");
});
