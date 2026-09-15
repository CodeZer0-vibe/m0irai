/**
 * @file src/shared/crypto.ts
 * @purpose Pure SHA-256 hashing and content-addressed blob path computation.
 * @exports sha256, blobPath
 * @depends node:crypto
 */
import { createHash } from "node:crypto";

/** SHA-256 hexadecimal digest length. */
const SHA256_HEX_LENGTH: number = 64;

/** Content-addressed blob fanout prefix length. */
const BLOB_DIR_PREFIX_LENGTH: number = 2;

/**
 * Computes SHA-256 over the given content.
 *
 * @param content - utf8 string or raw Buffer to hash
 * @returns 64-character lowercase hex digest
 * @throws RangeError when the underlying digest length is not 64 (defensive sanity check)
 * @example
 * sha256("");
 * @pure
 */
export function sha256(content: string | Buffer): string {
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest.length !== SHA256_HEX_LENGTH) {
    throw new RangeError(
      `SHA-256 digest length was ${digest.length}, expected ${SHA256_HEX_LENGTH}`,
    );
  }
  return digest;
}

/**
 * Builds a content-addressed blob path for a SHA-256 digest.
 *
 * @param rootDir - root directory for blob storage
 * @param hash - 64-character lowercase hex digest
 * @returns deterministic blob path under the digest prefix directory
 * @pure
 */
export function blobPath(rootDir: string, hash: string): string {
  return `${rootDir}/${hash.slice(0, BLOB_DIR_PREFIX_LENGTH)}/${hash}`;
}
