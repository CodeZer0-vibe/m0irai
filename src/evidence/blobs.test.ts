import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobPath, sha256 } from "../shared/crypto.js";
import { Zer0ErrorCode } from "../shared/error-codes.js";
import { ConfigError } from "../shared/errors.js";
import { type BlobStore, blobExists, getBlob, putBlob } from "./blobs.js";

const TEMP_PREFIX: string = "zer0-evidence-blobs-";
const CONTENT: string = "ledger evidence";
const INVALID_HASH: string = "../../not-a-hash";

let tempRoot: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.resetModules();
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("putBlob", () => {
  it("stores content under the shared sha256 hash", async () => {
    const store = tempStore();
    const expectedHash = sha256(CONTENT);

    const hash = await putBlob(store, CONTENT);

    expect(hash).toBe(expectedHash);
    expect(readFileSync(blobPath(store.rootDir, expectedHash), "utf8")).toBe(CONTENT);
  });

  it("deduplicates a second write by hash", async () => {
    const store = tempStore();
    const hash = await putBlob(store, CONTENT);
    const filePath = blobPath(store.rootDir, hash);
    writeFileSync(filePath, "kept", "utf8");

    const secondHash = await putBlob(store, CONTENT);

    expect(secondHash).toBe(hash);
    expect(readFileSync(filePath, "utf8")).toBe("kept");
  });
});

describe("putBlob atomic failure handling", () => {
  /**
   * The whole `node:fs` surface the writer uses, over a set that stands in for the disk. The assertion
   * is the OBSERVABLE — nothing left behind — rather than which delete call performed it, so it holds
   * across the move of this idiom into `src/shared/atomic-write.ts`.
   */
  function fakeDiskWhereRenameFails(): Set<string> {
    const written = new Set<string>();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((filePath: string) => written.has(filePath)),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      renameSync: vi.fn(() => {
        throw new ConfigError("rename failed", Zer0ErrorCode.ConfigInvalid);
      }),
      unlinkSync: vi.fn((filePath: string) => {
        written.delete(filePath);
      }),
      rmSync: vi.fn((filePath: string) => {
        written.delete(filePath);
      }),
      writeFileSync: vi.fn((filePath: string) => {
        written.add(filePath);
      }),
    }));
    return written;
  }

  it("leaves no temp file behind when the rename fails, and names the blob it could not write", async () => {
    const written = fakeDiskWhereRenameFails();
    const imported = await import("./blobs.js");

    const failure = await imported
      .putBlob({ rootDir: "/tmp/blobs" }, CONTENT)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: Zer0ErrorCode.ConfigInvalid, name: "ConfigError" });
    expect(failure instanceof Error ? failure.message : "").toContain("blob");
    expect([...written]).toEqual([]);
  });
});

describe("putBlob content fidelity", () => {
  it("round-trips raw bytes that are not valid utf8", async () => {
    const store = tempStore();
    // The store is content-addressed over arbitrary bytes, so the writer must never treat its payload
    // as text. 0xC3 0x28 is an invalid utf8 sequence: a text round trip would replace it.
    const bytes = Buffer.from([0x00, 0xc3, 0x28, 0xff, 0x10, 0x80]);

    const hash = await putBlob(store, bytes);

    expect(readFileSync(blobPath(store.rootDir, hash))).toEqual(bytes);
    expect(await getBlob(store, hash)).toEqual(bytes);
  });
});

describe("getBlob and blobExists", () => {
  it("reads the same buffer that was stored", async () => {
    const store = tempStore();
    const hash = await putBlob(store, Buffer.from(CONTENT, "utf8"));

    await expect(getBlob(store, hash)).resolves.toEqual(Buffer.from(CONTENT, "utf8"));
  });

  it("reports whether a validated blob hash exists", async () => {
    const store = tempStore();
    const hash = await putBlob(store, CONTENT);

    await expect(blobExists(store, hash)).resolves.toBe(true);
    expect(existsSync(blobPath(store.rootDir, hash))).toBe(true);
  });

  it("rejects path traversal shaped hashes", async () => {
    const store = tempStore();

    await expect(getBlob(store, INVALID_HASH)).rejects.toBeInstanceOf(ConfigError);
    await expect(blobExists(store, INVALID_HASH)).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects an empty blob root", async () => {
    await expect(putBlob({ rootDir: " " }, CONTENT)).rejects.toBeInstanceOf(ConfigError);
  });
});

function tempStore(): BlobStore {
  tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  return { rootDir: join(tempRoot, "blobs") };
}
