// Unit + real-git tests for scripts/gate-tracked-surface.mjs (R5-F5, I5-1, I5-2 — H2 item 5 + round 2b).
// A real unresolved merge is the only faithful way to reproduce `git ls-files`'s per-stage duplicate
// listing and `git ls-files -u` behavior — a mocked array would prove nothing about the actual git quirk
// that caused the live incidents (docs/provenance/tracked-surface.json at commit fd389e7 on branch
// m4-file-projection; the operator's own D-merge incident, 2170 duplicated rows the same day).
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  checkTrackedSurface,
  collectVerifyProblems,
  findDuplicates,
  tracked,
} from "./gate-tracked-surface.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Round-2b nit: isolated from THIS BOX's ambient git config, not just from its own local repo config.
// Verified live (git 2.53.0): with GIT_CONFIG_GLOBAL pointed at an empty file and GIT_CONFIG_NOSYSTEM=1,
// `git config --list --show-origin` shows only the LOCAL repo's own entries — no ~/.gitconfig, no system
// gitconfig, no ambient aliases/hooks/safe.directory/autocrlf settings can reach these tests. Identity is
// set via GIT_AUTHOR_*/GIT_COMMITTER_* env vars (verified live: a commit succeeds and is attributed
// correctly with no `git config user.*` call at all), so no fixture needs one either.
const GIT_CONFIG_DIR = await mkdtemp(join(tmpdir(), "gate-tracked-surface-gitconfig-"));
const GIT_CONFIG_GLOBAL = join(GIT_CONFIG_DIR, "empty.gitconfig");
await writeFile(GIT_CONFIG_GLOBAL, "", "utf8");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "h2-test",
  GIT_AUTHOR_EMAIL: "h2-test@example.invalid",
  GIT_COMMITTER_NAME: "h2-test",
  GIT_COMMITTER_EMAIL: "h2-test@example.invalid",
};
afterAll(async () => {
  await rm(GIT_CONFIG_DIR, { recursive: true, force: true });
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
}

/** A real repo left mid an UNRESOLVED merge conflict on f.txt — the exact shape `git ls-files` lists
 *  once per index stage (verified live: 1 conflicted file -> 3 rows without --deduplicate) and
 *  `git ls-files -u` lists as unmerged (I5-1). */
async function conflictedRepo() {
  const root = await mkdtemp(join(tmpdir(), "tracked-surface-merge-"));
  roots.push(root);
  git(["init", "-q"], root);
  // checkTrackedSurface's --update writeFileSync does not create parent directories, matching a real
  // m0irai checkout where docs/provenance/ already exists — the fixture mirrors that precondition.
  await mkdir(join(root, "docs", "provenance"), { recursive: true });
  await writeFile(join(root, "f.txt"), "base\n", "utf8");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "base"], root);
  const trunk = git(["symbolic-ref", "--short", "HEAD"], root).trim();
  git(["checkout", "-q", "-b", "branch-a"], root);
  await writeFile(join(root, "f.txt"), "a-version\n", "utf8");
  git(["commit", "-q", "-am", "a"], root);
  git(["checkout", "-q", trunk], root);
  await writeFile(join(root, "f.txt"), "b-version\n", "utf8");
  git(["commit", "-q", "-am", "b"], root);
  try {
    git(["merge", "branch-a", "-q"], root);
  } catch {
    // expected: the merge conflicts and exits non-zero, leaving f.txt unresolved.
  }
  return root;
}

// Each real-git test below spins up its own repo and several subprocess calls; under full parallel
// pool load (this file runs alongside heavy suites like patch-lifecycle.test.mjs) that measured well
// past vitest's 30s default, so every one carries an explicit timeout.
const GIT_TEST_TIMEOUT_MS = 60_000;

