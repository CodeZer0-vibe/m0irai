/**
 * @file scripts/patch-lifecycle.mjs
 * @purpose Applies, receipts, verifies, and safely re-fits the product's installed dependency patches.
 * @exports inspectPatchIntegrity, autoRefitPatches, installPatches
 * @depends node:fs/promises, node:os, node:path, node:url, ./patch-contracts, ./patch-state,
 *   ./patch-write
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fingerprint,
  loadPatchRuntime,
  patchTargets,
  patchVersionMismatches,
  readPatchContracts,
  readPatchEffects,
  sha256File,
  unique,
} from "./patch-contracts.mjs";
import {
  RECEIPT_RELATIVE_PATH,
  assertRegularFileOrMissing,
  interruptedStateReason,
  recoverPendingRefit,
  recoverReceiptBackup,
  removeRefitJournal,
  restoreSnapshots,
  snapshotPatchReceipt,
  validatePatchStateDirectory,
  withPatchLock,
  writePatchReceiptFile,
  writeRefitJournal,
} from "./patch-state.mjs";
import { applyExpectedSnapshots, snapshotManagedPaths } from "./patch-write.mjs";

const RECEIPT_SCHEMA_VERSION = 1;

export async function inspectPatchIntegrity(root = process.cwd()) {
  return inspectPatchIntegrityInternal(root, false);
}

async function inspectPatchIntegrityInternal(root, allowPendingJournal) {
  const receiptPath = join(root, RECEIPT_RELATIVE_PATH);
  try {
    await validatePatchStateDirectory(root, false);
    await assertRegularFileOrMissing(receiptPath, "patch receipt");
    if (!allowPendingJournal) {
      const interrupted = await interruptedStateReason(root);
      if (interrupted !== undefined) return degraded(receiptPath, interrupted);
    }
    const contracts = await readPatchContracts(root);
    if (contracts.length === 0) return { status: "healthy", patches: 0, receiptPath };
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || !Array.isArray(receipt.patches)) {
      return degraded(receiptPath, "patch receipt schema is not supported");
    }
    const currentNames = contracts.map((contract) => contract.patchFile).sort();
    const receiptNames = receipt.patches.map((entry) => entry.patchFile).sort();
    if (JSON.stringify(currentNames) !== JSON.stringify(receiptNames)) {
      return degraded(receiptPath, "patch receipt does not cover the current patch set");
    }
    for (const contract of contracts) {
      const expected = receipt.patches.find((entry) => entry.patchFile === contract.patchFile);
      const mismatch = await receiptMismatch(root, contract, expected);
      if (mismatch !== undefined) return degraded(receiptPath, mismatch);
    }
    return {
      status: "healthy",
      patches: contracts.length,
      receiptPath,
      installed: contracts.map(({ packageName, installedVersion }) => ({
        packageName,
        installedVersion,
      })),
    };
  } catch (error) {
    return degraded(receiptPath, errorMessage(error));
  }
}

export async function autoRefitPatches(root = process.cwd(), hooks = {}) {
  const initial = await inspectPatchIntegrity(root);
  if (initial.status === "healthy") return initial;
  let contracts;
  try {
    contracts = await readPatchContracts(root);
  } catch (error) {
    return degraded(join(root, RECEIPT_RELATIVE_PATH), errorMessage(error));
  }
  try {
    return await withPatchLock(
      root,
      async (guard) => {
        await recoverReceiptBackup(root, guard);
        const recovered = await recoverPendingRefit(root, contracts, guard, hooks);
        const result = await refitUnderLock(root, contracts, initial, hooks, guard);
        if (recovered && result.status === "healthy") {
          return { ...result, status: "repaired", previousReason: initial.reason };
        }
        return result;
      },
      hooks,
    );
  } catch (error) {
    return degraded(join(root, RECEIPT_RELATIVE_PATH), errorMessage(error));
  }
}

async function refitUnderLock(root, contracts, initial, hooks, guard) {
  const afterLock = await inspectPatchIntegrity(root);
  if (afterLock.status === "healthy") return afterLock;
  const states = await Promise.all(contracts.map((contract) => classifyPatch(root, contract)));
  const incompatible = states.find((state) => state.state === "incompatible");
  if (incompatible !== undefined) {
    return degraded(
      join(root, RECEIPT_RELATIVE_PATH),
      `${incompatible.contract.patchFile} no longer applies cleanly: ${incompatible.reason}`,
    );
  }
  return applyRefit(root, contracts, states, initial, hooks, guard);
}

async function applyRefit(root, contracts, states, initial, hooks, guard) {
  const targetPaths = unique(
    states.flatMap((state) => state.targets.map((target) => join(root, target))),
  );
  const snapshots = await snapshotsWithExpectedOutput(
    root,
    contracts,
    states,
    unique(targetPaths),
    guard,
    hooks,
  );
  await writeRefitJournal(root, snapshots, guard, hooks);
  try {
    await hooks.beforeApply?.();
    await applyExpectedSnapshots(root, contracts, snapshots);
    await hooks.afterApply?.();
    for (const contract of contracts) await assertPatchApplied(root, contract);
    await writePatchReceipt(root, contracts, guard, hooks);
    const verified = await inspectPatchIntegrityInternal(root, true);
    if (verified.status !== "healthy") throw new Error(verified.reason);
    await removeRefitJournal(root, guard);
    return { ...verified, status: "repaired", previousReason: initial.reason };
  } catch (error) {
    return rollbackRefit(root, contracts, snapshots, error, hooks, guard);
  }
}

async function snapshotsWithExpectedOutput(root, contracts, states, targetPaths, guard, hooks) {
  await hooks.beforeSnapshotCapture?.();
  const dependencySnapshots = await snapshotManagedPaths(root, contracts, targetPaths);
  const receiptSnapshot = await snapshotPatchReceipt(root, guard);
  const stagingRoot = await mkdtemp(join(tmpdir(), "zer0-patch-expected-"));
  try {
    const stagedPaths = [];
    for (const snapshot of dependencySnapshots) {
      const stagedPath = join(stagingRoot, relative(root, snapshot.path));
      stagedPaths.push(stagedPath);
      await mkdir(dirname(stagedPath), { recursive: true });
      if (snapshot.existed) {
        await writeFile(stagedPath, snapshot.bytes);
        await chmod(stagedPath, snapshot.mode);
      }
    }
    applyUnappliedStatesToStaging(stagingRoot, states);
    const expected = await snapshotDisposablePaths(stagedPaths);
    return [
      ...dependencySnapshots.map((snapshot, index) => ({
        ...snapshot,
        expectedAfter: expected[index],
      })),
      receiptSnapshot,
    ];
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function snapshotDisposablePaths(paths) {
  return Promise.all(
    paths.map(async (path) => {
      const info = await stat(path);
      return { path, existed: true, bytes: await readFile(path), mode: info.mode };
    }),
  );
}

function applyUnappliedStatesToStaging(stagingRoot, states) {
  const { executeEffects } = loadPatchRuntime();
  for (const state of states) {
    if (state.state === "unapplied") {
      executeEffects(state.effects, { dryRun: false, cwd: stagingRoot, bestEffort: false });
    }
  }
}

async function rollbackRefit(root, contracts, snapshots, error, hooks, guard) {
  try {
    await validatePatchStateDirectory(root, false);
    await Promise.all(contracts.map((contract) => patchTargets(root, contract)));
    await hooks.beforeRollbackRestore?.();
    await restoreSnapshots(root, contracts, snapshots, guard);
    await removeRefitJournal(root, guard);
    return degraded(join(root, RECEIPT_RELATIVE_PATH), errorMessage(error));
  } catch (restoreError) {
    return degraded(
      join(root, RECEIPT_RELATIVE_PATH),
      `${errorMessage(error)}; rollback also failed: ${errorMessage(restoreError)}`,
    );
  }
}

export async function installPatches(root = process.cwd()) {
  const result = await withPatchLock(root, async (guard) => {
    await recoverReceiptBackup(root, guard);
    return installPatchesUnderLock(root, guard);
  });
  if (result.status === "degraded") throw new Error(result.reason);
  return result;
}

async function installPatchesUnderLock(root, guard) {
  const contracts = await readPatchContracts(root);
  await recoverPendingRefit(root, contracts, guard);
  const mismatches = patchVersionMismatches(contracts);
  if (mismatches.length > 0) throw new Error(mismatches.join("\n"));
  const initial = await inspectPatchIntegrityInternal(root, false);
  if (initial.status === "healthy") return initial;
  const states = await Promise.all(contracts.map((contract) => classifyPatch(root, contract)));
  const incompatible = states.find((state) => state.state === "incompatible");
  if (incompatible !== undefined) {
    throw new Error(
      `${incompatible.contract.patchFile} no longer applies cleanly: ${incompatible.reason}`,
    );
  }
  return applyRefit(root, contracts, states, initial, {}, guard);
}

async function receiptMismatch(root, contract, expected) {
  if (expected === undefined) return `${contract.patchFile} is missing from the patch receipt`;
  if (
    expected.packageName !== contract.packageName ||
    expected.declaredVersion !== contract.declaredVersion ||
    expected.installedVersion !== contract.installedVersion
  ) {
    return `${contract.patchFile} package versions do not match the patch receipt`;
  }
  if (expected.patchSha256 !== (await sha256File(contract.patchPath))) {
    return `${contract.patchFile} changed after the patch receipt was written`;
  }
  const targets = await patchTargets(root, contract);
  if (!Array.isArray(expected.targets) || expected.targets.length !== targets.length) {
    return `${contract.patchFile} target list does not match the patch receipt`;
  }
  for (const target of targets) {
    const received = expected.targets.find((entry) => entry.path === target);
    if (received === undefined) return `${target} is missing from the patch receipt`;
    const current = await fingerprint(join(root, target));
    if (received.exists !== current.exists || received.sha256 !== current.sha256) {
      return `${target} no longer matches its applied-patch receipt`;
    }
  }
  return undefined;
}

async function writePatchReceipt(root, contracts, guard, hooks) {
  const patches = [];
  for (const contract of contracts) {
    const targets = await patchTargets(root, contract);
    patches.push({
      patchFile: contract.patchFile,
      patchSha256: await sha256File(contract.patchPath),
      packageName: contract.packageName,
      declaredVersion: contract.declaredVersion,
      installedVersion: contract.installedVersion,
      targets: await Promise.all(
        targets.map(async (target) => ({
          path: target,
          ...(await fingerprint(join(root, target))),
        })),
      ),
    });
  }
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    patches,
  };
  const receiptPath = await writePatchReceiptFile(
    root,
    `${JSON.stringify(receipt, null, 2)}\n`,
    guard,
    hooks,
  );
  return { ...receipt, receiptPath };
}

async function classifyPatch(root, contract) {
  const { effects, targets } = await readPatchEffects(root, contract);
  const { executeEffects, reversePatch } = loadPatchRuntime();
  try {
    executeEffects(effects, { dryRun: true, cwd: root, bestEffort: false });
    return { contract, effects, targets, state: "unapplied" };
  } catch (forwardError) {
    try {
      executeEffects(reversePatch(effects), { dryRun: true, cwd: root, bestEffort: false });
      return { contract, effects, targets, state: "applied" };
    } catch {
      return {
        contract,
        effects,
        targets,
        state: "incompatible",
        reason: errorMessage(forwardError).split("\n")[0],
      };
    }
  }
}

async function assertPatchApplied(root, contract) {
  const state = await classifyPatch(root, contract);
  if (state.state !== "applied") {
    throw new Error(`${contract.patchFile} was not applied exactly`);
  }
}

function degraded(receiptPath, reason) {
  return { status: "degraded", reason, receiptPath };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const command = process.argv[2];
  if (command === "install") {
    const result = await installPatches(process.cwd());
    process.stdout.write(`zer0 patch receipt verified (${String(result.patches)} patches)\n`);
    return;
  }
  if (command === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspectPatchIntegrity(process.cwd()))}\n`);
    return;
  }
  if (command === "refit") {
    process.stdout.write(`${JSON.stringify(await autoRefitPatches(process.cwd()))}\n`);
    return;
  }
  throw new Error("usage: node scripts/patch-lifecycle.mjs <install|inspect|refit>");
}

if (sameExecutablePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

function sameExecutablePath(left, right) {
  if (left === undefined) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
