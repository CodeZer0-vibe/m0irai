import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemote, resolveProjectId } from "./project-scope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { force: true, recursive: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "zer0-project-scope-"));
  tempDirs.push(d);
  return d;
}

async function makeGitRepo(): Promise<string> {
  const root = await makeTempDir();
  await execa("git", ["init"], { cwd: root, reject: false, shell: false });
  return root;
}

describe("resolveProjectId — scoping", () => {
  it("returns a stable scoped id for a git repo (AC1 — stable id)", async () => {
    const repo = await makeGitRepo();
    const first = await resolveProjectId(repo);
    const second = await resolveProjectId(repo);
    expect(first.kind).toBe("scoped");
    expect(second.kind).toBe("scoped");
    if (first.kind === "scoped" && second.kind === "scoped") {
      expect(first.projectId).toBe(second.projectId);
      // Full SHA-256 hex digest = 64 chars (BLOCK-2: no truncation).
      expect(first.projectId).toHaveLength(64);
    }
  });

  // NOTE: the former "subdir → same id" case is RETIRED by the G2 own-toplevel guard — resolveProjectId
  // now scopes ONLY when `cwd` is its OWN git toplevel (every production caller passes the repo root). A
  // subdir's toplevel is its ancestor repo, so it is now refused — see the "REFUSES an ancestor repo's
  // toplevel" falsifier below (the ancestor-git contamination root the guard closes).

  it("returns different ids for two distinct git repos (cross-project isolation)", async () => {
    const repo1 = await makeGitRepo();
    const repo2 = await makeGitRepo();
    const scope1 = await resolveProjectId(repo1);
    const scope2 = await resolveProjectId(repo2);
    expect(scope1.kind).toBe("scoped");
    expect(scope2.kind).toBe("scoped");
    if (scope1.kind === "scoped" && scope2.kind === "scoped") {
      expect(scope1.projectId).not.toBe(scope2.projectId);
    }
  });
});

describe("resolveProjectId — freshness (C1: no stale project-id cache)", () => {
  it("reflects an origin change — a new remote yields a DIFFERENT id, never stale (C1: the deleted session-store cache scenario)", async () => {
    // C1 root: session-store's former repoRoot-keyed cache never invalidated, so an origin change
    // mid-session returned the STALE id. With the cache deleted, session-store resolves FRESH each persist —
    // this falsifier pins the property that makes that correct: the projectId tracks the current origin.
    const repo = await makeGitRepo();
    await execa("git", ["remote", "add", "origin", "https://example.com/before.git"], {
      cwd: repo,
      reject: false,
      shell: false,
    });
    const before = await resolveProjectId(repo);
    await execa("git", ["remote", "set-url", "origin", "https://example.com/after.git"], {
      cwd: repo,
      reject: false,
      shell: false,
    });
    const after = await resolveProjectId(repo);
    expect(before.kind).toBe("scoped");
    expect(after.kind).toBe("scoped");
    if (before.kind === "scoped" && after.kind === "scoped") {
      expect(after.projectId).not.toBe(before.projectId); // fresh: never the pre-change id
    }
  });
});

describe("resolveProjectId — unscopable", () => {
  it("returns unscopable for a path not inside a git work tree (AC2)", async () => {
    const nonGitDir = await makeTempDir();
    const result = await resolveProjectId(nonGitDir);
    expect(result.kind).toBe("unscopable");
    if (result.kind === "unscopable") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns unscopable for a non-existent path without throwing (BLOCK-3)", async () => {
    // Path is deliberately never created — gitQuery must catch the spawn error.
    const nonExistent = join(tmpdir(), `zer0-no-such-path-${Date.now()}`);
    const result = await resolveProjectId(nonExistent);
    expect(result.kind).toBe("unscopable");
  });

  it("REFUSES an ancestor repo's toplevel — a non-repo folder inside a git repo never inherits the repo's id (G2, the ancestor-git contamination root)", async () => {
    // The exact scenario behind the known home-dir/temp-dir contamination class: a project folder that is
    // NOT its own git repo sits INSIDE a parent git repo. `git rev-parse --show-toplevel` walks UP to the
    // parent, so without the own-toplevel guard the child binds memory/evidence to the PARENT's project id.
    const parent = await makeGitRepo();
    const child = join(parent, "child-not-a-repo");
    await mkdir(child, { recursive: true });
    const parentScope = await resolveProjectId(parent);
    const childScope = await resolveProjectId(child);
    // The repo root IS its own toplevel → still scoped.
    expect(parentScope.kind).toBe("scoped");
    // The child's git toplevel is the ANCESTOR parent, not itself → refused; NEVER the parent's id.
    expect(childScope.kind).toBe("unscopable");
    if (parentScope.kind === "scoped" && childScope.kind === "scoped") {
      expect(childScope.projectId).not.toBe(parentScope.projectId); // unreachable once refused; the falsifier
    }
  });
});

describe("resolveProjectId — Windows path normalization", () => {
  it("returns the same id from a path with a flipped Windows drive-letter case (BLOCK-1)", async () => {
    const repo = await makeGitRepo();
    // Flip the drive letter case: C:\ → c:\ (or vice versa). On non-Windows paths
    // (no leading drive letter) the replacement matches nothing → flipped === repo → skip.
    const flipped = repo.replace(/^([A-Za-z]):/, (_, d: string) =>
      d === d.toUpperCase() ? `${d.toLowerCase()}:` : `${d.toUpperCase()}:`,
    );
    if (flipped === repo) {
      // No Windows drive letter — test not applicable on this platform.
      return;
    }
    const fromOriginal = await resolveProjectId(repo);
    const fromFlipped = await resolveProjectId(flipped);
    expect(fromOriginal.kind).toBe("scoped");
    expect(fromFlipped.kind).toBe("scoped");
    if (fromOriginal.kind === "scoped" && fromFlipped.kind === "scoped") {
      expect(fromFlipped.projectId).toBe(fromOriginal.projectId);
    }
  });
});

describe("normalizeRemote — remote fingerprint", () => {
  it("strips .git and lowercases the HTTPS host, preserving path case", () => {
    expect(normalizeRemote("https://GitHub.COM/Org/Repo.git")).toBe("https://github.com/Org/Repo");
  });

  it("lowercases only the SSH host, preserving username and path case (codex T1.4)", () => {
    expect(normalizeRemote("Git@GitHub.COM:Org/Repo.git")).toBe("Git@github.com:Org/Repo");
  });

  it("treats SSH remotes differing only in host case as identical", () => {
    expect(normalizeRemote("git@github.com:org/repo")).toBe(
      normalizeRemote("git@GITHUB.COM:org/repo"),
    );
  });
});
