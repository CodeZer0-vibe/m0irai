/**
 * @file src/shared/git-inspect.test.ts
 * @purpose Falsifying contract for the shared git-inspect owner (G3): the -z porcelain parser classifies
 *   every XY kind (incl. the two-token rename), the own-toplevel guard verdict canonicalizes both sides, and
 *   the canonicalization forward-slashes + never throws on a not-yet-existent path.
 * @exports (test suite — no runtime exports)
 * @depends vitest, node:path, node:process, ./git-inspect
 */
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  GIT_INSPECT_ENV,
  GIT_INSPECT_TIMEOUT_MS,
  canonicalGitPath,
  isOwnToplevel,
  parsePorcelainZ,
} from "./git-inspect.js";

describe("parsePorcelainZ — classifies every -z entry kind", () => {
  it("parses modified/added/deleted/untracked and the two-token rename in first-appearance order", () => {
    const raw = " M mod.txt\0A  add.txt\0 D gone.txt\0?? unt.txt\0R  new.txt\0old.txt\0";
    const entries = parsePorcelainZ(raw);
    expect(entries.map((e) => [e.kind, e.path])).toEqual([
      ["modified", "mod.txt"],
      ["added", "add.txt"],
      ["deleted", "gone.txt"],
      ["untracked", "unt.txt"],
      ["renamed", "new.txt"],
    ]);
  });

  it("a rename carries renameFrom (the OLD path) and consumes the second token", () => {
    const [rename] = parsePorcelainZ("R  after.txt\0before.txt\0");
    expect(rename).toMatchObject({ kind: "renamed", path: "after.txt", renameFrom: "before.txt" });
  });

  it("marks deleted when EITHER status column reads D", () => {
    expect(parsePorcelainZ("D  a.txt\0")[0]?.deleted).toBe(true);
    expect(parsePorcelainZ(" D b.txt\0")[0]?.deleted).toBe(true);
    expect(parsePorcelainZ(" M c.txt\0")[0]?.deleted).toBe(false);
  });

  it("skips the trailing empty token from the final NUL (no phantom entry)", () => {
    expect(parsePorcelainZ(" M only.txt\0")).toHaveLength(1);
    expect(parsePorcelainZ("")).toEqual([]);
  });

  it("keeps a path containing a space intact (-z never truncates)", () => {
    expect(parsePorcelainZ(" M dir/a file.txt\0")[0]?.path).toBe("dir/a file.txt");
  });
});

describe("isOwnToplevel — the own-toplevel guard verdict", () => {
  it("accepts a toplevel that canonically equals the repo root", () => {
    expect(isOwnToplevel(process.cwd(), process.cwd())).toBe(true);
  });

  it("REJECTS an ancestor toplevel (the home-dir/ancestor-repo contamination class)", () => {
    const child = process.cwd();
    const ancestor = path.dirname(child);
    expect(isOwnToplevel(ancestor, child)).toBe(false);
  });
});

describe("canonicalGitPath — comparison canonicalization", () => {
  it("forward-slashes and is idempotent for an existing path", () => {
    const once = canonicalGitPath(process.cwd());
    expect(once).not.toContain("\\");
    expect(canonicalGitPath(once)).toBe(once);
  });

  it("never throws on a not-yet-existent path (lexical fallback)", () => {
    const ghost = path.join(process.cwd(), "no-such-dir-xyz", "child");
    expect(() => canonicalGitPath(ghost)).not.toThrow();
    expect(canonicalGitPath(ghost)).not.toContain("\\");
  });
});

describe("the shared env + timeout policy are single constants", () => {
  it("exposes the git child-env allowlist and one timeout", () => {
    expect(GIT_INSPECT_ENV).toEqual({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
    expect(GIT_INSPECT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
