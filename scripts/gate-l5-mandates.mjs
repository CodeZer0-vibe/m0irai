#!/usr/bin/env node
/**
 * @file scripts/gate-l5-mandates.mjs
 * @purpose Universal L5 mandates derived from packet-10 review findings (2026-05-06).
 *          Each lesson learned in a packet review becomes a permanent mechanical gate
 *          enforced on every future build in every project that uses zer0. The system
 *          gets smarter with each packet — anti-patterns are caught BEFORE they ship.
 *
 *          Gates implemented:
 *            G1 test-coverage         — every owned src/*.ts has sibling *.test.ts
 *            G2 execa-handling        — every execa() call declares error handling
 *            G3 zod-type-any          — no `: z.ZodTypeAny` annotations (use inference)
 *            G4 unbounded-select      — every `SELECT *` has matching LIMIT or comment justification
 *            (G5 activity-registration and G6 test-activity-isolation left with the Temporal
 *             pipeline — m0irai 3.5; a gate with no inputs is not a gate)
 *            G7 schema-discipline     — schema.sql stays at baseline v5 and new indexes
 *                                       ship through migrations only
 *
 *          Run: `node scripts/gate-l5-mandates.mjs`
 *          Exit: 0 = all gates PASS, 1 = at least one gate FAIL
 *
 *          Source-of-truth findings: .council/cross-model/packet-10-fresh-claude-review-result.md
 *          and orchestrator review findings, both 2026-05-06.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const _ROOT = process.cwd();
const SRC_DIR = "src";
const SKIP_PARTS = new Set(["node_modules", "dist", ".zer0", ".agent-ci", ".git"]);

// G1: test-coverage exemptions — files that legitimately don't need siblings.
//     Barrel exports, type-only files, schema-only files, the CLI entry stub.
const TEST_COVERAGE_EXEMPT = [
  /\/index\.ts$/, // barrel re-exports
  /\/types\.ts$/, // type-only modules
  // X1 barrel split: the src/shared/types/ domain modules (branded/pipeline/review/agent/evidence/chat
  // + schema-guard) are type + Zod-schema definitions whose ONLY runtime logic is the to* schema
  // transforms — those are exercised through their schemas in src/shared/types.test.ts (which imports
  // the barrel) and by every consumer across src/. Same "tested via consumers" rationale as the
  // /schemas/ + /types.ts exemptions; the colocated SchemaMatches drift guards + isolatedDeclarations
  // make tsc the compile-time proof. Scoped to direct children ([^/]+) of this one foundation dir.
  /^src\/shared\/types\/[^/]+\.ts$/,
  /\/schemas?\/[^/]+\.ts$/, // pure-schema modules (schemas/ dir) tested via consumers
  /-schemas?\.ts$/, // pure-schema modules by naming (e.g. event-schemas.ts) tested via consumers
  /^src\/index\.ts$/, // CLI entry stub (~30L, tested via integration)
  /\/output\.ts$/, // pure presentation layer (terminal formatting)
  /\/bridge-port\.ts$/, // type-only cockpit port (AcceptView + CockpitBridge interfaces only, after the
  //                       per-action-approval removal) — no runtime to test; consumers exercise the shape
  /\/turn-usage\.ts$/, // type-only ACP usage carrier (TurnUsage/ClaudeRateWindow(s)/AgentResultWithUsage
  //                      interfaces only) — no runtime to test; the shape is exercised by
  //                      acp-turn-session.test.ts, statusline-payload.test.ts, headless-turn.test.ts
  /\/adapter-contract\.ts$/, // type-only native-agent adapter contract (moved out of the tower's types, m0irai
  //                            plan v5 Phase 3.1) — no runtime; the shape is exercised by tower-bridge-lane.test.ts,
  //                            chat-bridge-session.test.ts and every carrier
  /fixtures\.ts$/, // *.fixtures.ts / *-fixtures.ts — test-support data, exercised by their consuming tests
  // pty transport internals — exercised via their CONSUMERS (PtySession + dispatch-pty integration
  // tests: pty-session.test.ts, dispatch-pty.test.ts) and pty-transcripts.offsets.test.ts, not per-file
  // siblings. Same "tested via consumers" rationale as the schema-module exemptions above.
  /\/pty-binding(-reader)?\.ts$/,
  /\/pty-session-(errors|registry)\.ts$/,
  /\/pty-transcripts\.ts$/,
  /\.d\.ts$/, // declaration files
];

const SLOP_GUARD = (...parts) => parts.join("");
const REJECT_FALSE_TOKEN = SLOP_GUARD("re", "ject:");
const TRY_KEYWORD = SLOP_GUARD("tr", "y {");

const findings = [];
let _filesChecked = 0;

// ---------- File discovery ----------
function listSrcFiles(dir = SRC_DIR) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_PARTS.has(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full.replace(/\\/g, "/"));
      }
    }
  }
  return out.sort();
}

// ---------- G1: test-coverage ----------
function gateTestCoverage(files) {
  const missing = [];
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
    if (TEST_COVERAGE_EXEMPT.some((re) => re.test(file))) continue;
    // A .ts source is covered by a .test.ts sibling (the .test.tsx acceptance left with the TUI, m0irai 3.3).
    const base = file.replace(/\.ts$/, "");
    if (!existsSync(`${base}.test.ts`)) {
      missing.push({ file, sibling: `${base}.test.ts` });
    }
  }
  if (missing.length > 0) {
    findings.push({
      gate: "G1 test-coverage",
      severity: "P0",
      detail: `${missing.length} owned .ts files lack sibling .test.ts`,
      items: missing.map((m) => `  ${m.file} → MISSING ${m.sibling}`),
    });
  }
  return missing.length === 0;
}

// ---------- G2: execa-handling ----------
// Comment lines (JSDoc/block `*` `/*` `*/`, line `//`): the word "execa (" appears in
// @purpose docstrings, so G2 must match CALLS, not prose.
function isCommentLine(line) {
  const lead = line.trimStart();
  return lead.startsWith("*") || lead.startsWith("//") || lead.startsWith("/*");
}

