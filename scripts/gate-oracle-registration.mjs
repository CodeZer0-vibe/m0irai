/**
 * @file scripts/gate-oracle-registration.mjs
 * @purpose Fail-closed oracle registration (plan v5 §5, Phase 7.6). `docs/provenance/oracle.json` owns the oracle's
 *   path, command, modes, proof list and SHA-256. This gate fails when the registration is absent, malformed, points
 *   at a missing file, or its hash no longer matches the oracle on disk — so an edited oracle must re-register in
 *   the same staged tree (`--update`), and a tree with no oracle can never look verified. Mandatory in `gates`,
 *   `release` and `ship:gate`.
 *   Beyond the hash it owns the CANONICAL RESULT SET (codex #18): `runProofs` names, per run configuration,
 *   exactly which proofs must execute. The gate checks the file against these constants and the oracle
 *   checks its own run against the file, so deleting a proof function can no longer leave every check green
 *   — the hash moves, the gate demands `--update`, and the run then reports the proof that never ran.
 * @exports checkOracleRegistration
 * @depends node:crypto, node:fs, node:path, node:url
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRATION = "docs/provenance/oracle.json";
const ORACLE = "scripts/oracle-standalone.mjs";
const MODES = ["hermetic", "release"];
const COMMAND =
  "node scripts/oracle-standalone.mjs [--mode hermetic|release] [--launcher <staged zer0-v2-host.mjs>] [--falsify schema|digest-entry]";
// Produced by EVERY run configuration: the no-writes watch list and the run-vs-registration comparison itself.
const ALWAYS = ["9.no-writes-outside-temp-root", "R.run-matches-registration"];
// The proofs a release run cannot make: it submits no turn, so there is nothing to digest and no canned
// extraction (see oracle-standalone runProofs / proveSessionA).
const HERMETIC_ONLY = [
  "BOOT.hermetic-probe-no-spawn",
  "H.hermetic-refusal",
  "4.digest-close-fact-and-watermark",
  "4b.replay-changes-nothing",
  "5.empty-extraction-watermark-only",
  "7b.explicit-shutdown-closes-once",
  "7b.stdin-eof-closes-once",
];
const RELEASE = [
  "1.initialize",
  "1.session/new",
  "1.session/list-contains-created",
  "2.canonical-project-identity",
  "2.chat_sessions-row",
  "3.schema-set",
  "6.session/load-continue",
  "7.explicit-shutdown-exit0",
  "7.stdin-eof-exit0",
  "8.wrong-cwd-invalid-params",
  ...ALWAYS,
];
// The exact proof set each run configuration must produce. A run that emits a different set is red.
const RUN_PROOFS = {
  hermetic: [...RELEASE, ...HERMETIC_ONLY].sort(),
  release: [...RELEASE].sort(),
  "falsify:schema": ["F.schema-falsifier(must-fail)", ...ALWAYS].sort(),
  "falsify:digest-entry": ["A6.digest-entry-falsifier(must-fail)", ...ALWAYS].sort(),
};
const PROOFS = [...new Set(Object.values(RUN_PROOFS).flat())].sort();

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Field-by-field equality against the constants above; the message names the field that drifted. */
function assertRegisteredShape(reg) {
  const fields = [
    ["modes", MODES],
    ["command", COMMAND],
    ["proofs", PROOFS],
    ["hermeticOnlyProofs", [...HERMETIC_ONLY].sort()],
    ["runProofs", RUN_PROOFS],
  ];
  for (const [key, want] of fields) {
    if (JSON.stringify(reg[key]) !== JSON.stringify(want))
      throw new Error(
        `GATE FAIL oracle-registration: ${key} drifted from the canonical set — registered ${JSON.stringify(reg[key])}, expected ${JSON.stringify(want)} (re-register with --update)`,
      );
  }
}

export function checkOracleRegistration(root = process.cwd(), { update = false } = {}) {
  const oraclePath = resolve(root, ORACLE);
  const regPath = resolve(root, REGISTRATION);
  if (!existsSync(oraclePath)) throw new Error(`oracle missing: ${ORACLE}`);
  const actual = sha256(oraclePath);
  if (update) {
    const reg = {
      path: ORACLE,
      sha256: actual,
      modes: MODES,
      command: COMMAND,
      proofs: PROOFS,
      hermeticOnlyProofs: [...HERMETIC_ONLY].sort(),
      runProofs: RUN_PROOFS,
    };
    writeFileSync(regPath, `${JSON.stringify(reg, null, 2)}\n`);
    return { ok: true, updated: true, sha256: actual };
  }
  if (!existsSync(regPath))
    throw new Error(`GATE FAIL oracle-registration: ${REGISTRATION} absent (fail closed)`);
  let reg;
  try {
    reg = JSON.parse(readFileSync(regPath, "utf8"));
  } catch (error) {
    throw new Error(`GATE FAIL oracle-registration: unreadable ${REGISTRATION}: ${String(error)}`);
  }
  if (reg.path !== ORACLE)
    throw new Error(
      `GATE FAIL oracle-registration: registered path ${String(reg.path)} != ${ORACLE}`,
    );
  if (typeof reg.sha256 !== "string" || reg.sha256 !== actual)
    throw new Error(
      `GATE FAIL oracle-registration: sha256 mismatch (registered ${String(reg.sha256).slice(0, 12)}…, on disk ${actual.slice(0, 12)}…) — re-register with --update in the same staged tree`,
    );
  const MIN_REGISTERED_PROOFS = 15; // measured 21 (h1 round 2, 2026-08-24); a registration below this lost proofs (FL-019)
  if (!Array.isArray(reg.proofs) || reg.proofs.length < MIN_REGISTERED_PROOFS)
    throw new Error("GATE FAIL oracle-registration: no proofs registered");
  assertRegisteredShape(reg);
  return { ok: true, sha256: actual, proofs: reg.proofs.length };
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const r = checkOracleRegistration(process.cwd(), { update: process.argv.includes("--update") });
    process.stdout.write(
      `oracle-registration ${r.updated ? "updated" : "gate passed"}: sha256 ${r.sha256.slice(0, 16)}…${r.proofs ? ` (${String(r.proofs)} proofs)` : ""}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
