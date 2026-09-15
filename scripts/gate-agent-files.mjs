#!/usr/bin/env node
/**
 * @file scripts/gate-agent-files.mjs
 * @purpose Drift gate for generated root agent instruction files.
 * @exports (none)
 * @depends ./generate-agent-files.mjs
 */
import { generateAgentFiles } from "./generate-agent-files.mjs";

const drift = generateAgentFiles({ check: true });
if (drift.length > 0) {
  process.stderr.write(`GATE FAIL: generated agent files drifted: ${drift.join(", ")}\n`);
  process.stderr.write("Run: node scripts/generate-agent-files.mjs\n");
  process.exit(1);
}
process.stdout.write("GATE PASS: agent standing files match generated sources\n");
