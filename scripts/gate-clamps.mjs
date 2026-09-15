#!/usr/bin/env node
// Per docs/SPEC.md §9 BUILD_CLAMPS.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const INCLUDE_DIRS = ["src", "tests"];
const SKIP_PARTS = new Set(["node_modules", "dist", ".zer0", ".agent-ci"]);
const SKIP_PREFIXES = [".council/logs"];
const MAX_FILE_LINES = 500;
const HARD_CEILING_FILE_LINES = 600;
const SIZE_JUSTIFICATION_TOKEN = "@size-justified";
const SIZE_JUSTIFICATION_MIN_CHARS = 20;
const MAX_FUNCTION_LINES = 50;
const MAX_PARAMETERS = 5;
const FILE_HEADER_REQUIRED_TAGS = ["@file", "@purpose", "@exports", "@depends"];
const FILE_HEADER_SCAN_LINES = 10;
const FILE_HEADER_EXEMPT_PATTERNS = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /(?:^|\/)tests\//,
  /(?:^|\/)src\/index\.ts$/,
];
const ARROW_ASSIGNMENT_RE = new RegExp(
  "^(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*" +
    "(?::[^=]+)?=\\s*(?:async\\s*)?\\($",
);
const METHOD_RE = new RegExp(
  "^(?:(?:public|private|protected|static|async|override|readonly)\\s+)*" +
    "(?:get\\s+|set\\s+)?[A-Za-z_$][\\w$]*\\s*(?:<[^>]+>)?\\s*\\(",
);
const SLOP_TOKENS = [
  ["TO", "DO"].join(""),
  ["FIX", "ME"].join(""),
  "XXX",
  "HACK",
  ["place", "holder"].join(""),
  ["skele", "ton"].join(""),
  ["mock", "implementation"].join(" "),
  ["as", "any"].join(" "),
  ["as", "unknown", "as"].join(" "),
];

