/**
 * @file scripts/patch-write.mjs
 * @purpose Applies staged patch bytes through identity-checked handles contained in managed packages.
 * @exports applyExpectedSnapshots, restoreExpectedSnapshots, snapshotManagedPaths
 * @depends node:fs/promises, node:path, ./patch-contracts
 */
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { patchTargets } from "./patch-contracts.mjs";

export async function applyExpectedSnapshots(root, contracts, snapshots) {
  const owners = await targetOwners(root, contracts);
  const changes = snapshots.filter(
    (snapshot) =>
      snapshot.expectedAfter !== undefined && !sameBytes(snapshot, snapshot.expectedAfter),
  );
  for (const snapshot of changes) {
    if (!snapshot.existed || !snapshot.expectedAfter.existed) {
      throw new Error("safe patch application supports existing files only");
    }
    if (!owners.has(resolve(snapshot.path))) {
      throw new Error("patch transaction contains an unexpected live target");
    }
  }
  for (const snapshot of changes) {
    await replaceExistingFileSafely(root, owners.get(resolve(snapshot.path)), snapshot, {
      acceptCurrent: (current) => current.equals(snapshot.bytes),
      desiredBytes: snapshot.expectedAfter.bytes,
    });
  }
}

export async function restoreExpectedSnapshots(root, contracts, snapshots) {
  const owners = await targetOwners(root, contracts);
  const managed = snapshots.filter((snapshot) => owners.has(resolve(snapshot.path)));
  if (managed.length !== owners.size) {
    throw new Error("patch transaction does not cover every managed target");
  }
  for (const snapshot of managed) {
    if (!snapshot.existed || snapshot.expectedAfter?.existed !== true) {
      throw new Error("safe patch recovery supports existing files only");
    }
  }
  for (const snapshot of managed) {
    await replaceExistingFileSafely(root, owners.get(resolve(snapshot.path)), snapshot, {
      acceptCurrent: (current) =>
        current.equals(snapshot.expectedAfter.bytes) ||
        isExpectedWriteIntermediate(current, snapshot.bytes, snapshot.expectedAfter.bytes),
      desiredBytes: snapshot.bytes,
    });
  }
}

export async function snapshotManagedPaths(root, contracts, paths) {
  const owners = await targetOwners(root, contracts);
  return Promise.all(
    paths.map(async (path) => {
      const packageRoot = owners.get(resolve(path));
      if (packageRoot === undefined) {
        throw new Error("patch snapshot contains an unexpected managed target");
      }
      return snapshotManagedPath(root, packageRoot, path);
    }),
  );
}

async function targetOwners(root, contracts) {
  const owners = new Map();
  for (const contract of contracts) {
    const targets = await patchTargets(root, contract);
    for (const target of targets) {
      const targetPath = resolve(root, target);
      if (owners.has(targetPath)) throw new Error(`multiple patches target ${target}`);
      owners.set(targetPath, resolve(root, contract.packagePath));
    }
  }
  return owners;
}

async function replaceExistingFileSafely(root, packageRoot, snapshot, operation) {
  const handle = await open(snapshot.path, "r+");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${snapshot.path} is not a regular file`);
    if (opened.nlink !== 1) throw new Error(`${snapshot.path} must not be hard linked`);
    await assertOpenedTargetContained(root, packageRoot, snapshot.path, opened);
    const current = await readHandleBytes(handle);
    if (current.equals(operation.desiredBytes)) return;
    if (!operation.acceptCurrent(current)) {
      throw new Error(`${snapshot.path} changed outside the patch transaction`);
    }
    await assertOpenedTargetContained(root, packageRoot, snapshot.path, opened);
    await writeHandleBytes(handle, operation.desiredBytes, snapshot.path);
    await handle.chmod(snapshot.mode);
    await handle.sync();
    const written = await readHandleBytes(handle);
    if (!written.equals(operation.desiredBytes)) {
      throw new Error(`${snapshot.path} did not retain the expected patched bytes`);
    }
  } finally {
    await handle.close();
  }
}

async function snapshotManagedPath(root, packageRoot, path) {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path} is not a regular file`);
    if (opened.nlink !== 1) throw new Error(`${path} must not be hard linked`);
    await assertOpenedTargetContained(root, packageRoot, path, opened);
    const first = await readHandleBytes(handle);
    const middle = await handle.stat();
    await assertOpenedTargetContained(root, packageRoot, path, opened);
    const second = await readHandleBytes(handle);
    const final = await handle.stat();
    if (!first.equals(second) || !sameStableFileState(opened, middle, final)) {
      throw new Error(`${path} changed while its rollback snapshot was captured`);
    }
    return { path, existed: true, bytes: first, mode: opened.mode };
  } finally {
    await handle.close();
  }
}

