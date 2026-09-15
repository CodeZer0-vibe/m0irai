#!/usr/bin/env node
// Regenerates src/chat/codex-usage-captures.fixtures.ts from REAL ~/.codex/sessions rollout lines.
//
// Why this exists: the codex usage decoder was written to an imagined `rate_limits` shape and rendered a
// weekly window as a 5-hour one for months. The fix is only trustworthy if its tests run against payloads
// the vendor ACTUALLY sent, so every fixture is sliced byte-for-byte out of a named file at a named line —
// no JSON.parse/stringify round trip (which would reorder keys and rewrite `0.0` as `0`), no retyping.
//
//   node scripts/extract-codex-captures.mjs src/chat/codex-usage-captures.fixtures.ts
//
// Add a row to CAPTURES when a NEW vendor shape shows up in the wild, then re-run and commit the result.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const SESSIONS = join(homedir(), ".codex", "sessions");

const CAPTURES = [
  {
    id: "WEEKLY_ONLY_IDLE",
    rel: "2026/07/16/rollout-2026-07-16T15-34-06-019f6aeb-6cdb-7b51-b64d-d3b78e51f4e4.jsonl",
    line: 257,
    doc: "TODAY'S REAL STATE (the operator's false warning). Weekly-only window at 0% used, plus\n *   the unfunded credits wallet the old decoder read as 'subscription spent'. plan_type prolite.",
  },
  {
    id: "WEEKLY_ONLY_97",
    rel: "2026/07/25/rollout-2026-07-25T21-45-39-019f9a98-e4c2-7e10-bac5-7323625a3747.jsonl",
    line: 215,
    doc: "Weekly-only at 97% used - the genuine 'running low' warning. Carries a\n *   `spend_control_reached` key the 07-16 capture does NOT: observed vendor drift, ignored safely.",
  },
  {
    id: "WEEKLY_ONLY_SPENT",
    rel: "2026/07/21/rollout-2026-07-21T21-39-57-019f85fa-30ab-7100-be75-217263c8bc75.jsonl",
    line: 116,
    doc: "Weekly-only at 100% used - REAL exhaustion, carrying the SAME unfunded credits block as\n *   WEEKLY_ONLY_IDLE. The pair proves exhaustion tracks the window, never the wallet.",
  },
  {
    id: "BOTH_WINDOWS",
    rel: "2026/07/09/rollout-2026-07-09T21-47-26-019f4834-c761-7111-bdfc-3f6db59c00e0.jsonl",
    line: 300,
    doc: "Both windows present (plan_type plus): a 300-minute 5h window at 27% as `primary` and a\n *   10080-minute weekly at 100% as `secondary`. The weekly moves between primary and secondary BY\n *   PLAN - which is exactly why position mapping lied.",
  },
  {
    id: "LEGACY_RELATIVE_RESETS",
    rel: "2025/09/30/rollout-2025-09-30T01-57-41-019997b2-321d-7443-acd8-188885a7610e.jsonl",
    line: 7,
    doc: "The 2025 shape: window_minutes 299/10079 (NOT 300/10080) and RELATIVE\n *   `resets_in_seconds` instead of absolute `resets_at`, with no credits block at all. Proves the\n *   duration classifier must tolerate vendor jitter and that both reset encodings are real.",
  },
  {
    id: "UNRECOGNISED_WINDOW",
    rel: "2026/06/03/rollout-2026-06-03T10-08-00-019e8c4f-7df6-7b13-8b09-0b0df9451387.jsonl",
    line: 17,
    doc: "A window whose stated duration is 0 minutes, and a null credits block - a REAL payload our\n *   classifier cannot name. The drift case, captured rather than imagined.",
  },
  {
    id: "NO_WINDOW_MIDSESSION",
    rel: "2026/07/22/rollout-2026-07-22T01-12-54-019f86bd-3211-71e2-8a94-e5d271f69810.jsonl",
    line: 50,
    doc: "primary AND secondary null, mid-session, on a HEALTHY account: the 70 OTHER token_count\n *   lines in this same file all read 27% weekly. Absent windows mean 'not reported this turn', never\n *   'spent' - the old decoder called this shape FULL/exhausted.",
  },
];

/** Advances the brace-matching scan by one character; split out so the scanner itself stays flat. */
function step(state, c) {
  if (state.esc) return { ...state, esc: false };
  if (c === "\\") return { ...state, esc: true };
  if (c === '"') return { ...state, inStr: !state.inStr };
  if (state.inStr) return state;
  if (c === "{") return { ...state, depth: state.depth + 1 };
  if (c === "}") return { ...state, depth: state.depth - 1 };
  return state;
}

/** The EXACT source bytes of the `rate_limits` object on `line` — a balanced-brace slice, never a re-encode. */
function sliceRateLimits(line) {
  const at = line.indexOf('"rate_limits":');
  if (at < 0) throw new Error("no rate_limits on line");
  const start = line.indexOf("{", at);
  let state = { depth: 0, inStr: false, esc: false };
  for (let i = start; i < line.length; i += 1) {
    state = step(state, line[i]);
    if (state.depth === 0 && i > start) return line.slice(start, i + 1);
  }
  throw new Error("unbalanced rate_limits object");
}

function payloadFor(capture) {
  const lines = readFileSync(join(SESSIONS, capture.rel), "utf8").split("\n");
  const raw = lines[capture.line - 1];
  if (raw === undefined) throw new Error(`${capture.rel}: no line ${capture.line}`);
  const payload = sliceRateLimits(raw);
  if (payload.includes("'") || payload.includes("\\")) {
    throw new Error(`${capture.rel}: payload needs escaping; emit it as a different literal`);
  }
  return payload;
}

const blocks = CAPTURES.map((capture) => {
  const payload = payloadFor(capture);
  const provenance = `CAPTURED VERBATIM FROM: ~/.codex/sessions/${capture.rel}\n *   line ${capture.line}`;
  return `/**\n * ${capture.doc}\n * ${provenance}\n */\nconst ${capture.id}_RAW =\n  '${payload}';`;
});

const header = `/**
 * @file src/chat/codex-usage-captures.fixtures.ts
 * @exports ${CAPTURES.map((c) => c.id).join(", ")}
 * @depends ./codex-usage-decode
 * @purpose The codex \`rate_limits\` payloads this decoder is tested against - every one SLICED
 *   BYTE-FOR-BYTE out of a real ~/.codex/sessions rollout line, never composed by hand. Each RAW
 *   constant is the exact source substring (key order, \`0.0\` spelling and all); the exported fixture is
 *   JSON.parse of it, so no test can assert against a shape the vendor has not actually sent.
 *   GENERATED by scripts/extract-codex-captures.mjs - re-run it if a new vendor shape appears in the
 *   wild; do NOT hand-edit a payload, which would quietly turn a capture back into an imagination.
 *   THE LAW THIS SERVES: tests assert the OBSERVED, not the desired.
 */
import type { CodexRateLimits } from "./codex-usage-decode.js";

`;

const exportLines = CAPTURES.map(
  (c) => `export const ${c.id} = JSON.parse(${c.id}_RAW) as CodexRateLimits;`,
).join("\n");

const target = process.argv[2];
writeFileSync(target, `${header}${blocks.join("\n\n")}\n\n${exportLines}\n`, "utf8");
process.stdout.write(`wrote ${target} with ${String(CAPTURES.length)} captures\n`);