function main() {
  const files = collectTypeScriptFiles();
  const violations = [];
  let totalLines = 0;

  for (const file of files) {
    const rel = toRelative(file);
    const lines = readLines(file);
    totalLines += lines.length;
    checkFileLength(rel, lines, violations);
    checkSlopTokens(rel, lines, violations);
    checkFunctions(rel, lines, violations);
    checkFileHeader(rel, lines, violations);
  }

  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exit(1);
  }

  const MIN_FILES_CHECKED = 300; // measured 425 (2026-08-19); a scan below this is a broken file walk, not a clean tree (FL-019)
  if (files.length < MIN_FILES_CHECKED) {
    process.stderr.write(
      `GATE FAIL clamps: only ${files.length} files scanned (< floor ${MIN_FILES_CHECKED}) — broken file walk?\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `GATE PASS: ${files.length} files checked, ${totalLines} lines, no violations\n`,
  );
}

function collectTypeScriptFiles() {
  const files = [];
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (existsSync(abs)) {
      walk(abs, files);
    }
  }
  return files.sort((a, b) => toRelative(a).localeCompare(toRelative(b)));
}

function walk(dir, files) {
  if (shouldSkip(dir)) {
    return;
  }

  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walk(abs, files);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      files.push(abs);
    }
  }
}

function shouldSkip(abs) {
  const rel = toRelative(abs);
  const parts = rel.split("/");
  return (
    parts.some((part) => SKIP_PARTS.has(part)) ||
    SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))
  );
}

function readLines(file) {
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function checkFileLength(rel, lines, violations) {
  if (lines.length <= MAX_FILE_LINES) {
    return;
  }
  if (lines.length > HARD_CEILING_FILE_LINES) {
    violations.push(
      `GATE FAIL: ${rel}:1 file has ${lines.length} lines, hard ceiling is ${HARD_CEILING_FILE_LINES} (no escape hatch above hard ceiling — split the file)`,
    );
    return;
  }
  const head = lines.slice(0, FILE_HEADER_SCAN_LINES).join("\n");
  const justificationMatch = head.match(/@size-justified[:\s]+([^\r\n*]+)/);
  const justificationText = (justificationMatch?.[1] ?? "").trim();
  if (justificationText.length < SIZE_JUSTIFICATION_MIN_CHARS) {
    violations.push(
      `GATE FAIL: ${rel}:1 file has ${lines.length} lines, target is ${MAX_FILE_LINES} (add "${SIZE_JUSTIFICATION_TOKEN}: <reason>" with at least ${SIZE_JUSTIFICATION_MIN_CHARS} chars of explanation in file header to override up to ${HARD_CEILING_FILE_LINES}, or split the file)`,
    );
  }
}

function checkSlopTokens(rel, lines, violations) {
  for (const [index, line] of lines.entries()) {
    for (const token of SLOP_TOKENS) {
      if (line.includes(token)) {
        violations.push(`GATE FAIL: ${rel}:${index + 1} slop token "${token}" found`);
      }
    }
  }
}

function checkFunctions(rel, lines, violations) {
  let classDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const inClass = classDepth > 0 || /\bclass\s+[A-Za-z_$][\w$]*/.test(line);

    if (isFunctionStart(line, inClass)) {
      const signature = collectSignature(lines, index);
      const parameterCount = countParameters(signature);
      const functionLines = countFunctionLines(lines, index);
      pushFunctionViolations(rel, index + 1, parameterCount, functionLines, violations);
    }

    classDepth = updateClassDepth(classDepth, line);
  }
}

function isFunctionStart(line, inClass) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return false;
  }
  return isFunctionDeclaration(trimmed) || isArrowStart(trimmed) || isMethodStart(trimmed, inClass);
}

function isFunctionDeclaration(trimmed) {
  return /\b(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/.test(trimmed);
}

function isArrowStart(trimmed) {
  if (trimmed.includes("=>")) {
    return true;
  }
  return ARROW_ASSIGNMENT_RE.test(trimmed);
}

function isMethodStart(trimmed, inClass) {
  if (!inClass || /^(if|for|while|switch|catch|return)\b/.test(trimmed)) {
    return false;
  }
  return METHOD_RE.test(trimmed);
}

function collectSignature(lines, startIndex) {
  const parts = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 20); index += 1) {
    const line = lines[index] ?? "";
    parts.push(line.trim());
    if (line.includes("{") || line.includes("=>")) {
      break;
    }
  }
  return parts.join(" ");
}

function countParameters(signature) {
  const arrowIndex = signature.indexOf("=>");
  if (!signature.includes("(") && arrowIndex > -1) {
    return countSingleArrowParameter(signature.slice(0, arrowIndex));
  }

  const start = signature.indexOf("(");
  const end = findClosingParen(signature, start);
  if (start < 0 || end <= start) {
    return 0;
  }

  return splitTopLevel(signature.slice(start + 1, end)).filter(Boolean).length;
}

function countSingleArrowParameter(prefix) {
  const candidate =
    prefix
      .split("=")
      .at(-1)
      ?.trim()
      .replace(/^async\s+/, "") ?? "";
  return /^[A-Za-z_$][\w$]*$/.test(candidate) ? 1 : 0;
}

function findClosingParen(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";

  for (const char of text) {
    depth += char === "(" || char === "{" || char === "[" || char === "<" ? 1 : 0;
    depth -= char === ")" || char === "}" || char === "]" || char === ">" ? 1 : 0;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  parts.push(current.trim());
  return parts;
}

function countFunctionLines(lines, startIndex) {
  let depth = 0;
  let sawBlock = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const delta = countBraceDelta(lines[index] ?? "");
    depth += delta;
    sawBlock = sawBlock || delta > 0;
    if (!sawBlock && (lines[index] ?? "").includes("=>")) {
      return 1;
    }
    if (sawBlock && depth <= 0) {
      return index - startIndex + 1;
    }
  }

  return lines.length - startIndex;
}

function countBraceDelta(line) {
  let delta = 0;
  for (const char of line) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function pushFunctionViolations(rel, line, parameterCount, functionLines, violations) {
  if (functionLines > MAX_FUNCTION_LINES) {
    violations.push(
      `GATE FAIL: ${rel}:${line} function has ${functionLines} lines, max is ${MAX_FUNCTION_LINES}`,
    );
  }
  if (parameterCount > MAX_PARAMETERS) {
    violations.push(
      `GATE FAIL: ${rel}:${line} function has ${parameterCount} parameters, ` +
        `max is ${MAX_PARAMETERS}`,
    );
  }
}

function updateClassDepth(classDepth, line) {
  if (classDepth > 0 || /\bclass\s+[A-Za-z_$][\w$]*/.test(line)) {
    return Math.max(0, classDepth + countBraceDelta(line));
  }
  return classDepth;
}

function toRelative(abs) {
  return path.relative(ROOT, abs).replaceAll("\\", "/");
}

function checkFileHeader(rel, lines, violations) {
  if (FILE_HEADER_EXEMPT_PATTERNS.some((re) => re.test(rel))) {
    return;
  }
  const head = lines.slice(0, FILE_HEADER_SCAN_LINES).join("\n");
  for (const tag of FILE_HEADER_REQUIRED_TAGS) {
    if (!head.includes(tag)) {
      violations.push(
        `GATE FAIL: ${rel}:1 file header missing required tag "${tag}" (first ${FILE_HEADER_SCAN_LINES} lines must include @file/@purpose/@exports/@depends; see .council/templates/BUILD-BRIEF-TEMPLATE.md "FILE-HEADER CONTRACT")`,
      );
    }
  }
  if (rel.endsWith(".mjs") || rel.endsWith(".cjs") || rel.endsWith(".js")) {
    return;
  }
  const content = lines.join("\n");
  checkExportDrift(rel, head, content, violations);
  checkDependsDrift(rel, head, content, violations);
}

function checkExportDrift(rel, head, content, violations) {
  const declared = parseTagValues(head, "@exports");
  if (declared.length === 0) {
    return;
  }
  const actual = collectActualExports(content);
  for (const name of declared) {
    if (!actual.has(name)) {
      violations.push(
        `GATE FAIL: ${rel}:1 file header @exports declares "${name}" but no \`export ... ${name}\` declaration found in the file (semantic drift — header lies; codex infra-review I-3)`,
      );
    }
  }
}

