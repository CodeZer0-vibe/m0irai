/**
 * @file scripts/patch-state.mjs
 * @purpose Owns contained patch state, durable refit journals, receipt replacement, and locks.
 * @exports RECEIPT_RELATIVE_PATH, assertRegularFileOrMissing, interruptedStateReason,
 *   recoverPendingRefit, recoverReceiptBackup, removeRefitJournal, restoreSnapshots,
 *   snapshotPatchReceipt, validatePatchStateDirectory, withPatchLock, writePatchReceiptFile,
 *   writeRefitJournal
 * @depends node:crypto, node:fs/promises, node:path, node:timers/promises, ./patch-contracts,
 *   ./patch-state-files, ./patch-write
 */
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { patchTargets, unique } from "./patch-contracts.mjs";
import {
  assertPatchStateFileOrMissing,
  assertPatchStateGuard,
  closePatchStateGuard,
  createPatchStateGuard,
  patchStateFileExists,
  readPatchStateFile,
  readPatchStateFileWithInfo,
  removePatchStateFile,
  removePatchStateFileIfBytes,
  renamePatchStateFile,
  validatePatchStateDirectory,
  writeExistingPatchStateFile,
  writeNewPatchStateFile,
} from "./patch-state-files.mjs";
import { restoreExpectedSnapshots } from "./patch-write.mjs";

export { validatePatchStateDirectory };

const JOURNAL_SCHEMA_VERSION = 1;
export const RECEIPT_RELATIVE_PATH = join("node_modules", ".zer0", "patches-applied.json");
const RECEIPT_BACKUP_RELATIVE_PATH = join("node_modules", ".zer0", "patches-applied.previous.json");
const LOCK_RELATIVE_PATH = join("node_modules", ".zer0", "patches.lock");
const LOCK_RECOVERY_RELATIVE_PATH = join("node_modules", ".zer0", "patches.lock.recovery");
const JOURNAL_RELATIVE_PATH = join("node_modules", ".zer0", "patch-refit-journal.json");
const LOCK_STALE_MS = 30_000;

export async function snapshotPatchReceipt(root, guard) {
  const path = join(root, RECEIPT_RELATIVE_PATH);
  try {
    const { bytes, mode } = await readPatchStateFileWithInfo(guard, path, "patch receipt");
    return { path, existed: true, bytes, mode };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path, existed: false };
    throw error;
  }
}

export async function writeRefitJournal(root, snapshots, guard, hooks = {}) {
  await assertPatchStateGuard(guard);
  const journalPath = join(root, JOURNAL_RELATIVE_PATH);
  await assertPatchStateFileOrMissing(guard, journalPath, "patch refit journal");
  if (await patchStateFileExists(guard, journalPath, "patch refit journal")) {
    throw new Error("an unfinished patch repair remains");
  }
  const entries = snapshots.map((snapshot) => ({
    path: snapshotRelativePath(root, snapshot.path),
    existed: snapshot.existed,
    ...(snapshot.existed
      ? { bytesBase64: snapshot.bytes.toString("base64"), mode: snapshot.mode }
      : {}),
    ...(snapshot.expectedAfter === undefined
      ? {}
      : { expectedAfter: serializeSnapshotImage(snapshot.expectedAfter) }),
  }));
  const journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId: randomUUID(),
    createdAt: new Date().toISOString(),
    snapshots: entries,
  };
  const temporary = `${journalPath}.${randomUUID()}.tmp`;
  await hooks.beforeJournalWrite?.();
  await assertPatchStateGuard(guard);
  await writeNewPatchStateFile(
    guard,
    temporary,
    `${JSON.stringify(journal, null, 2)}\n`,
    "patch refit journal temporary",
  );
  try {
    await renamePatchStateFile(guard, temporary, journalPath, "patch refit journal temporary");
  } finally {
    await removePatchStateFile(guard, temporary, "patch refit journal temporary", true);
  }
}

export async function recoverPendingRefit(root, contracts, guard, hooks = {}) {
  const journalPath = join(root, JOURNAL_RELATIVE_PATH);
  await assertPatchStateFileOrMissing(guard, journalPath, "patch refit journal");
  if (!(await patchStateFileExists(guard, journalPath, "patch refit journal"))) return false;
  const parsed = JSON.parse(
    await readPatchStateFile(guard, journalPath, "patch refit journal", "utf8"),
  );
  const allowed = new Set(await expectedSnapshotPaths(root, contracts));
  const snapshots = parseJournalSnapshots(root, parsed, allowed);
  await hooks.beforeRecoveryRestore?.();
  await restoreSnapshots(root, contracts, snapshots, guard);
  await verifySnapshots(snapshots);
  await removePatchStateFile(guard, journalPath, "patch refit journal");
  return true;
}

export async function restoreSnapshots(root, contracts, snapshots, guard) {
  await restoreExpectedSnapshots(root, contracts, snapshots);
  const receiptPath = resolve(root, RECEIPT_RELATIVE_PATH);
  const receipts = snapshots.filter((snapshot) => resolve(snapshot.path) === receiptPath);
  if (receipts.length !== 1) throw new Error("patch transaction must contain one receipt snapshot");
  await restoreReceiptSnapshot(guard, receipts[0]);
}

