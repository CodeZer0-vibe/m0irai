#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const INCLUDE_PREFIXES = ["src/", "docs/", "scripts/"];
const INCLUDE_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "ROUND_TABLE.md",
]);
const SKIP_PARTS = new Set(["node_modules", "dist", ".zer0", ".agent-ci", ".git", "coverage"]);
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const MAX_MATCHES_PER_FILE = 20;

const MARKERS = [
  ["multiply-encoded", /\u00c3[\u0192\u00c6][\s\S]{0,16}[\u00c2\u00e2\u20ac\u00a0-\u00bf]/u],
  ["utf8-as-latin1", /\u00c3[\u0080-\u00bf\u00a0-\u00bf\u0192\u00c6]/u],
  [
    "windows1252-punctuation",
    /\u00e2[\u0080-\u00bf\u00a8\u0152\u0153\u0178\u02c6-\u02dc\u2018-\u201e\u2020-\u2026\u2030\u2039\u203a\u20ac\u2122]/u,
  ],
  ["latin1-c2-prefix", /\u00c2[\u00a0-\u00bf]/u],
  [
    "utf8-emoji-as-windows1252",
    /\u00f0[\u0080-\u00bf\u0178][\u0080-\u00bf\u02c6-\u02dc\u2018-\u201e\u20ac]*/u,
  ],
];

function main() {
  const files = process.argv.length > 2 ? argFiles(process.argv.slice(2)) : trackedFiles();
  const violations = [];
  let checked = 0;

  for (const file of files) {
    if (!shouldScan(file)) continue;
    const buffer = readFileSync(file.abs);
    if (isBinary(buffer)) continue;
    checked += 1;
    scanText(file.display, buffer.toString("utf8"), violations);
  }

  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exit(1);
  }

  process.stdout.write(`GATE PASS: ${checked} files checked, no mojibake markers found\n`);
}

function argFiles(args) {
  return args.map((arg) => ({ abs: path.resolve(ROOT, arg), display: arg }));
}

function trackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return output
      .split("\0")
      .filter(Boolean)
      .map((rel) => ({ abs: path.join(ROOT, rel), display: rel.replaceAll("\\", "/") }));
  } catch {
    return walkedShippedFiles();
  }
}

function walkedShippedFiles() {
  const files = [];
  for (const prefix of INCLUDE_PREFIXES) {
    walk(path.join(ROOT, prefix), files);
  }
  for (const rel of INCLUDE_FILES) {
    files.push({ abs: path.join(ROOT, rel), display: rel });
  }
  return files.sort((a, b) => a.display.localeCompare(b.display));
}

function walk(dir, files) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).replaceAll("\\", "/");
    if (hasSkippedPart(rel)) continue;
    if (entry.isDirectory()) walk(abs, files);
    else if (entry.isFile()) files.push({ abs, display: rel });
  }
}

function shouldScan(file) {
  const rel = path.relative(ROOT, file.abs).replaceAll("\\", "/");
  if (!existsSync(file.abs) || !statSync(file.abs).isFile()) return false;
  if (hasSkippedPart(rel)) return false;
  if (process.argv.length > 2) return true;
  if (!isIncludedPath(rel)) return false;
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

function hasSkippedPart(rel) {
  return rel.split("/").some((part) => SKIP_PARTS.has(part));
}

function isIncludedPath(rel) {
  return INCLUDE_FILES.has(rel) || INCLUDE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function isBinary(buffer) {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x08 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

function scanText(display, text, violations) {
  const lines = text.split(/\r?\n/);
  let fileMatches = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = firstMarker(line);
    if (marker === null) continue;
    violations.push(`GATE FAIL: ${display}:${index + 1} mojibake marker (${marker})`);
    fileMatches += 1;
    if (fileMatches === MAX_MATCHES_PER_FILE) {
      violations.push(`GATE FAIL: ${display}:${index + 1} more mojibake markers omitted`);
      return;
    }
  }
}

function firstMarker(line) {
  for (const [name, pattern] of MARKERS) {
    if (pattern.test(line)) return name;
  }
  return null;
}

main();