describe("I5-1: both modes refuse closed against an unresolved merge (round 2b, CONFIRMED)", () => {
  it(
    "RED: verify mode refuses, naming the unmerged path, before it ever reads the inventory",
    async () => {
      const root = await conflictedRepo();

      expect(() => checkTrackedSurface(root)).toThrowError(
        /refusing to verify against an unresolved merge.*\n\s*f\.txt/s,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "RED: --update refuses too, and writes NOTHING to the inventory file (the operator's exact D-merge shape)",
    async () => {
      const root = await conflictedRepo();
      const before = await readFile(
        join(root, "docs/provenance/tracked-surface.json"),
        "utf8",
      ).catch(() => undefined);

      expect(() => checkTrackedSurface(root, { update: true })).toThrowError(
        /refusing to --update against an unresolved merge/,
      );

      const after = await readFile(
        join(root, "docs/provenance/tracked-surface.json"),
        "utf8",
      ).catch(() => undefined);
      expect(after).toBe(before); // no file existed before, none exists after — never touched
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "GREEN: once the conflict is resolved and committed, both modes work normally again and write one clean row",
    async () => {
      const root = await conflictedRepo();
      await writeFile(join(root, "f.txt"), "resolved\n", "utf8");
      git(["add", "f.txt"], root);
      git(["commit", "-q", "-m", "resolve"], root);

      const r = checkTrackedSurface(root, { update: true });
      expect(r.updated).toBe(true);
      const written = JSON.parse(
        await readFile(join(root, "docs/provenance/tracked-surface.json"), "utf8"),
      );
      expect(written.paths.filter((p) => p === "f.txt")).toEqual(["f.txt"]);
      expect(written.count).toBe(written.paths.length);

      expect(() => checkTrackedSurface(root)).not.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

// Round-2b: I5-1 means `checkTrackedSurface` now refuses BEFORE `tracked()` (and its --deduplicate flag)
// ever runs on an unresolved index — so the gate itself can no longer be driven into the mid-conflict
// state that originally motivated --deduplicate. These two are BASELINE tests of raw git, not of the
// gate: they prove the --deduplicate MECHANISM `tracked()` relies on still does what it says, so that
// mechanism stays provably correct even though I5-1 makes it unreachable via checkTrackedSurface today.
describe("BASELINE (raw git, not the gate under test): the --deduplicate mechanism tracked() relies on", () => {
  it(
    "without --deduplicate, git lists a conflicted path once per index stage",
    async () => {
      const root = await conflictedRepo();

      const raw = execFileSync("git", ["ls-files", "-z"], {
        cwd: root,
        encoding: "utf8",
        env: GIT_ENV,
      });
      const rows = raw.split("\0").filter(Boolean);
      expect(rows.filter((p) => p === "f.txt")).toEqual(["f.txt", "f.txt", "f.txt"]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "with --deduplicate, the same conflicted path collapses to exactly one row",
    async () => {
      const root = await conflictedRepo();

      const raw = execFileSync("git", ["ls-files", "-z", "--deduplicate"], {
        cwd: root,
        encoding: "utf8",
        env: GIT_ENV,
      });
      const rows = raw.split("\0").filter(Boolean);
      expect(rows.filter((p) => p === "f.txt")).toEqual(["f.txt"]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

// N1 (round 3, CONFIRMED): the BASELINE block above proves the git flag works, but calls raw
// execFileSync directly — it never touches gate-tracked-surface.mjs's own tracked() function at all, so
// a regression INSIDE tracked() (the flag dropped, a typo in the args array) would pass every test in
// this file except this one. This calls the REAL EXPORTED tracked() against a real conflicted repo.
describe("tracked() (N1, round 3) — the --deduplicate mechanism defended DIRECTLY, not just via raw git", () => {
  it(
    "RED: tracked() itself returns exactly one row for the conflicted path, not three",
    async () => {
      const root = await conflictedRepo();

      const result = tracked(root);

      expect(result.filter((p) => p === "f.txt")).toEqual(["f.txt"]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("findDuplicates (pure)", () => {
  it("returns every value seen more than once, sorted, each once", () => {
    expect(findDuplicates(["a", "b", "a", "c", "b", "a"])).toEqual(["a", "b"]);
  });

  it("returns an empty array for a duplicate-free list", () => {
    expect(findDuplicates(["a", "b", "c"])).toEqual([]);
  });
});

describe("collectVerifyProblems (pure, direct — round-2b nit: exported, so test it directly)", () => {
  it("RED: a duplicate in `now` itself (post-dedup belt-and-suspenders) is caught, not just a duplicate in `inv.paths`", () => {
    // now
    const inv = { count: 1, paths: ["f.txt"] };
    const now = ["f.txt", "f.txt"]; // as if --deduplicate somehow still returned a repeat
    const problems = collectVerifyProblems(inv, now, "work");
    expect(
      problems.some((p) => p.includes("git ls-files --deduplicate still returned duplicate")),
    ).toBe(true);
  });

  it("GREEN: no problems for a clean, matching inv/now pair", () => {
    const inv = { count: 1, paths: ["f.txt"] };
    const now = ["f.txt"];
    expect(collectVerifyProblems(inv, now, "work")).toEqual([]);
  });
});

describe("checkTrackedSurface verify mode: fails closed on a corrupt committed inventory (R5-F5, I5-2)", () => {
  async function fixtureRepo() {
    const root = await mkdtemp(join(tmpdir(), "tracked-surface-verify-"));
    roots.push(root);
    git(["init", "-q"], root);
    await writeFile(join(root, "f.txt"), "x\n", "utf8");
    git(["add", "f.txt"], root);
    git(["commit", "-q", "-m", "base"], root);
    return root;
  }

  async function writeInventory(root, body) {
    await mkdir(join(root, "docs", "provenance"), { recursive: true });
    await writeFile(
      join(root, "docs/provenance/tracked-surface.json"),
      JSON.stringify(body),
      "utf8",
    );
  }

  it(
    "RED: a duplicate row already sitting in the committed inventory is caught (the old Set-based compare could never see this)",
    async () => {
      const root = await fixtureRepo();
      await writeInventory(root, { policy: "work", count: 2, paths: ["f.txt", "f.txt"] });

      expect(() => checkTrackedSurface(root)).toThrowError(/duplicate row/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "RED: a numerically wrong count field is caught even with no duplicate",
    async () => {
      const root = await fixtureRepo();
      await writeInventory(root, { policy: "work", count: 5, paths: ["f.txt"] });

      expect(() => checkTrackedSurface(root)).toThrowError(/count field/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  // I5-2: each of these used to fail OPEN under the old `typeof inv.count === "number"` guard.
  it.each([
    ["missing entirely", undefined],
    ["a string", "1"],
    ["null", null],
  ])(
    "RED (I5-2): a count that is %s is caught, not silently accepted",
    async (_label, badCount) => {
      const root = await fixtureRepo();
      const body =
        badCount === undefined
          ? { policy: "work", paths: ["f.txt"] }
          : { policy: "work", count: badCount, paths: ["f.txt"] };
      await writeInventory(root, body);

      expect(() => checkTrackedSurface(root)).toThrowError(/count field/);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "GREEN: a clean inventory (no duplicates, integer count matches) passes",
    async () => {
      const root = await fixtureRepo();
      await writeInventory(root, { policy: "work", count: 1, paths: ["f.txt"] });

      expect(() => checkTrackedSurface(root)).not.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("checkTrackedSurface (real tree, positive control)", () => {
  it("passes the real repo tree with no duplicate rows and a matching count", () => {
    const r = checkTrackedSurface(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.count).toBeGreaterThan(100);
  });
});
