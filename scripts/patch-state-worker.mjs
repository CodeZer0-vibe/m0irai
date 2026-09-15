/**
 * @file scripts/patch-state-worker.mjs
 * @purpose Performs private patch-state file operations relative to one process-pinned directory.
 * @exports none (line-delimited child-process protocol)
 * @depends node:crypto, node:fs/promises, node:readline
 */
import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const expectedDev = process.argv[2];
const expectedIno = process.argv[3];

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ready: false, error: serializeError(error) })}\n`);
  process.exitCode = 1;
});

async function main() {
  const directory = await stat(".");
  if (!directory.isDirectory()) throw new Error("patch state worker cwd is not a directory");
  if (String(directory.dev) !== expectedDev || String(directory.ino) !== expectedIno) {
    throw new Error("patch state worker opened a different directory");
  }
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
      const value = await execute(request);
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
      if (request.operation === "close") break;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ id: request?.id, ok: false, error: serializeError(error) })}\n`,
      );
    }
  }
}

async function execute(request) {
  if (
    !isRecord(request) ||
    !Number.isInteger(request.id) ||
    typeof request.operation !== "string"
  ) {
    throw new Error("invalid patch state worker request");
  }
  if (request.operation === "close") return null;
  if (request.operation === "exists") return fileExists(request.name, request.label);
  if (request.operation === "read") return readStateFile(request.name, request.label);
  if (request.operation === "create") {
    await createStateFile(request.name, request.bytesBase64, request.label);
    return null;
  }
  if (request.operation === "write") {
    await writeStateFile(request.name, request.bytesBase64, request.mode, request.label);
    return null;
  }
  if (request.operation === "rename") {
    await renameStateFile(request.source, request.destination, request.label);
    return null;
  }
  if (request.operation === "remove") {
    return removeStateFile(
      request.name,
      request.label,
      request.force === true,
      request.expectedBytesBase64,
    );
  }
  throw new Error("unsupported patch state worker operation");
}

async function fileExists(name, label) {
  validateName(name);
  try {
    await assertRegularEntry(name, label);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readStateFile(name, label) {
  const handle = await openValidated(name, "r", label);
  try {
    const [bytes, info] = await Promise.all([handle.readFile(), handle.stat()]);
    return { bytesBase64: bytes.toString("base64"), mode: info.mode, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function createStateFile(name, bytesBase64, label) {
  validateName(name);
  const handle = await open(name, "wx", 0o600);
  try {
    await assertOpenedEntry(handle, name, label);
    await writeHandleBytes(handle, decodeBytes(bytesBase64), label);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStateFile(name, bytesBase64, mode, label) {
  if (!Number.isInteger(mode)) throw new Error(`${label} mode is invalid`);
  const handle = await openValidated(name, "r+", label);
  try {
    await writeHandleBytes(handle, decodeBytes(bytesBase64), label);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function renameStateFile(source, destination, label) {
  validateName(source);
  validateName(destination);
  const handle = await openValidated(source, "r", label);
  try {
    const opened = await handle.stat();
    if (await fileExists(destination, `${label} destination`)) {
      throw new Error(`${label} destination already exists`);
    }
    await rename(source, destination);
    try {
      await assertSameEntry(opened, destination, label);
    } catch (error) {
      await restoreMovedEntry(destination, source);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function removeStateFile(name, label, force, expectedBytesBase64) {
  validateName(name);
  let handle;
  try {
    handle = await openValidated(name, "r", label);
  } catch (error) {
    if (force && errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const expectedBytes =
    expectedBytesBase64 === undefined ? undefined : decodeBytes(expectedBytesBase64);
  try {
    const opened = await handle.stat();
    if (expectedBytes !== undefined && !(await readHandleBytes(handle)).equals(expectedBytes)) {
      return false;
    }
    const quarantine = `.${name}.${randomUUID()}.remove`;
    await rename(name, quarantine);
    try {
      await assertSameEntry(opened, quarantine, label);
      if (expectedBytes !== undefined && !(await readHandleBytes(handle)).equals(expectedBytes)) {
        throw new Error(`${label} changed owner before cleanup`);
      }
      await rm(quarantine);
      return true;
    } catch (error) {
      await restoreMovedEntry(quarantine, name);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function openValidated(name, flags, label) {
  validateName(name);
  await assertRegularEntry(name, label);
  const handle = await open(name, flags);
  try {
    await assertOpenedEntry(handle, name, label);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertOpenedEntry(handle, name, label) {
  const [opened, current] = await Promise.all([handle.stat(), lstat(name)]);
  assertRegularInfo(opened, label);
  assertRegularInfo(current, label);
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`${label} changed identity during the transaction`);
  }
}

async function assertSameEntry(opened, name, label) {
  const current = await lstat(name);
  assertRegularInfo(current, label);
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`${label} changed identity during the transaction`);
  }
}

async function assertRegularEntry(name, label) {
  const info = await lstat(name);
  assertRegularInfo(info, label);
}

function assertRegularInfo(info, label) {
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  if (info.nlink !== 1) throw new Error(`${label} must not be hard linked`);
}

async function writeHandleBytes(handle, bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    await assertHandleSingleLink(handle, label);
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error("patch state file accepted no bytes during write");
    offset += bytesWritten;
  }
  await assertHandleSingleLink(handle, label);
  await handle.truncate(bytes.length);
  await assertHandleSingleLink(handle, label);
}

async function readHandleBytes(handle) {
  const info = await handle.stat();
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error("patch state file ended during a handle read");
    offset += bytesRead;
  }
  return bytes;
}

async function restoreMovedEntry(source, destination) {
  if (await fileExists(destination, "patch state restore destination")) return;
  try {
    await rename(source, destination);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function assertHandleSingleLink(handle, label) {
  // Recheck at every write boundary. A malicious same-account process is outside the trust
  // boundary because it already has direct access to zer0's private state and managed files.
  if ((await handle.stat()).nlink !== 1) throw new Error(`${label} must not be hard linked`);
}

function decodeBytes(value) {
  if (typeof value !== "string") throw new Error("patch state bytes are invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("patch state bytes are invalid");
  return bytes;
}

function validateName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error("patch state operation requires a direct child name");
  }
}

function serializeError(error) {
  return { message: errorMessage(error), code: errorCode(error) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
