/**
 * @file scripts/patch-contracts.mjs
 * @purpose Owns patch filenames, expected-set validation, safe target parsing, and file fingerprints.
 * @exports loadPatchRuntime, readPatchContracts, patchVersionMismatches, readPatchEffects,
 *   patchTargets, fingerprint, sha256File, unique
 * @depends node:crypto, node:fs/promises, node:module, node:path
 */
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
let patchRuntime;

export function loadPatchRuntime() {
  if (patchRuntime !== undefined) return patchRuntime;
  const { parsePatchFile } = require("patch-package/dist/patch/parse.js");
  const { executeEffects } = require("patch-package/dist/patch/apply.js");
  const { reversePatch } = require("patch-package/dist/patch/reverse.js");
  patchRuntime = { executeEffects, parsePatchFile, reversePatch };
  return patchRuntime;
}

export async function readPatchContracts(root = process.cwd()) {
  const patchDir = join(root, "patches");
  let entries;
  try {
    entries = await readdir(patchDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    entries = [];
  }
  const patchFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => entry.name)
    .sort();
  await validateExpectedPatchSet(root, patchFiles);
  return Promise.all(patchFiles.map((patchFile) => readPatchContract(root, patchDir, patchFile)));
}

export function patchVersionMismatches(contracts) {
  return contracts
    .filter((contract) => contract.declaredVersion !== contract.installedVersion)
    .map(
      (contract) =>
        `${contract.patchFile} targets ${contract.packageName}@${contract.declaredVersion} but ${contract.installedVersion} is installed`,
    );
}

export async function readPatchEffects(root, contract) {
  const { parsePatchFile } = loadPatchRuntime();
  const effects = parsePatchFile(await readFile(contract.patchPath, "utf8"));
  if (effects.some((effect) => effect.type === "mode change")) {
    throw new Error(`${contract.patchFile} contains an unsupported mode-only change`);
  }
  const targets = unique(effects.flatMap(effectPaths));
  for (const target of targets) await validateTarget(root, contract, target);
  return { effects, targets };
}

export async function patchTargets(root, contract) {
  return (await readPatchEffects(root, contract)).targets;
}

export async function fingerprint(path) {
  try {
    return { exists: true, sha256: sha256(await readFile(path)) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, sha256: null };
    throw error;
  }
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export function unique(values) {
  return [...new Set(values)].sort();
}

async function readPatchContract(root, patchDir, patchFile) {
  const parsed = parsePatchFilename(patchFile);
  if (parsed === undefined) {
    throw new Error(`${patchFile} does not name a package and exact semantic version`);
  }
  const packagePath = packageInstallPath(parsed.packageNames);
  const packageJsonPath = join(root, packagePath, "package.json");
  let installed;
  try {
    installed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${patchFile} targets ${parsed.packageName}, but that package is not installed`,
      { cause: error },
    );
  }
  if (typeof installed.version !== "string" || installed.version.length === 0) {
    throw new Error(`${packageJsonPath} has no readable package version`);
  }
  return {
    declaredVersion: parsed.declaredVersion,
    installedVersion: installed.version,
    packageName: parsed.packageName,
    packagePath,
    patchFile,
    patchPath: join(patchDir, patchFile),
  };
}

async function validateExpectedPatchSet(root, patchFiles) {
  let product;
  try {
    product = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (product.zer0Patches === undefined) return;
  if (!validExpectedPatchNames(product.zer0Patches)) {
    throw new Error("package.json zer0Patches must contain patch filenames only");
  }
  const expected = unique(product.zer0Patches);
  const missing = expected.filter((name) => !patchFiles.includes(name));
  if (missing.length > 0) throw new Error(`expected patch set is missing: ${missing.join(", ")}`);
  const unexpected = patchFiles.filter((name) => !expected.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`patch set has unregistered files: ${unexpected.join(", ")}`);
  }
}

function validExpectedPatchNames(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (name) =>
        typeof name === "string" &&
        name.endsWith(".patch") &&
        !name.includes("/") &&
        !name.includes("\\"),
    )
  );
}

async function validateTarget(root, contract, target) {
  if (isAbsolute(target)) throw new Error(`${contract.patchFile} contains an absolute target path`);
  const packageRoot = resolve(root, contract.packagePath);
  const targetPath = resolve(root, target);
  if (!isInside(packageRoot, targetPath)) {
    throw new Error(`${contract.patchFile} targets a file outside ${contract.packageName}`);
  }
  const actualRoot = await realpath(root);
  const actualNodeModules = await realpath(resolve(root, "node_modules"));
  const actualPackageRoot = await realpath(packageRoot);
  if (!isInside(actualRoot, actualNodeModules)) {
    throw new Error("node_modules resolves outside the zer0 installation");
  }
  if (!isInside(actualNodeModules, actualPackageRoot)) {
    throw new Error(`${contract.patchFile} managed package root resolves outside node_modules`);
  }
  try {
    const actualTarget = await realpath(targetPath);
    if (!isInside(actualPackageRoot, actualTarget)) {
      throw new Error(`${contract.patchFile} target resolves outside ${contract.packageName}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const actualParent = await realpath(dirname(targetPath));
    if (!isInside(actualPackageRoot, actualParent)) {
      throw new Error(
        `${contract.patchFile} target parent resolves outside ${contract.packageName}`,
      );
    }
  }
}

function effectPaths(effect) {
  return [effect.path, effect.fromPath, effect.toPath].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function parsePatchFilename(patchFile) {
  const parts = patchFile
    .replace(/(\.dev)?\.patch$/, "")
    .split("++")
    .map(parsePatchPart);
  if (parts.some((part) => part === undefined)) return undefined;
  const last = parts.at(-1);
  if (last?.version === undefined) return undefined;
  return {
    packageName: last.packageName,
    packageNames: parts.map((part) => part.packageName),
    declaredVersion: last.version,
  };
}

function parsePatchPart(raw) {
  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const versionIndex = parts.findIndex((part) => /^\d+\.\d+\.\d+.*$/.test(part));
  const nameParts = versionIndex === -1 ? parts : parts.slice(0, versionIndex);
  if (nameParts.length < 1 || nameParts.length > 2) return undefined;
  const packageName = nameParts.length === 1 ? nameParts[0] : `${nameParts[0]}/${nameParts[1]}`;
  return { packageName, ...(versionIndex === -1 ? {} : { version: parts[versionIndex] }) };
}

function packageInstallPath(packageNames) {
  const segments = ["node_modules"];
  packageNames.forEach((name, index) => {
    segments.push(...name.split("/"));
    if (index < packageNames.length - 1) segments.push("node_modules");
  });
  return join(...segments);
}

function isInside(base, candidate) {
  const value = relative(base, candidate);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