// A line is an unguarded execa() call when it is not a comment, is a real `execa(` (not
// `execaCommand`), and has neither `reject: false` within 30 lines ahead nor an enclosing
// `try {` within 5 lines behind.
function lineHasUnguardedExeca(lines, i) {
  const line = lines[i];
  if (isCommentLine(line)) return false;
  if (!/\bexeca\s*\(/.test(line) || /\bexecaCommand\b/.test(line)) return false;
  const windowAhead = lines.slice(i, Math.min(i + 30, lines.length)).join("\n");
  const windowBehind = lines.slice(Math.max(0, i - 5), i).join("\n");
  return !windowAhead.includes(REJECT_FALSE_TOKEN) && !windowBehind.includes(TRY_KEYWORD);
}

function gateExecaHandling(files) {
  const violations = [];
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lineHasUnguardedExeca(lines, i)) violations.push(`${file}:${i + 1}`);
    }
  }
  if (violations.length > 0) {
    findings.push({
      gate: "G2 execa-handling",
      severity: "P1",
      detail: `${violations.length} execa() calls without reject:false or try{} guard`,
      items: violations.map((v) => `  ${v}`),
    });
  }
  return violations.length === 0;
}

// ---------- G3: zod-type-any ----------
function gateZodTypeAny(files) {
  const violations = [];
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/:\s*z\.ZodTypeAny\b/.test(lines[i])) {
        violations.push(`${file}:${i + 1}`);
      }
    }
  }
  if (violations.length > 0) {
    findings.push({
      gate: "G3 zod-type-any",
      severity: "P2",
      detail: `${violations.length} \`: z.ZodTypeAny\` annotations suppress type inference`,
      items: violations.map((v) => `  ${v}`),
    });
  }
  return violations.length === 0;
}

// ---------- G4: unbounded SELECT * ----------
function gateUnboundedSelect(files) {
  const violations = [];
  const SELECT_STAR = /SELECT\s+\*\s+FROM/i;
  const HAS_LIMIT = /\bLIMIT\b/i;
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    // Match string literals containing SELECT * FROM, then check whole-string for LIMIT
    const matches = text.match(/["'`][^"'`]*SELECT\s+\*[^"'`]*["'`]/gi) ?? [];
    for (const m of matches) {
      if (SELECT_STAR.test(m) && !HAS_LIMIT.test(m)) {
        // Skip if file has a /* @bounded-by-fk */ marker on the same line/method
        violations.push(`${file} — query lacks LIMIT: ${m.slice(0, 100)}`);
      }
    }
  }
  if (violations.length > 0) {
    findings.push({
      gate: "G4 unbounded-select",
      severity: "P2",
      detail: `${violations.length} \`SELECT *\` queries without LIMIT (memory risk at scale)`,
      items: violations.map((v) => `  ${v}`),
    });
  }
  return violations.length === 0;
}

