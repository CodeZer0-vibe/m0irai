/**
 * @file scripts/gate-patches.mjs
 * @purpose Fails gates when a managed patch's version, content, receipt, or installed bytes drift.
 * @exports validatePatchVersions
 * @depends node:path, node:url, ./patch-contracts, ./patch-lifecycle
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchVersionMismatches, readPatchContracts } from "./patch-contracts.mjs";
import { inspectPatchIntegrity } from "./patch-lifecycle.mjs";

export async function validatePatchVersions(root = process.cwd()) {
  const contracts = await readPatchContracts(root);
  const mismatches = patchVersionMismatches(contracts);
  if (mismatches.length > 0) throw new Error(mismatches.join("\n"));
  const integrity = await inspectPatchIntegrity(root);
  if (integrity.status !== "healthy") throw new Error(integrity.reason);
  return contracts.map(({ packageName, installedVersion, patchFile }) => ({
    packageName,
    packageVersion: installedVersion,
    patchFile,
  }));
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;

if (isMain) {
  validatePatchVersions(process.cwd())
    .then((contracts) => {
      process.stdout.write(`patch version gate passed (${String(contracts.length)} patches)\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
