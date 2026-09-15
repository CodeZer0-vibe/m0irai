// Test for scripts/verify-staged.mjs's B1-R2 fix (H2 round 3, was BLOCKING).
// `verifyStaged()` itself is out of scope here: it runs a real `npm ci && npm run verify` inside its
// stage, which is minutes of unrelated toolchain work per invocation and would make this test about the
// whole gate suite, not about B1-R2. Instead this exercises the actual code path that matters —
// `writePreviousTrackedSurfaceOverride` writing a real file into a real stage directory, read back by the
// real `checkCutClosure` from gate-cut-closure.mjs — with no mocking on either side. This is exactly the
// integration the reviewer's B1-R2 finding said was silently broken: a stage with zero commit history,
// carrying an unrecorded deletion, that used to pass gate-cut-closure.mjs's FL-174 check every time.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkCutClosure } from "./gate-cut-closure.mjs";
import {
  PREV_TRACKED_SURFACE_OVERRIDE,
  writePreviousTrackedSurfaceOverride,
} from "./verify-staged.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Same isolation pattern as gate-tracked-surface.test.mjs (round 2b nit): no ambient global/system git
// config, explicit author/committer via env so no fixture needs a `git config user.*` call.
const GIT_CONFIG_DIR = await mkdtemp(join(tmpdir(), "verify-staged-gitconfig-"));
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

/** A real "original repo": one commit at HEAD whose tracked-surface.json lists `src/gone.ts`, then an
 *  UNCOMMITTED working-tree change that deletes `src/gone.ts` and refreshes tracked-surface.json to drop
 *  it — with no docs/provenance/deletions.json entry ever written. This is the exact live failure mode
 *  B1-R2 describes: a path removed and `--update`d in the same change the gate is meant to catch. */
async function repoWithUnrecordedRemoval() {
  const root = await mkdtemp(join(tmpdir(), "verify-staged-b1r2-"));
  roots.push(root);
  await mkdir(join(root, "docs", "provenance"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "docs", "provenance", "deletions.json"), '{"entries":[]}\n', "utf8");
  await writeFile(join(root, "src", "keep.ts"), "// keep\n", "utf8");
  await writeFile(join(root, "src", "gone.ts"), "// about to vanish, unrecorded\n", "utf8");
  await writeFile(
    join(root, "docs", "provenance", "tracked-surface.json"),
    `${JSON.stringify(
      {
        count: 4,
        paths: [
          "docs/provenance/deletions.json",
          "docs/provenance/tracked-surface.json",
          "src/keep.ts",
          "src/gone.ts",
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  git(["init", "-q"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base: src/gone.ts tracked"], root);
  // Now the unrecorded removal: the file leaves the tree, tracked-surface.json is refreshed to match, and
  // deletions.json is never touched. This mirrors gate-tracked-surface.mjs --update having already run.
  await rm(join(root, "src", "gone.ts"));
  await writeFile(
    join(root, "docs", "provenance", "tracked-surface.json"),
    `${JSON.stringify(
      {
        count: 3,
        paths: [
          "docs/provenance/deletions.json",
          "docs/provenance/tracked-surface.json",
          "src/keep.ts",
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

/** Builds a fresh, zero-commit "stage" from `root`'s current working-tree contents — the same end shape
 *  verify-staged.mjs's own verifyStaged() produces via git-archive-then-extract-then-`init`+`add -A`
 *  (a plain recursive copy stands in for the archive/extract step here: what matters for B1-R2 is that the
 *  stage ends up as a fresh repo with a staged index and zero commits, not the exact packaging mechanism). */
async function buildStage(root) {
  const stage = await mkdtemp(join(tmpdir(), "verify-staged-b1r2-stage-"));
  roots.push(stage);
  await cp(join(root, "docs"), join(stage, "docs"), { recursive: true });
  await cp(join(root, "src"), join(stage, "src"), { recursive: true });
  git(["init", "-q"], stage);
  git(["add", "-A"], stage);
  return stage;
}

const GIT_TEST_TIMEOUT_MS = 60_000;

describe("B1-R2 (round 3, was BLOCKING): the override is what lets a zero-commit stage catch FL-174", () => {
  it(
    "RED->GREEN: with the override written, checkCutClosure catches the unrecorded removal inside a HEAD-less stage",
    async () => {
      const root = await repoWithUnrecordedRemoval();
      const stage = await buildStage(root);

      writePreviousTrackedSurfaceOverride(root, stage);

      expect(() => checkCutClosure(stage)).toThrowError(/FL-174.*1\n {2}src\/gone\.ts/s);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "without the override, the same HEAD-less stage still fails closed (never silently passes)",
    async () => {
      const root = await repoWithUnrecordedRemoval();
      const stage = await buildStage(root);

      // writePreviousTrackedSurfaceOverride deliberately NOT called: proves the override file, not
      // some other side effect, is what makes the FL-174 check reachable inside a zero-commit stage.
      expect(() => checkCutClosure(stage)).toThrowError(
        new RegExp(
          `no HEAD commit and no ${PREV_TRACKED_SURFACE_OVERRIDE.replace(/[.]/g, "\\.")} override`,
        ),
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "the override file itself lands untracked in the stage (git ls-files never sees it)",
    async () => {
      const root = await repoWithUnrecordedRemoval();
      const stage = await buildStage(root);

      writePreviousTrackedSurfaceOverride(root, stage);

      const tracked = git(["ls-files"], stage);
      expect(tracked).not.toMatch(/prev-tracked-surface\.json/);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
