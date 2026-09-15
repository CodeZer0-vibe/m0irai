/**
 * @file src/evidence/blobs.ts
 * @purpose Content-addressed blob store: `putBlob(buffer)→sha256`, `getBlob(sha256)→buffer`, atomic write via tmp+rename.
 * @exports putBlob, getBlob, getBlobSync, blobExists, BlobStore
 * @depends node:fs, ../shared/atomic-write, ../shared/crypto, ../shared/error-codes, ../shared/errors
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../shared/atomic-write.js";
import { blobPath, sha256 } from "../shared/crypto.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";

const SHA256_HEX_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const UTF8_ENCODING: BufferEncoding = "utf8";

/** Blob store root supplied by validated Zer0 configuration. */
export interface BlobStore {
  rootDir: string;
}

/**
 * Writes content into the content-addressed blob store.
 *
 * @param store - blob store root, normally config.blobRoot
 * @param content - raw Buffer or utf8 string to persist
 * @param signal - optional cancellation signal checked around disk writes
 * @returns SHA-256 hash of the persisted content
 * @throws ConfigError when the store root is invalid or atomic write fails
 * @example
 * await putBlob({ rootDir: ".zer0/blobs" }, Buffer.from("evidence"));
 */
export async function putBlob(
  store: BlobStore,
  content: Buffer | string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const rootDir = validateRoot(store);
  const buffer = toBuffer(content);
  const hash = sha256(buffer);
  validateHash(hash);
  const finalPath = blobPath(rootDir, hash);
  if (existsSync(finalPath)) {
    return hash;
  }
  signal?.throwIfAborted();
  writeAtomic(finalPath, buffer);
  signal?.throwIfAborted();
  return hash;
}

/**
 * Reads one blob by SHA-256 digest.
 *
 * @param store - blob store root, normally config.blobRoot
 * @param hash - 64-character lowercase SHA-256 hex digest
 * @param signal - optional cancellation signal checked around disk reads
 * @returns raw blob bytes
 * @throws ConfigError when the hash is invalid or the read fails
 * @example
 * const bytes = await getBlob({ rootDir: ".zer0/blobs" }, hash);
 */
export async function getBlob(
  store: BlobStore,
  hash: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const content = getBlobSync(store, hash);
  signal?.throwIfAborted();
  return content;
}

/**
 * Synchronous {@link getBlob} core (the read was always readFileSync). Exists for synchronous seams —
 * the MT7 ledger body reader resolves message bodies inside a sync ledger walk (wave-seal B2).
 *
 * @param store - blob store root, normally config.blobRoot
 * @param hash - 64-character lowercase SHA-256 hex digest
 * @returns raw blob bytes
 * @throws ConfigError when the hash is invalid or the read fails
 * @example
 * const bytes = getBlobSync({ rootDir: ".zer0/blobs" }, hash);
 */
export function getBlobSync(store: BlobStore, hash: string): Buffer {
  const finalPath = pathForHash(store, hash);
  try {
    return readFileSync(finalPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to read blob ${hash}: ${reason}`, Zer0ErrorCode.ConfigInvalid, {
      cause: err,
    });
  }
}

/**
 * Checks whether one blob exists by SHA-256 digest.
 *
 * @param store - blob store root, normally config.blobRoot
 * @param hash - 64-character lowercase SHA-256 hex digest
 * @param signal - optional cancellation signal checked before filesystem access
 * @returns true when the content-addressed file exists
 * @throws ConfigError when the hash or store root is invalid
 * @example
 * const present = await blobExists({ rootDir: ".zer0/blobs" }, hash);
 */
export async function blobExists(
  store: BlobStore,
  hash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return existsSync(pathForHash(store, hash));
}

/**
 * The replace itself lives in `src/shared/atomic-write.ts`. This was the SIXTH hand-written copy of one
 * temp-then-rename idiom in this repo (the brief counted five), and it sits on the blob path backing the
 * evidence ledger that room recovery reads to rebuild a damaged transcript. Routing it there also gains
 * two properties it never had: the temp is created with `wx`, so a stranger's file at that path is
 * refused rather than adopted, and the bytes are flushed to the device before the rename publishes them.
 *
 * The shared writer RETURNS its failure, so the `cause` chain the previous copy attached to this
 * ConfigError is gone; the reason text that chain carried is interpolated into the message unchanged.
 */
function writeAtomic(finalPath: string, buffer: Buffer): void {
  const result = writeFileAtomicSync(finalPath, buffer, { ensureDirectory: true });
  if (result.outcome === "failed") {
    throw new ConfigError(
      `Failed to write blob atomically at ${finalPath}: ${result.reason}`,
      Zer0ErrorCode.ConfigInvalid,
    );
  }
}

function pathForHash(store: BlobStore, hash: string): string {
  const rootDir = validateRoot(store);
  validateHash(hash);
  return blobPath(rootDir, hash);
}

function validateRoot(store: BlobStore): string {
  if (store.rootDir.trim().length === 0) {
    throw new ConfigError("blobRoot must be a non-empty string", Zer0ErrorCode.ConfigInvalid);
  }
  return store.rootDir;
}

function validateHash(hash: string): void {
  if (!SHA256_HEX_PATTERN.test(hash)) {
    const message = `Invalid blob hash "${hash}": expected lowercase SHA-256 hex`;
    throw new ConfigError(message, Zer0ErrorCode.ConfigInvalid);
  }
}

function toBuffer(content: Buffer | string): Buffer {
  return typeof content === "string" ? Buffer.from(content, UTF8_ENCODING) : content;
}
