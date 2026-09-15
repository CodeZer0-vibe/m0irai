/**
 * @file tests/setup/real-store-guard.ts
 * @purpose W4-R3a C1/RA-4: vitest globalSetup that fingerprints this checkout's REAL durable stores
 *   before the fork pool spawns and asserts they are UNCHANGED after the run. Origin (measured, not
 *   theorised): at base commit c1cbdb1 one `npm test` inserted 109 rows into the operator's dogfood
 *   `.zer0/evidence.db`, which had accumulated 14,434 junk `chat_sessions` rows this way — every one
 *   from a test whose OWN db was correctly isolated, defeated by product code that re-derived the DB
 *   target from ambient cwd-relative config (session-store.ts's `loadConfig()`), the same
 *   identity-by-spelling defect as the ledger leak this round kills.
 *   Does NOT clean the already-contaminated store: that is a separate operator-approved action. This
 *   only stops the bleeding and makes any recurrence a RED run instead of a silent 4-page growth.
 * @exports default (vitest globalSetup)
 * @depends node:fs, node:path, node:process, ./real-store-fingerprint
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describeFingerprintDrift, fingerprintRealStore } from "./real-store-fingerprint.js";

const DEFAULT_DB_PATH: string = ".zer0/evidence.db";
const CONFIG_PATH: string = ".zer0/config.yaml";
const DB_PATH_LINE: RegExp = /^\s*dbPath:\s*["']?([^"'\r\n]+)["']?\s*$/m;
const SKIP_ENV: string = "ZER0_ALLOW_REAL_STORE_WRITES";

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env[SKIP_ENV] === "1") {
    return async () => undefined; // explicit operator escape (a deliberate dogfood-writing run)
  }
  const repoRoot = process.cwd();
  const dbPath = resolveRealDbPath(repoRoot);
  const before = fingerprintRealStore(repoRoot, dbPath);
  return async () => {
    const after = fingerprintRealStore(repoRoot, dbPath);
    const drift = describeFingerprintDrift(before, after);
    if (drift.length > 0) {
      throw new Error(failureMessage(repoRoot, dbPath, drift));
    }
  };
}

// Deliberately env-INDEPENDENT: it must name the store a bare `loadConfig()` would reach from this
// checkout, NOT the per-worker ZER0_DB_PATH redirect the suite installs (that is the thing being
// verified). Reads config.yaml's own dbPath when the checkout has one, else the shipped default.
function resolveRealDbPath(repoRoot: string): string {
  const configFile = path.join(repoRoot, CONFIG_PATH);
  if (!existsSync(configFile)) {
    return DEFAULT_DB_PATH;
  }
  try {
    return DB_PATH_LINE.exec(readFileSync(configFile, "utf8"))?.[1] ?? DEFAULT_DB_PATH;
  } catch {
    return DEFAULT_DB_PATH;
  }
}

function failureMessage(repoRoot: string, dbPath: string, drift: readonly string[]): string {
  return [
    "",
    "REAL-STORE GUARD TRIPPED — this test run WROTE to the checkout's real durable store.",
    `  checkout: ${repoRoot}`,
    `  db:       ${dbPath}`,
    ...drift.map((line) => `  changed   ${line}`),
    "",
    "  A test must never touch the real evidence DB, blob store, or .council/runs. The usual cause is",
    "  product code re-deriving its store from ambient cwd-relative config instead of the identity the",
    "  caller passed (session-store.ts's loadConfig() was exactly this). Find the writer; do not widen",
    "  the guard. If the operator genuinely intends a dogfood-writing run, set ZER0_ALLOW_REAL_STORE_WRITES=1.",
    "  (A concurrently running `zer0 chat` on this same checkout also trips this — check before hunting.)",
    "",
  ].join("\n");
}