async function assertOpenedTargetContained(root, packageRoot, targetPath, opened) {
  const [actualRoot, actualNodeModules, actualPackageRoot, actualTarget, current] =
    await Promise.all([
      realpath(root),
      realpath(join(root, "node_modules")),
      realpath(packageRoot),
      realpath(targetPath),
      stat(targetPath),
    ]);
  if (!isWithin(actualRoot, actualNodeModules)) {
    throw new Error("node_modules resolves outside the zer0 installation");
  }
  if (!isWithin(actualNodeModules, actualPackageRoot)) {
    throw new Error("managed package root resolves outside node_modules");
  }
  if (!isWithin(actualPackageRoot, actualTarget)) {
    throw new Error("patch target resolves outside its managed package");
  }
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`${targetPath} changed identity during the patch transaction`);
  }
}

async function readHandleBytes(handle) {
  const info = await handle.stat();
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error("patch target ended during a file-handle read");
    offset += bytesRead;
  }
  return bytes;
}

async function writeHandleBytes(handle, bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    await assertHandleSingleLink(handle, label);
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error("patch target accepted no bytes during write");
    offset += bytesWritten;
  }
  await assertHandleSingleLink(handle, label);
  await handle.truncate(bytes.length);
  await assertHandleSingleLink(handle, label);
}

async function assertHandleSingleLink(handle, label) {
  // This detects non-cooperative hardlink churn at each write boundary. It is not an OS
  // privilege boundary against arbitrary code running as the same account; that code can
  // already write every target zer0 can write.
  if ((await handle.stat()).nlink !== 1) throw new Error(`${label} must not be hard linked`);
}

function sameStableFileState(...states) {
  const first = states[0];
  return states.every(
    (state) =>
      state.dev === first.dev &&
      state.ino === first.ino &&
      state.nlink === 1 &&
      state.size === first.size &&
      state.mtimeMs === first.mtimeMs &&
      state.ctimeMs === first.ctimeMs,
  );
}

function sameBytes(left, right) {
  return left.existed === right.existed && (!left.existed || left.bytes.equals(right.bytes));
}

function isExpectedWriteIntermediate(current, before, expected) {
  if (current.length > before.length) {
    return (
      current.length <= expected.length && current.equals(expected.subarray(0, current.length))
    );
  }
  if (current.length !== before.length) return false;
  let expectedPrefix = 0;
  while (
    expectedPrefix < current.length &&
    expectedPrefix < expected.length &&
    current[expectedPrefix] === expected[expectedPrefix]
  ) {
    expectedPrefix += 1;
  }
  let beforeSuffixStart = current.length;
  while (
    beforeSuffixStart > 0 &&
    current[beforeSuffixStart - 1] === before[beforeSuffixStart - 1]
  ) {
    beforeSuffixStart -= 1;
  }
  return beforeSuffixStart <= Math.min(expectedPrefix, expected.length);
}

function isWithin(base, candidate) {
  const value = relative(base, candidate);
  return value.length > 0 && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}
