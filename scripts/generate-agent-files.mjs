#!/usr/bin/env node
/**
 * @file scripts/generate-agent-files.mjs
 * @purpose Generate root agent instruction files from docs/agents/core.md plus per-agent appendices.
 * @exports generateAgentFiles, renderAgentFile
 * @depends node:crypto, node:fs, node:path, node:url
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = {
  claude: { appendix: "docs/agents/appendix.claude.md", target: "CLAUDE.md" },
  codex: { appendix: "docs/agents/appendix.codex.md", target: "AGENTS.md" },
  gemini: { appendix: "docs/agents/appendix.gemini.md", target: "GEMINI.md" },
};
const CORE = "docs/agents/core.md";

export function renderAgentFile(agent) {
  const spec = SOURCES[agent];
  if (!spec) throw new Error(`Unknown agent: ${agent}`);
  const core = readText(CORE);
  const appendix = readText(spec.appendix);
  const body = [`# ${agent.toUpperCase()} GENERATED STANDING FILE`, "", core, "", appendix].join(
    "\n",
  );
  const checksum = sha256(
    [CORE, spec.appendix].map((source) => `${source}\n${readText(source)}`).join("\n"),
  );
  return [
    "<!-- GENERATED FILE - DO NOT EDIT.",
    `     Source: ${CORE} + ${spec.appendix}`,
    `     Checksum: sha256:${checksum}`,
    "     Run: node scripts/generate-agent-files.mjs -->",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

export function generateAgentFiles({ check = false } = {}) {
  const drift = [];
  for (const agent of Object.keys(SOURCES)) {
    const spec = SOURCES[agent];
    const rendered = renderAgentFile(agent);
    const targetPath = path.join(ROOT, spec.target);
    if (check) {
      // Compare LINE-ENDING-NORMALIZED so a CRLF working-tree checkout (git autocrlf, no eol=lf
      // attribute) never reads as drift against the LF-rendered output — the fix for the class where the
      // SAME sources hashed/compared differently per checkout (gate green in one worktree, red in another).
      const current = toLf(readFileSync(targetPath, "utf8"));
      if (current !== rendered) drift.push(spec.target);
    } else {
      writeFileSync(targetPath, rendered, "utf8");
    }
  }
  return drift;
}

// Normalizes CRLF/CR to LF: the ONE seam that makes the checksum + the rendered body + the drift check
// deterministic across CRLF and LF checkouts (line endings are a checkout artifact, never content drift).
function toLf(text) {
  return text.replace(/\r\n?/gu, "\n");
}

function readText(relPath) {
  return toLf(readFileSync(path.join(ROOT, relPath), "utf8")).trimEnd();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const drift = generateAgentFiles({ check });
  if (drift.length > 0) {
    process.stderr.write(`Agent standing files drifted: ${drift.join(", ")}\n`);
    process.stderr.write("Run: node scripts/generate-agent-files.mjs\n");
    process.exit(1);
  }
  process.stdout.write(
    check
      ? "GATE PASS: agent standing files match generated sources\n"
      : "Generated agent standing files\n",
  );
}
