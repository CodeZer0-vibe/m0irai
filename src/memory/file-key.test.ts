/**
 * @file src/memory/file-key.test.ts
 * @purpose Falsifiers for the canonical repo-relative file key (MT6a-review W1): the ONE
 *   normalization both the journal write edge and the request-extraction read edge share. The
 *   kill-chain this guards: digest stores `src\memory\digest.ts`, operator asks
 *   `src/memory/digest.ts`, exact-match intersection dies silently.
 */
import { describe, expect, it } from "vitest";
import { canonicalFileSet, canonicalRepoRelativeFile } from "./file-key.js";

describe("canonicalRepoRelativeFile", () => {
  it("normalizes backslash spellings to the slash key (the review's kill-chain)", () => {
    expect(canonicalRepoRelativeFile(String.raw`src\memory\digest.ts`)).toBe(
      "src/memory/digest.ts",
    );
  });

  it("strips leading ./ prefixes, repeatedly", () => {
    expect(canonicalRepoRelativeFile("./src/x.ts")).toBe("src/x.ts");
    expect(canonicalRepoRelativeFile("././src/x.ts")).toBe("src/x.ts");
  });

  it("passes through already-canonical keys byte-identically, case preserved", () => {
    expect(canonicalRepoRelativeFile("src/TUI/Cockpit.tsx")).toBe("src/TUI/Cockpit.tsx");
    expect(canonicalRepoRelativeFile("package.json")).toBe("package.json");
  });

  it("rejects absolute, drive-prefixed, dot-dot, empty-segment, directory, and empty shapes", () => {
    for (const bad of [
      "/etc/passwd",
      "C:/repo/a.ts",
      String.raw`C:\repo\a.ts`,
      "../secrets.env",
      "src/../../x.ts",
      "src//x.ts",
      "src/chat/",
      "",
      "   ",
      "./",
    ]) {
      expect(canonicalRepoRelativeFile(bad)).toBeUndefined();
    }
  });
});

describe("canonicalFileSet", () => {
  it("dedupes DIFFERENT SPELLINGS of one file after canonicalization", () => {
    expect(canonicalFileSet([String.raw`src\a.ts`, "./src/a.ts", "src/a.ts", "src/b.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("returns undefined when nothing survives (the store writes NULL, never [])", () => {
    expect(canonicalFileSet(["C:/x.ts", "../y.ts", ""])).toBeUndefined();
  });
});
