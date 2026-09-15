#!/usr/bin/env node
// X0 fix-round gate (B-1 FIX): the tsc-BLIND entry-point folder `scripts/` (excluded from tsconfig's
// include) may NOT reference a capability field that was RETIRED from src. scripts consume src at runtime
// but tsc never type-checks them, so a deleted field (e.g. the X0 `chatMode` lane class) lingers silently and
// a dispatch runs ABSENT-GRANT (read-only review) semantics instead of what the script intended. This is the
// scripts-scope guard that closes that blind spot — the exact class the B-1 MAX review's BLOCK caught (a
// src-scoped grep + a tsc-excluded folder = a hole). Any RETIRED_FIELD token in scripts fails the build.
// Falsified at introduction: all five dispatch scripts carried `chatMode:` before this round's migration.
//
// Trade-off (stated): this is narrower than full type-checking of scripts (which would catch general script
// type drift, not just retired fields) — that is the correct FOLLOW-UP (a dedicated pass fixing the 3
// unrelated pre-existing scripts errors + a typecheck config), out of scope for a surgical fix round.
//
// B2a-a ride-along (P2 from the B-1 fix-confirm review): the scan now also covers .js/.mjs/.cjs — the
// earlier .ts/.mts/.tsx-only regex was narrower than the gate's own claim ("a retired src field lingers in a
// tsc-blind script"), and a plain-JS dispatch script would have slipped through. This gate's OWN definition
// file is self-excluded (it necessarily contains every RETIRED_FIELDS token in its rules, so scanning it
// would always self-fail) — the exclusion is by resolved path, robust to any future retired-field row.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SCRIPTS = path.join(ROOT, "scripts");
const SKIP_PARTS = new Set(["node_modules", "dist"]);
// This gate DEFINES the retired-field tokens, so it must never scan itself (excluded by resolved path).
const SELF = path.resolve(fileURLToPath(import.meta.url));

// Fields DELETED from src whose lingering use in a tsc-blind script runs stale/absent semantics. Add a row
// whenever a future capability field is retired from src — this gate is the living guard for that class.
const RETIRED_FIELDS = [
  {
    token: /\bchatMode\b/,
    why: "`chatMode` is the retired lane class (X0) — use an AgentGrant (grant: BUILD_GRANT/CHAT_GRANT/RESEARCH_GRANT, or dispatchModeToGrant(mode) for a DispatchMode)",
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_PARTS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(m|c)?[tj]sx?$/.test(name) && path.resolve(full) !== SELF) {
      // .ts/.mts/.cts/.tsx AND .js/.mjs/.cjs/.jsx — every runtime script class scripts/ can dispatch from.
      yield full;
    }
  }
}

const violations = [];
for (const file of walk(SCRIPTS)) {
  const rel = path.relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { token, why } of RETIRED_FIELDS) {
      if (token.test(lines[i])) {
        violations.push(`${rel}:${i + 1} — ${why}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "GATE scripts-scope: FAIL — a retired src field lingers in the tsc-blind scripts/ folder",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.error("GATE scripts-scope: PASS");