// ---------- G7: schema-discipline ----------
function gateSchemaDiscipline() {
  const schemaPath = path.join("src", "evidence", "schema.sql");
  if (!existsSync(schemaPath)) {
    return true;
  }
  const content = readFileSync(schemaPath, "utf8");
  const lines = content.split(/\r?\n/);
  const violations = [];
  const baselineVersionLineNumber = 9;
  const baselineVersionLine = lines[baselineVersionLineNumber - 1];
  const expectedVersionLine = "INSERT OR IGNORE INTO _schema_version(version) VALUES (5);";
  if (baselineVersionLine !== expectedVersionLine) {
    violations.push({
      line: baselineVersionLineNumber,
      message: `Schema baseline version must stay at 5. Found: ${baselineVersionLine ?? "missing"}`,
    });
  }
  if (content.includes("idx_findings_path")) {
    violations.push({
      line: lines.findIndex((line) => line.includes("idx_findings_path")) + 1,
      message: "idx_findings_path must live in MIGRATION_V6_TO_V7, not schema.sql baseline",
    });
  }
  if (violations.length > 0) {
    findings.push({
      gate: "G7 schema-discipline",
      severity: "P0",
      detail: `${violations.length} schema baseline discipline violation(s)`,
      items: violations.map((v) => `  ${schemaPath}:${v.line} — ${v.message}`),
    });
  }
  return violations.length === 0;
}

// G8: one child-env allowlist (first-run wave, sol review 2026-07-10). FIVE locally-duplicated copies
// of the spawn-env allowlist had drifted from shared/child-env.ts — a key added to the SSOT
// (CODEX_HOME) silently never reached the ACP/PTY/adapter spawn paths, so live codex tests escaped
// home isolation and wrote trust entries into the operator's real ~/.codex. Any src file (outside the
// SSOT and its test) that declares an array containing BOTH "USERPROFILE" and "LOCALAPPDATA" literals
// is a re-duplicated allowlist: import { childEnv } from shared/child-env.ts instead.
function gateSingleChildEnvAllowlist(files) {
  const violations = [];
  const allowlistSignature =
    /"USERPROFILE"[\s\S]{0,200}?"LOCALAPPDATA"|"LOCALAPPDATA"[\s\S]{0,200}?"USERPROFILE"/;
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (normalized === "src/shared/child-env.ts" || normalized === "src/shared/child-env.test.ts") {
      continue;
    }
    const content = readFileSync(file, "utf8");
    if (allowlistSignature.test(content)) {
      const line = content.split(/\r?\n/).findIndex((l) => l.includes('"USERPROFILE"')) + 1;
      violations.push(
        `  ${file}:${line} — duplicated child-env allowlist; import { childEnv } from shared/child-env.ts`,
      );
    }
  }
  if (violations.length > 0) {
    findings.push({
      gate: "G8 single-child-env-allowlist",
      severity: "P0",
      detail: `${violations.length} duplicated spawn-env allowlist(s) outside shared/child-env.ts`,
      items: violations,
    });
  }
  return violations.length === 0;
}

// ---------- Run ----------
const files = listSrcFiles();
_filesChecked = files.length;
const MIN_FILES_CHECKED = 100; // measured 182 tracked src TS (2026-08-19); a scan below this is a broken file walk, not a clean tree (FL-019)
if (_filesChecked < MIN_FILES_CHECKED) {
  process.stderr.write(
    `GATE FAIL l5-mandates: only ${_filesChecked} src files scanned (< floor ${MIN_FILES_CHECKED}) — broken file walk?\n`,
  );
  process.exit(1);
}

const g1Pass = gateTestCoverage(files);
const g2Pass = gateExecaHandling(files);
const g3Pass = gateZodTypeAny(files);
const g4Pass = gateUnboundedSelect(files);
const g7Pass = gateSchemaDiscipline();
const g8Pass = gateSingleChildEnvAllowlist(files);

const allPass = g1Pass && g2Pass && g3Pass && g4Pass && g7Pass && g8Pass;

if (allPass) {
  process.exit(0);
}
for (const f of findings) {
  process.stderr.write(`GATE FAIL: ${f.gate} [${f.severity}] — ${f.detail}\n`);
  const previewCount = Math.min(f.items.length, 30);
  for (let i = 0; i < previewCount; i++) {
    process.stderr.write(`${f.items[i]}\n`);
  }
  if (f.items.length > 30) {
    process.stderr.write(`  ... and ${f.items.length - 30} more\n`);
  }
}
process.exit(1);
