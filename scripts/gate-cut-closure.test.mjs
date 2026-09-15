// Unit tests for scripts/gate-cut-closure.mjs. findUnrecordedRemovals (FL-174) itself is exercised with
// an injected fixture (the underlying comparison logic hasn't changed since round 1); the ORIGINAL
// findings-become-gates live incident (a TUI test file renamed out of src/tui at commit 5423574 with no
// deletions.json record) had already been scrubbed out of the committed tracked-surface.json by a later
// `--update` by the time round 1 was built, so it never reproduced on this tree — the fixture below
// reconstructs the same SHAPE of defect instead.
//
// Round 2 / B1: the real defect the round-1 reviewer found was in WHICH inventory the gate reads —
// comparing the CURRENT committed tracked-surface.json against git ls-files can never fire on a tree that
// passes gate-tracked-surface.mjs, because `--update` already scrubs the removed path from that same
// file. Fixed by reading `git show HEAD:...` instead — the "real-git B1 reproduction" describe block
// below is a REAL git repo replaying the reviewer's exact workflow (delete, --update, then check), not a
// fixture, because a fixture over the OLD (already-fixed) comparison would prove nothing about the fix.
import { describe, expect, it } from "vitest";
import { checkCutClosure, findUnrecordedRemovals, referenceTokens } from "./gate-cut-closure.mjs";

describe("findUnrecordedRemovals (FL-174: tracked-surface.json vs git ls-files vs deletions.json)", () => {
  // Fixture paths are deliberately fictitious (never a real deletions.json entry) — this file is itself
  // tracked and scanned by checkCutClosure's own reference check, so a fixture string that happened to
  // match a REAL recorded deletion would trip that check as a false "still references it" positive.
  it("RED: an inventory path gone from git ls-files with no deletions.json record is flagged", () => {
    const inventoryPaths = ["src/example-lane/retired-widget.test.ts", "src/room/room-host.ts"];
    const trackedNow = ["src/room/room-host.ts"]; // the retired-widget path left the tree
    const deletionPaths = []; // and nobody recorded it

    expect(findUnrecordedRemovals(inventoryPaths, trackedNow, deletionPaths)).toEqual([
      "src/example-lane/retired-widget.test.ts",
    ]);
  });

  it("GREEN: the same removal is accepted once deletions.json records the exact path", () => {
    const inventoryPaths = ["src/example-lane/retired-widget.test.ts", "src/room/room-host.ts"];
    const trackedNow = ["src/room/room-host.ts"];
    const deletionPaths = ["src/example-lane/retired-widget.test.ts"];

    expect(findUnrecordedRemovals(inventoryPaths, trackedNow, deletionPaths)).toEqual([]);
  });

  it("a path still present in git ls-files is not a removal at all, recorded or not", () => {
    const inventoryPaths = ["src/room/room-host.ts"];
    const trackedNow = ["src/room/room-host.ts"];
    const deletionPaths = [];

    expect(findUnrecordedRemovals(inventoryPaths, trackedNow, deletionPaths)).toEqual([]);
  });

  it("reports every unrecorded removal, not just the first", () => {
    const inventoryPaths = ["a/one.ts", "a/two.ts", "a/three.ts"];
    const trackedNow = [];
    const deletionPaths = ["a/two.ts"]; // only one of the three is recorded

    expect(findUnrecordedRemovals(inventoryPaths, trackedNow, deletionPaths)).toEqual([
      "a/one.ts",
      "a/three.ts",
    ]);
  });
});

describe("referenceTokens (import/path token shapes for one deleted path)", () => {
  it("a nested path yields both the full path and the directory-tail import shape", () => {
    const tokens = referenceTokens("src/example-lane/retired-widget.ts");
    expect(tokens).toContain("src/example-lane/retired-widget.ts");
    expect(tokens).toContain("example-lane/retired-widget.js");
  });
});

describe("checkCutClosure — real-git B1 reproduction (delete, --update, THEN check)", () => {
  it("RED-then-GREEN: a file removed and --update'd in the same staged change, with no deletions.json record, is caught — the exact workflow the round-1 gate missed", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

    const root = await mkdtemp(join(tmpdir(), "cut-closure-b1-"));
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "t@t.com"], root);
      git(["config", "user.name", "t"], root);
      await mkdir(join(root, "docs", "provenance"), { recursive: true });
      await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
      await writeFile(join(root, "gone.txt"), "gone\n", "utf8");
      await writeFile(
        join(root, "docs/provenance/deletions.json"),
        JSON.stringify({ entries: [] }),
        "utf8",
      );
      // The HEAD inventory the fix reads: both files are still tracked at this commit.
      await writeFile(
        join(root, "docs/provenance/tracked-surface.json"),
        JSON.stringify({
          policy: "work",
          count: 4,
          paths: [
            "docs/provenance/deletions.json",
            "docs/provenance/tracked-surface.json",
            "gone.txt",
            "keep.txt",
          ],
        }),
        "utf8",
      );
      git(["add", "."], root);
      git(["commit", "-q", "-m", "base"], root);

      // Reviewer's exact workflow, step by step: delete the file, then run the equivalent of
      // `gate-tracked-surface --update` (scrub it from the working-tree inventory) — WITHOUT committing
      // and WITHOUT a deletions.json record.
      git(["rm", "-q", "gone.txt"], root);
      await writeFile(
        join(root, "docs/provenance/tracked-surface.json"),
        JSON.stringify({
          policy: "work",
          count: 3,
          paths: [
            "docs/provenance/deletions.json",
            "docs/provenance/tracked-surface.json",
            "keep.txt",
          ],
        }),
        "utf8",
      );

      // GREEN would have been the round-1 bug: this must throw, naming gone.txt.
      expect(() => checkCutClosure(root)).toThrowError(/gone\.txt/);

      // Recording the deletion clears it — proves the check isn't just permanently broken the other way.
      await writeFile(
        join(root, "docs/provenance/deletions.json"),
        JSON.stringify({ entries: [{ path: "gone.txt", category: "test", phase: "0" }] }),
        "utf8",
      );
      expect(() => checkCutClosure(root)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("checkCutClosure (real tree, positive control)", () => {
  // Scans every tracked text file's full contents against 3000+ recorded deletions — measured ~60s on
  // this box, well past vitest's 30s default.
  it("passes the real repo tree — every recorded deletion is gone, unreferenced, and tracked-surface has no unrecorded removal", () => {
    const r = checkCutClosure(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.deletions).toBeGreaterThan(100);
    expect(r.scanned).toBeGreaterThan(100);
  }, 120_000);
});
