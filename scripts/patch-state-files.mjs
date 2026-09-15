/**
 * @file scripts/patch-state-files.mjs
 * @purpose Pins the private patch-state directory and contains every state-file mutation.
 * @exports assertPatchStateFileOrMissing, assertPatchStateGuard, closePatchStateGuard,
 *   createPatchStateGuard, patchStateFileExists, readPatchStateFile,
 *   readPatchStateFileWithInfo, removePatchStateFile, removePatchStateFileIfBytes,
 *   renamePatchStateFile,
 *   validatePatchStateDirectory, writeExistingPatchStateFile, writeNewPatchStateFile
 * @depends node:child_process, node:fs/promises, node:path, node:readline, node:url
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const STATE_RELATIVE_PATH = join("node_modules", ".zer0");
const WORKER_PATH = fileURLToPath(new URL("./patch-state-worker.mjs", import.meta.url));
const WORKER_TIMEOUT_MS = 10_000;

export async function createPatchStateGuard(root, create, hooks = {}) {
  const statePath = await validatePatchStateDirectory(root, create);
  const handle = await open(statePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error("patch state handle is not a directory");
    const guard = { root, statePath, handle, dev: info.dev, ino: info.ino, hooks };
    await assertPatchStateGuard(guard);
    guard.worker = await startStateWorker(statePath, info);
    await assertPatchStateGuard(guard);
    return guard;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function closePatchStateGuard(guard) {
  let workerError;
  try {
    await closeStateWorker(guard.worker);
  } catch (error) {
    workerError = error;
  }
  await guard.handle.close();
  if (workerError !== undefined) throw workerError;
}

export async function assertPatchStateGuard(guard) {
  const statePath = await validatePatchStateDirectory(guard.root, false);
  const current = await stat(statePath);
  if (
    resolve(statePath) !== resolve(guard.statePath) ||
    current.dev !== guard.dev ||
    current.ino !== guard.ino
  ) {
    throw new Error("patch state directory changed during the transaction");
  }
}

export async function readPatchStateFile(guard, path, label, encoding) {
  const result = await readPatchStateFileWithInfo(guard, path, label);
  return encoding === undefined ? result.bytes : result.bytes.toString(encoding);
}

export async function readPatchStateFileWithInfo(guard, path, label) {
  const name = stateName(guard, path);
  await assertPatchStateGuard(guard);
  const result = await stateCommand(guard.worker, "read", { name, label });
  await assertPatchStateGuard(guard);
  return {
    bytes: decodeWorkerBytes(result.bytesBase64),
    mode: result.mode,
    mtimeMs: result.mtimeMs,
  };
}

export async function writeNewPatchStateFile(guard, path, content, label) {
  await mutatePatchState(guard, "create", path, label, {
    bytesBase64: Buffer.from(content, "utf8").toString("base64"),
  });
}

export async function writeExistingPatchStateFile(guard, path, bytes, mode, label) {
  await mutatePatchState(guard, "write", path, label, {
    bytesBase64: Buffer.from(bytes).toString("base64"),
    mode,
  });
}

export async function renamePatchStateFile(guard, source, destination, label) {
  const sourceName = stateName(guard, source);
  const destinationName = stateName(guard, destination);
  await assertPatchStateGuard(guard);
  await guard.hooks.beforeStatePathOperation?.({ operation: "rename", path: source });
  await stateCommand(guard.worker, "rename", {
    source: sourceName,
    destination: destinationName,
    label,
  });
  await assertPatchStateGuard(guard);
}

export async function removePatchStateFile(guard, path, label, force = false) {
  const name = stateName(guard, path);
  await assertPatchStateGuard(guard);
  await guard.hooks.beforeStatePathOperation?.({ operation: "remove", path });
  await stateCommand(guard.worker, "remove", { name, label, force });
  await assertPatchStateGuard(guard);
}

export async function removePatchStateFileIfBytes(guard, path, label, expectedBytes) {
  const name = stateName(guard, path);
  await assertPatchStateGuard(guard);
  await guard.hooks.beforeStatePathOperation?.({ operation: "remove", path });
  const removed = await stateCommand(guard.worker, "remove", {
    name,
    label,
    force: true,
    expectedBytesBase64: Buffer.from(expectedBytes).toString("base64"),
  });
  await assertPatchStateGuard(guard);
  return removed;
}

export async function patchStateFileExists(guard, path, label) {
  const name = stateName(guard, path);
  await assertPatchStateGuard(guard);
  const exists = await stateCommand(guard.worker, "exists", { name, label });
  await assertPatchStateGuard(guard);
  return exists;
}

export async function assertPatchStateFileOrMissing(guard, path, label) {
  await patchStateFileExists(guard, path, label);
}

export async function validatePatchStateDirectory(root, create) {
  const actualRoot = await realpath(root);
  const nodeModulesPath = join(root, "node_modules");
  const actualNodeModules = await realpath(nodeModulesPath);
  if (!isWithin(actualRoot, actualNodeModules)) {
    throw new Error("node_modules resolves outside the zer0 installation");
  }
  const statePath = join(root, STATE_RELATIVE_PATH);
  let info;
  try {
    info = await lstat(statePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" || !create) throw error;
    try {
      await mkdir(statePath, { mode: 0o700 });
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
    }
    info = await lstat(statePath);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("patch state directory must be a real directory inside node_modules");
  }
  const actualState = await realpath(statePath);
  if (!isWithin(actualNodeModules, actualState)) {
    throw new Error("patch state directory resolves outside node_modules");
  }
  return statePath;
}

async function mutatePatchState(guard, operation, path, label, details) {
  const name = stateName(guard, path);
  await assertPatchStateGuard(guard);
  await guard.hooks.beforeStatePathOperation?.({ operation, path });
  await stateCommand(guard.worker, operation, { name, label, ...details });
  await assertPatchStateGuard(guard);
}

function stateName(guard, path) {
  if (resolve(dirname(path)) !== resolve(guard.statePath)) {
    throw new Error("patch state operation targets a file outside the pinned state directory");
  }
  return basename(path);
}

async function startStateWorker(statePath, info) {
  const child = spawn(process.execPath, [WORKER_PATH, String(info.dev), String(info.ino)], {
    cwd: statePath,
    env: workerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const worker = createWorkerController(child);
  await worker.ready;
  return worker;
}

function createWorkerController(child) {
  let nextId = 1;
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const pending = new Map();
  const stderr = [];
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (!readySettled) {
      readySettled = true;
      if (message.ready === true) resolveReady();
      else rejectReady(workerError(message.error));
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.ok === true) request.resolve(message.value);
    else request.reject(workerError(message.error));
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.join("").length < 4096) stderr.push(String(chunk));
  });
  child.once("error", (error) => failWorker(error));
  child.once("exit", (code) => {
    if (code !== 0 || pending.size > 0 || !readySettled) {
      failWorker(
        new Error(`patch state worker exited unexpectedly (${String(code)})${stderrText(stderr)}`),
      );
    }
  });
  function failWorker(error) {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }
  return {
    child,
    ready,
    exit,
    command(operation, details) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveCommand, rejectCommand) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          child.kill();
          rejectCommand(new Error("patch state worker operation timed out"));
        }, WORKER_TIMEOUT_MS);
        timeout.unref();
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
        child.stdin.write(`${JSON.stringify({ id, operation, ...details })}\n`);
      });
    },
  };
}

async function stateCommand(worker, operation, details) {
  return worker.command(operation, details);
}

async function closeStateWorker(worker) {
  if (worker === undefined) return;
  await stateCommand(worker, "close", {});
  worker.child.stdin.end();
  await worker.exit;
}

function decodeWorkerBytes(value) {
  if (typeof value !== "string") throw new Error("patch state worker returned invalid bytes");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("patch state worker returned invalid bytes");
  }
  return bytes;
}

function workerError(value) {
  const error = new Error(
    typeof value === "object" && value !== null && typeof value.message === "string"
      ? value.message
      : "patch state worker failed",
  );
  if (typeof value === "object" && value !== null && typeof value.code === "string") {
    error.code = value.code;
  }
  return error;
}

function workerEnvironment() {
  const keys = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"];
  return Object.fromEntries(
    keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

function stderrText(chunks) {
  const value = chunks.join("").trim();
  return value.length === 0 ? "" : `: ${value}`;
}

function isWithin(base, candidate) {
  const value = relative(base, candidate);
  return value.length > 0 && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
