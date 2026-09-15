/**
 * @file src/memory/request-files.test.ts
 * @purpose Falsifiers for the request-file extractor (MT6a-completion W0): repo-relative slash-form
 *   extraction from live operator prose, backslash normalization, rejection of absolute/drive/..
 *   shapes, first-mention dedupe, and the cap.
 */
import { describe, expect, it } from "vitest";
import { MAX_REQUEST_FILES, extractRequestFiles } from "./request-files.js";

describe("extractRequestFiles", () => {
  it("extracts repo-relative slash paths from prose, deduped in first-mention order", () => {
    const text =
      "fix the bug in src/chat/evidence.ts and check src/memory/router.ts — src/chat/evidence.ts again";
    expect(extractRequestFiles(text)).toEqual(["src/chat/evidence.ts", "src/memory/router.ts"]);
  });

  it("normalizes Windows backslashes before matching", () => {
    expect(extractRequestFiles(String.raw`look at src\room\room-host.ts please`)).toEqual([
      "src/room/room-host.ts",
    ]);
  });

  it("rejects absolute, drive-prefixed, and dot-dot shapes (the canonical-key contract)", () => {
    const text = String.raw`C:/Users/x/evil.ts and ../../etc/passwd.txt and C:\repo\a.ts stay out`;
    expect(extractRequestFiles(text)).toEqual([]);
  });

  it("extracts ROOT-LEVEL files (MT6a-review W0: the old slash-required pattern never pulled package.json)", () => {
    expect(extractRequestFiles("fix package.json and check tsconfig.json")).toEqual([
      "package.json",
      "tsconfig.json",
    ]);
  });

  it("requires a letter-led extension: bare directories and version-like tokens never match", () => {
    expect(
      extractRequestFiles("the review talks about src/chat at v0.21 per r19 B1 findings"),
    ).toEqual([]);
  });

  it("caps at MAX_REQUEST_FILES", () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/x/f${String(i)}.ts`).join(" ");
    expect(extractRequestFiles(many)).toHaveLength(MAX_REQUEST_FILES);
  });
});

describe("cap priority (sol wave-review r2 residual)", () => {
  it("slash paths can never be truncated out by root-token prose noise", () => {
    const noise = Array.from({ length: 20 }, (_, i) => `api.get${String(i)}`).join(" ");
    const text = `${noise} then fix src/chat/evidence.ts and package.json`;
    const result = extractRequestFiles(text);
    expect(result).toContain("src/chat/evidence.ts");
    expect(result).toHaveLength(MAX_REQUEST_FILES);
    expect(result[0]).toBe("src/chat/evidence.ts");
  });
});
