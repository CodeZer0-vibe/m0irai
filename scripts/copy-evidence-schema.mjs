#!/usr/bin/env node
/**
 * @file scripts/copy-evidence-schema.mjs
 * @purpose Copies non-TypeScript runtime assets required by the compiled room host into dist.
 * @exports copyEvidenceSchema, copyProductionRuntimeAssets
 * @depends node:fs/promises, node:path, node:url
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_RELATIVE_PATH = join("src", "evidence", "schema.sql");
const STATUSLINE_EMITTER_RELATIVE_PATH = join("src", "chat", "statusline-emit.cjs");

/** Copies the evidence schema with its bytes unchanged into the compiled tree. */
export async function copyEvidenceSchema({
  sourceRoot = PROJECT_ROOT,
  distRoot = join(sourceRoot, "dist"),
} = {}) {
  const source = join(resolve(sourceRoot), SCHEMA_RELATIVE_PATH);
  const destination = join(resolve(distRoot), SCHEMA_RELATIVE_PATH);
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to copy evidence schema build asset from ${source} to ${destination}: ${reason}`,
      { cause: error },
    );
  }
  return { destination, source };
}

/** Copies every runtime asset that TypeScript compilation cannot emit. */
export async function copyProductionRuntimeAssets({
  sourceRoot = PROJECT_ROOT,
  distRoot = join(sourceRoot, "dist"),
} = {}) {
  const schema = await copyEvidenceSchema({ sourceRoot, distRoot });
  const source = join(resolve(sourceRoot), STATUSLINE_EMITTER_RELATIVE_PATH);
  const destination = join(resolve(distRoot), STATUSLINE_EMITTER_RELATIVE_PATH);
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to copy statusline emitter build asset from ${source} to ${destination}: ${reason}`,
      { cause: error },
    );
  }
  return { schema, statuslineEmitter: { destination, source } };
}

const invokedPath =
  process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === invokedPath || fileURLToPath(import.meta.url) === process.argv[1]) {
  await copyProductionRuntimeAssets();
}
