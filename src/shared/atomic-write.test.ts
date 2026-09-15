/**
 * @file src/shared/atomic-write.test.ts
 * @purpose Pins the replace-never-truncate contract, the bounded retry, and the temp-file cleanup.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AtomicWriteSyncFs,
  isTransientReplaceError,
  retryOnSharingViolation,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./atomic-write.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "atomic-write-"));
  roots.push(root);
  return root;
}

function strayTempFiles(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

it("writes a new file and replaces an existing one with the whole new content", async () => {
  const dir = freshDir();
  const target = path.join(dir, "state.json");
  await writeFileAtomic(target, "first");
  expect(readFileSync(target, "utf8")).toBe("first");
  await writeFileAtomic(target, "second");
  expect(readFileSync(target, "utf8")).toBe("second");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("falsifier: a failing write leaves the previous file byte-identical and strands no temp file", async () => {
  const dir = freshDir();
  const target = path.join(dir, "state.json");
  await writeFileAtomic(target, "the bytes that must survive");

  // Every caller in this repo is typed, so the content guard exists for a JavaScript caller the
  // compiler cannot see. Reaching it takes one deliberate widening of the signature.
  const untyped = writeFileAtomic as (target: string, data: unknown) => Promise<void>;
  await expect(untyped(target, 42)).rejects.toThrow(/string or byte content/u);
  expect(readFileSync(target, "utf8")).toBe("the bytes that must survive");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("writes raw bytes without treating them as text", async () => {
  const dir = freshDir();
  const target = path.join(dir, "blob.bin");
  // The content-addressed blob store hands this helper arbitrary bytes. 0xC3 0x28 is invalid utf8, so
  // a writer that applied an encoding would replace it and change the content's own hash.
  const bytes = Buffer.from([0x00, 0xc3, 0x28, 0xff, 0x10, 0x80]);
  await writeFileAtomic(target, bytes);
  expect(readFileSync(target)).toEqual(bytes);

  const syncTarget = path.join(dir, "blob-sync.bin");
  expect(writeFileAtomicSync(syncTarget, bytes)).toEqual({ outcome: "written" });
  expect(readFileSync(syncTarget)).toEqual(bytes);
  expect(strayTempFiles(dir)).toEqual([]);
});

it("the synchronous writer returns its guard failures instead of throwing them", () => {
  // `lane-availability-store.persist` calls it with no try/catch of its own, so a thrown guard would
  // be the one way a durability failure could take down the dispatch that triggered it.
  expect(writeFileAtomicSync("", "x")).toEqual({
    outcome: "failed",
    reason: "atomic write needs a destination path",
  });
  expect(writeFileAtomicSync(path.parse(process.cwd()).root, "x").outcome).toBe("failed");
});

it("the read retry waits out a sharing violation and gives up on anything else", async () => {
  let attempts = 0;
  const clears = await retryOnSharingViolation(async () => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return "value";
  });
  expect(clears).toBe("value");
  expect(attempts).toBe(4);

  let permanentAttempts = 0;
  await expect(
    retryOnSharingViolation(async () => {
      permanentAttempts += 1;
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    }),
  ).rejects.toThrow(/ENOENT/u);
  // An ENOENT is an answer, not a wait: it must not be retried even once.
  expect(permanentAttempts).toBe(1);
});

it("falsifier: a destination held open by a reader is replaced once the reader closes", async () => {
  const dir = freshDir();
  const target = path.join(dir, "held.json");
  await writeFile(target, "OLD", "utf8");
  const handle = await open(target, "r");
  // Windows refuses the replace while this handle lives; the write is issued anyway and must win as
  // soon as the handle closes. The close is scheduled off the same event loop, never a timing pin.
  const writing = writeFileAtomic(target, "NEW");
  setTimeout(() => void handle.close(), 30);
  await writing;
  expect(await readFile(target, "utf8")).toBe("NEW");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("falsifier: a replace that never clears is reported with the destination and the cause", async () => {
  const dir = freshDir();
  const target = path.join(dir, "held.json");
  await writeFile(target, "OLD", "utf8");
  const handle = await open(target, "r");
  try {
    // A one-shot budget: the handle is still open, so the single attempt must fail and say so.
    await expect(writeFileAtomic(target, "NEW", { replaceBudgetMs: 0 })).rejects.toThrow(
      /held\.json/u,
    );
  } finally {
    await handle.close();
  }
  expect(await readFile(target, "utf8")).toBe("OLD");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("refuses a filesystem root and an empty destination before touching the disk", async () => {
  await expect(writeFileAtomic("", "x")).rejects.toThrow(/destination path/u);
  await expect(writeFileAtomic(path.parse(process.cwd()).root, "x")).rejects.toThrow(
    /filesystem root/u,
  );
});

it("creates the destination directory only when the caller asks", async () => {
  const dir = freshDir();
  const nested = path.join(dir, "deep", "state.json");
  await expect(writeFileAtomic(nested, "x")).rejects.toThrow();
  await writeFileAtomic(nested, "x", { ensureDirectory: true });
  expect(readFileSync(nested, "utf8")).toBe("x");
});

it("sync: replaces the file and reports written", () => {
  const dir = freshDir();
  const target = path.join(dir, "sync.json");
  expect(writeFileAtomicSync(target, "first")).toEqual({ outcome: "written" });
  expect(writeFileAtomicSync(target, "second")).toEqual({ outcome: "written" });
  expect(readFileSync(target, "utf8")).toBe("second");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("falsifier sync: a throwing rename returns the reason, keeps the old file, and clears the temp", () => {
  const dir = freshDir();
  const target = path.join(dir, "sync.json");
  writeFileSync(target, "OLD", "utf8");
  const fs: AtomicWriteSyncFs = {
    mkdirSync,
    writeFileSync,
    renameSync: () => {
      throw Object.assign(new Error("EPERM: forced"), { code: "EPERM" });
    },
  };
  const result = writeFileAtomicSync(target, "NEW", { fs });
  // The RAW cause, verbatim: these callers compose their own operator note from it.
  expect(result).toEqual({ outcome: "failed", reason: "EPERM: forced" });
  expect(readFileSync(target, "utf8")).toBe("OLD");
  expect(strayTempFiles(dir)).toEqual([]);
});

it("classifies only the sharing failures a later attempt can win", () => {
  expect(isTransientReplaceError(Object.assign(new Error("x"), { code: "EPERM" }))).toBe(true);
  expect(isTransientReplaceError(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe(true);
  expect(isTransientReplaceError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
  expect(isTransientReplaceError(new Error("x"))).toBe(false);
});