async function restoreReceiptSnapshot(guard, snapshot) {
  await assertPatchStateFileOrMissing(guard, snapshot.path, "patch receipt");
  if (!snapshot.existed) {
    await removePatchStateFile(guard, snapshot.path, "patch receipt", true);
    return;
  }
  await writeExistingPatchStateFile(
    guard,
    snapshot.path,
    snapshot.bytes,
    snapshot.mode,
    "patch receipt",
  );
}

export async function removeRefitJournal(root, guard) {
  await removePatchStateFile(guard, join(root, JOURNAL_RELATIVE_PATH), "patch refit journal");
}

export async function writePatchReceiptFile(root, content, guard, hooks = {}) {
  await assertPatchStateGuard(guard);
  const receiptPath = join(root, RECEIPT_RELATIVE_PATH);
  const backupPath = join(root, RECEIPT_BACKUP_RELATIVE_PATH);
  await assertPatchStateFileOrMissing(guard, receiptPath, "patch receipt");
  await assertPatchStateFileOrMissing(guard, backupPath, "patch receipt backup");
  if (await patchStateFileExists(guard, backupPath, "patch receipt backup")) {
    throw new Error("an interrupted patch receipt update remains");
  }
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  await hooks.beforeReceiptWrite?.();
  await assertPatchStateGuard(guard);
  await writeNewPatchStateFile(guard, temporary, content, "patch receipt temporary");
  try {
    if (await patchStateFileExists(guard, receiptPath, "patch receipt")) {
      await renamePatchStateFile(guard, receiptPath, backupPath, "patch receipt");
    }
    await renamePatchStateFile(guard, temporary, receiptPath, "patch receipt temporary");
    await removePatchStateFile(guard, backupPath, "patch receipt backup", true);
  } finally {
    await removePatchStateFile(guard, temporary, "patch receipt temporary", true);
  }
  return receiptPath;
}

export async function withPatchLock(root, operation, hooks = {}) {
  const guard = await createPatchStateGuard(root, true, hooks);
  const lockPath = join(root, LOCK_RELATIVE_PATH);
  const recoveryPath = join(root, LOCK_RECOVERY_RELATIVE_PATH);
  try {
    const owner = await acquirePatchLock(guard, lockPath, recoveryPath, hooks);
    if (owner === undefined) {
      return degraded(join(root, RECEIPT_RELATIVE_PATH), "patch repair is busy");
    }
    try {
      return await operation(guard);
    } finally {
      await removeOwnedLock(guard, lockPath, owner.bytes);
    }
  } finally {
    await closePatchStateGuard(guard);
  }
}

async function acquirePatchLock(guard, lockPath, recoveryPath, hooks) {
  await assertPatchStateFileOrMissing(guard, lockPath, "patch repair lock");
  await assertPatchStateFileOrMissing(guard, recoveryPath, "patch repair recovery lock");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await patchStateFileExists(guard, recoveryPath, "patch repair recovery lock")) {
      await delay(25);
      continue;
    }
    try {
      await hooks.beforeLockWrite?.();
      const ownerToken = randomUUID();
      const content = JSON.stringify({ pid: process.pid, ownerToken, startedAtMs: Date.now() });
      await writeNewPatchStateFile(guard, lockPath, content, "patch repair lock");
      return { bytes: Buffer.from(content, "utf8") };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if ((await staleLockBytes(guard, lockPath)) !== undefined) {
        await reclaimStaleLock(guard, lockPath, recoveryPath);
      } else await delay(25);
    }
  }
  return undefined;
}

export async function interruptedStateReason(root) {
  const journalPath = join(root, JOURNAL_RELATIVE_PATH);
  const backupPath = join(root, RECEIPT_BACKUP_RELATIVE_PATH);
  await assertRegularFileOrMissing(journalPath, "patch refit journal");
  await assertRegularFileOrMissing(backupPath, "patch receipt backup");
  if (await fileExists(journalPath)) return "an unfinished patch repair must be recovered";
  if (await fileExists(backupPath)) return "an interrupted patch receipt update must be recovered";
  return undefined;
}

export async function recoverReceiptBackup(root, guard) {
  const receiptPath = join(root, RECEIPT_RELATIVE_PATH);
  const backupPath = join(root, RECEIPT_BACKUP_RELATIVE_PATH);
  await assertPatchStateFileOrMissing(guard, receiptPath, "patch receipt");
  await assertPatchStateFileOrMissing(guard, backupPath, "patch receipt backup");
  if (!(await patchStateFileExists(guard, backupPath, "patch receipt backup"))) return;
  if (await patchStateFileExists(guard, receiptPath, "patch receipt")) {
    await removePatchStateFile(guard, backupPath, "patch receipt backup");
  } else {
    await renamePatchStateFile(guard, backupPath, receiptPath, "patch receipt backup");
  }
}