function checkDependsDrift(rel, head, content, violations) {
  const declared = parseTagValues(head, "@depends");
  if (declared.length === 0) {
    return;
  }
  const actualImportPaths = collectActualImportPaths(content);
  for (const dep of declared) {
    if (!isDeclaredDepPresent(dep, actualImportPaths)) {
      violations.push(
        `GATE FAIL: ${rel}:1 file header @depends declares "${dep}" but no matching \`import ... from\` found in the file (semantic drift — header lies; codex infra-review I-3)`,
      );
    }
  }
}

function parseTagValues(head, tag) {
  const match = head.match(new RegExp(`${tag}\\s+([^\\r\\n]+)`));
  if (!match) {
    return [];
  }
  const raw = match[1] ?? "";
  if (/\(\s*none\b/i.test(raw)) {
    return [];
  }
  return raw
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\s*\([^)]*\)\s*/g, "")
        .trim(),
    )
    .filter((part) => part.length > 0 && /^[A-Za-z_@./*][\w@./*:-]*$/.test(part));
}

function collectActualExports(content) {
  const exports = new Set();
  const declRe =
    /\bexport\s+(?:async\s+)?(?:default\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g;
  for (const match of content.matchAll(declRe)) {
    if (match[1]) {
      exports.add(match[1]);
    }
  }
  // Matches BOTH `export { X }` and `export type { X }` (isolatedModules' required form for a
  // pure-type re-export — TS1205 otherwise; e.g. `export type { Foo } from "./bar.js"`).
  const reExportRe = /\bexport\s*(?:type\s+)?\{([^}]+)\}/g;
  for (const match of content.matchAll(reExportRe)) {
    for (const item of (match[1] ?? "").split(",")) {
      const name = item
        .trim()
        .split(/\s+as\s+/)
        .pop()
        // Strips a PER-SPECIFIER `type` modifier too (`export { type Foo }`) — the other
        // isolatedModules-valid form, used when a brace list mixes types and values.
        ?.trim()
        .replace(/^type\s+/, "");
      if (name) {
        exports.add(name);
      }
    }
  }
  return exports;
}

function collectActualImportPaths(content) {
  const paths = new Set();
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(fromRe)) {
    if (match[1]) {
      paths.add(match[1]);
    }
  }
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(sideEffectRe)) {
    if (match[1]) {
      paths.add(match[1]);
    }
  }
  return paths;
}

function isDeclaredDepPresent(declared, actualPaths) {
  if (declared.endsWith("/*") || declared.endsWith(":*")) {
    const stem = declared.slice(0, -2);
    for (const actual of actualPaths) {
      if (actual.startsWith(stem)) {
        return true;
      }
    }
    return false;
  }
  for (const actual of actualPaths) {
    if (matchesDeclaredDep(declared, actual)) {
      return true;
    }
  }
  return false;
}

function matchesDeclaredDep(declared, actual) {
  if (actual === declared) {
    return true;
  }
  if (declared.startsWith("@") && (actual === declared || actual.startsWith(`${declared}/`))) {
    return true;
  }
  if (declared.startsWith("node:") && actual === declared) {
    return true;
  }
  const declaredTail = declared.replace(/\.(js|cjs|mjs|ts)$/, "").replace(/\/+$/, "");
  const actualNorm = actual.replace(/\.(js|cjs|mjs|ts)$/, "").replace(/\/index$/, "");
  if (actualNorm === declaredTail) {
    return true;
  }
  if (declaredTail.includes("/") && actualNorm.endsWith(declaredTail.replace(/^src\//, "/"))) {
    return true;
  }
  const declaredBase = declaredTail.replace(/^.*\//, "");
  const actualBase = actualNorm.replace(/^.*\//, "");
  if (declaredBase.length > 0 && declaredBase === actualBase) {
    return true;
  }
  return false;
}

main();
