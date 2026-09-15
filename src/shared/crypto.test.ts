import { describe, expect, it } from "vitest";
import { blobPath, sha256 } from "./crypto.js";

const EMPTY_SHA256_DIGEST: string =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256_DIGEST: string =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ROOT_DIR: string = ".zer0/blobs";

describe("sha256", () => {
  it("returns the well-known SHA-256 digest of an empty string", () => {
    expect(sha256("")).toBe(EMPTY_SHA256_DIGEST);
  });

  it("returns the same digest for equivalent string and Buffer content", () => {
    expect(sha256(Buffer.from("abc", "utf8"))).toBe(ABC_SHA256_DIGEST);
    expect(sha256("abc")).toBe(ABC_SHA256_DIGEST);
  });
});

describe("blobPath", () => {
  it("assembles the content-addressed path using the hash prefix", () => {
    expect(blobPath(ROOT_DIR, EMPTY_SHA256_DIGEST)).toBe(`${ROOT_DIR}/e3/${EMPTY_SHA256_DIGEST}`);
  });
});