export async function assertRegularFileOrMissing(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function expectedSnapshotPaths(root, contracts) {
  const targets = (
    await Promise.all(contracts.map((contract) => patchTargets(root, contract)))
  ).flat();
  return unique([...targets, RECEIPT_RELATIVE_PATH]).map((path) => portablePath(path));
}

function parseJournalSnapshots(root, journal, allowed) {
  if (
    !isRecord(journal) ||
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    !Array.isArray(journal.snapshots)
  ) {
    throw new Error("patch refit journal schema is not supported");
  }
  const seen = new Set();
  const snapshots = journal.snapshots.map((entry) =>
    parseJournalSnapshotEntry(root, entry, allowed, seen),
  );
  if (seen.size !== allowed.size || [...allowed].some((path) => !seen.has(path))) {
    throw new Error("patch refit journal does not cover the expected target set");
  }
  return snapshots;
}

function parseJournalSnapshotEntry(root, entry, allowed, seen) {
  if (!isRecord(entry) || typeof entry.path !== "string" || !allowed.has(entry.path)) {
    throw new Error("patch refit journal contains an unexpected target");
  }
  if (seen.has(entry.path)) throw new Error("patch refit journal repeats a target");
  seen.add(entry.path);
  const expectedAfter =
    entry.expectedAfter === undefined ? undefined : parseSnapshotImage(entry.expectedAfter);
  const snapshot = parseStoredSnapshot(entry);
  return {
    path: resolve(root, entry.path),
    ...snapshot,
    ...(expectedAfter === undefined ? {} : { expectedAfter }),
  };
}

function parseStoredSnapshot(entry) {
  if (entry.existed === false) return { existed: false };
  if (
    entry.existed !== true ||
    typeof entry.bytesBase64 !== "string" ||
    !Number.isInteger(entry.mode)
  ) {
    throw new Error("patch refit journal contains an invalid snapshot");
  }
  const bytes = Buffer.from(entry.bytesBase64, "base64");
  if (bytes.toString("base64") !== entry.bytesBase64) {
    throw new Error("patch refit journal contains invalid snapshot bytes");
  }
  return { existed: true, bytes, mode: entry.mode };
}

function serializeSnapshotImage(snapshot) {
  return {
    existed: snapshot.existed,
    ...(snapshot.existed ? { bytesBase64: snapshot.bytes.toString("base64") } : {}),
  };
}

function parseSnapshotImage(value) {
  if (!isRecord(value) || typeof value.existed !== "boolean") {
    throw new Error("patch refit journal contains an invalid expected snapshot");
  }
  if (!value.existed) return { existed: false };
  if (typeof value.bytesBase64 !== "string") {
    throw new Error("patch refit journal contains invalid expected snapshot bytes");
  }
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (bytes.toString("base64") !== value.bytesBase64) {
    throw new Error("patch refit journal contains invalid expected snapshot bytes");
  }
  return { existed: true, bytes };
}

async function verifySnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (!snapshot.existed) {
      if (await fileExists(snapshot.path)) {
        throw new Error("patch rollback left a new target behind");
      }
      continue;
    }
    const current = await readFile(snapshot.path);
    if (!current.equals(snapshot.bytes)) throw new Error("patch rollback bytes do not match");
  }
}

async function reclaimStaleLock(guard, lockPath, recoveryPath) {
  const ownerToken = randomUUID();
  const recoveryContent = JSON.stringify({
    pid: process.pid,
    ownerToken,
    startedAtMs: Date.now(),
  });
  try {
    await writeNewPatchStateFile(
      guard,
      recoveryPath,
      recoveryContent,
      "patch repair recovery lock",
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  try {
    const staleBytes = await staleLockBytes(guard, lockPath);
    if (staleBytes !== undefined) {
      await removePatchStateFileIfBytes(guard, lockPath, "patch repair lock", staleBytes);
    }
  } finally {
    await removeOwnedLock(guard, recoveryPath, Buffer.from(recoveryContent, "utf8"));
  }
}

async function removeOwnedLock(guard, path, expectedBytes) {
  const removed = await removePatchStateFileIfBytes(
    guard,
    path,
    "patch repair lock",
    expectedBytes,
  );
  if (!removed) {
    throw new Error("patch repair lock changed owner before cleanup");
  }
}

async function staleLockBytes(guard, lockPath) {
  try {
    const { bytes, mtimeMs } = await readPatchStateFileWithInfo(
      guard,
      lockPath,
      "patch repair lock",
    );
    const parsed = JSON.parse(bytes.toString("utf8"));
    const stale =
      typeof parsed.pid === "number"
        ? !processIsAlive(parsed.pid)
        : Date.now() - mtimeMs > LOCK_STALE_MS;
    return stale ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function snapshotRelativePath(root, path) {
  const value = relative(resolve(root), resolve(path));
  if (value.length === 0 || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error("patch snapshot target escapes the zer0 installation");
  }
  return portablePath(value);
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

async function fileExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function degraded(receiptPath, reason) {
  return { status: "degraded", reason, receiptPath };
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
