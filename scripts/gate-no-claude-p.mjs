#!/usr/bin/env node
// W1-T0 gate: no product code path may spawn `claude -p` (policy guard; product paths avoid it).
// Two layers:
//   1. SCAN — no file outside the quarantine may contain a quoted "-p"/"--print" literal AND a
//      claude reference (a new metered call site).
//   2. TRIPWIRES — the two reachability guards must keep existing verbatim; deleting either one
//      silently re-opens a billing path. (The third, the tower claude lane's ZER0_ALLOW_CLAUDE_P
//      override in agent-bins, left with the tower — m0irai 3.6.)
// Falsified at introduction (planted violation caught at file:line) per the falsifying-test rule.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const SKIP_PARTS = new Set(["node_modules", "dist", ".zer0", ".agent-ci"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// Quarantine: the retired adapter body. Its `-p` literals are unreachable (RETIRED, fail-loud);
// everything else is a violation.
const QUARANTINE = [/src[\\/]adapters[\\/]claude\.ts$/];
// Straight-quoted argument literals ONLY: backticked `-p` is prose (comments/docs), and flags
// like gemini's own PROMPT_FLAG or `git log -p` are cleared by the claude-adjacency window —
// a violation is a quoted -p/--print within ±CONTEXT_LINES of a claude reference (arg arrays
// span lines: execa("claude", [..., "-p"])). Falsified 2026-06-12: the naive file-wide predicate
// flagged gemini's own flag, git log -p, and this gate's own retirement comment.
const P_LITERAL = /["'](?:-p|--print)["']/;
const CLAUDE_REF = /claude/i;
const CONTEXT_LINES = 4;

const TRIPWIRES = [
  {
    file: "src/chat/dispatch-headless.ts",
    pattern: /input\.agent === "claude"[\s\S]{0,80}dispatchPty/,
    why: "chat claude must route to the interactive pty unconditionally",
  },
  {
    file: "src/adapters/registry.ts",
    pattern: /RETIRED-2026-06-15[\s\S]*claude: retiredClaude/,
    why: "registry claude dispatcher must stay retired (fail-loud)",
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_PARTS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

const violations = [];

for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file);
  if (TEST_FILE.test(rel)) continue;
  if (QUARANTINE.some((q) => q.test(file))) continue;
  const text = readFileSync(file, "utf8");
  if (!CLAUDE_REF.test(text)) continue;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!P_LITERAL.test(lines[i])) continue;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(lines.length, i + CONTEXT_LINES + 1);
    if (CLAUDE_REF.test(lines.slice(from, to).join("\n"))) {
      violations.push(`${rel}:${i + 1} — quoted -p/--print literal adjacent to a claude reference`);
    }
  }
}

for (const trip of TRIPWIRES) {
  const full = path.join(ROOT, trip.file);
  let text = "";
  try {
    text = readFileSync(full, "utf8");
  } catch {
    violations.push(`${trip.file} — MISSING (tripwire file deleted): ${trip.why}`);
    continue;
  }
  if (!trip.pattern.test(text)) {
    violations.push(`${trip.file} — tripwire guard absent: ${trip.why}`);
  }
}

if (violations.length > 0) {
  console.error("GATE no-claude-p: FAIL");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "  `claude -p` is blocked by policy for product paths. Product paths use the interactive pty;" +
      " reviews use the dispatch.sh tooling lane.",
  );
  process.exit(1);
}
console.error("GATE no-claude-p: PASS");
