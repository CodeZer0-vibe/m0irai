/**
 * @file scripts/gate-cut-closure.mjs
 * @purpose The cut-closure guard (plan v5 rule 4). For every path recorded in `docs/provenance/deletions.json`:
 *   (a) it must be gone from the tracked tree (a record that lies is a failure), and (b) no tracked text file may
 *   still reference it — as an import specifier (`dir/name.js`), a path (`dir/name.ts`), or a documented command.
 *   Reference tokens always include a directory segment (never a bare basename) so `types.js` cannot false-match;
 *   same-directory `./sibling.js` imports of a deleted file are caught by `tsc` (typecheck is a mandatory gate).
 *   Historical/prose roots are excluded from the scan (docs/provenance, docs/STATE.md, docs/specs, docs/reviews)
 *   because they legitimately NAME removed paths; README/AGENTS/CLAUDE/GEMINI/docs/agents ARE scanned.
 *   FL-174, the REVERSE direction: `docs/provenance/tracked-surface.json` is an inventory of tracked paths,
 *   refreshed in place by `gate-tracked-surface.mjs --update` whenever a file leaves the tree — which means a
 *   deletion can be silently absorbed into a green tracked-surface gate with no deletions.json record ever
 *   written. Round-2 review B1 (CONFIRMED): comparing the CURRENT committed inventory against `git ls-files`
 *   cannot catch this, because by the time `--update` has run the current inventory has ALREADY been scrubbed
 *   of the removed path — the check's trigger was a strict subset of gate-tracked-surface.mjs's own existing
 *   failure, so it could never fire on a tree that passes that gate. Fixed to compare the PREVIOUS COMMIT's
 *   inventory against the current tracked set: "what HEAD tracked vs what the index tracks", so a path removed
 *   and `--update`d in the SAME change, with no deletions.json record, still fails. (This cannot retroactively
 *   catch a deletion whose HEAD inventory was ALSO already stale before this fix existed — the live case,
 *   retroactively recorded in deletions.json under FL-174: a TUI status-language test file renamed out of
 *   src/tui at commit 5423574 — see findUnrecordedRemovals.)
 *   Round-3 review B1-R2 (CONFIRMED, was BLOCKING): "the previous commit's inventory" does NOT mean a literal
 *   `git show HEAD:...` everywhere this gate runs — `npm run verify:staged` runs it inside a disposable stage
 *   that is a FRESH `git init` with a staged index and ZERO commits, where `HEAD` cannot resolve no matter how
 *   much history the real repo has, and the old code's blanket `catch { return []; }` treated that structural
 *   gap the same as "nothing to compare" and passed silently. Fixed on both ends: `verify-staged.mjs` writes
 *   the real repo's previous inventory into the stage at a well-known, never-`git add`ed path
 *   (`.verify-logs/prev-tracked-surface.json`) after its own `git add -A` runs there; this file's
 *   `readPreviousTrackedSurfacePaths` reads that override first when present, and — critically — now FAILS
 *   CLOSED (throws) rather than returning `[]` when there is neither an override NOR a resolvable `HEAD`, since
 *   that exact silent-empty shape is what let an unrecorded deletion through `verify:staged` undetected. A real
 *   `HEAD` that simply never tracked this file yet (bootstrapping) still legitimately returns `[]`.
 * @exports checkCutClosure, referenceTokens, findUnrecordedRemovals
 * @depends node:child_process, node:fs, node:path, node:url
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DELETIONS = "docs/provenance/deletions.json";
const TRACKED_SURFACE = "docs/provenance/tracked-surface.json";
// Under the `work` policy historical docs (and the retained-for-now .council archive) may still exist and legitimately
// NAME removed paths; only the agent guidance (docs/agents/**, regenerated into AGENTS.md/CLAUDE.md/GEMINI.md) and all
// code/config/scripts are held to the no-dangling-reference standard.
const SCAN_EXCLUDE = [
  /^docs\/(?!agents\/)/,
  /^\.council\//,
  /^rust\/third_party\//,
  /^protocol\//,
  /^package-lock\.json$/,
];
const TEXT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|yml|yaml|toml|txt|cjs|sh|ps1|rs|sql)$/i;

/** Tokens that identify a deleted path inside another file. Each token contains at least one '/'. */
export function referenceTokens(path) {
  const tokens = new Set();
  const noExt = path.replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, "");
  const parts = path.split("/");
  if (parts.length < 2) {
    tokens.add(path);
    return [...tokens];
  }
  tokens.add(path);
  if (noExt !== path) {
    tokens.add(`${noExt}.js`);
    tokens.add(noExt);
  }
  // The last two segments as an import tail: `tui/foo.js`, `tui/foo` — how cross-directory ESM imports look.
  const tail = parts.slice(-2).join("/");
  const tailNoExt = tail.replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, "");
  tokens.add(tail);
  if (tailNoExt !== tail) {
    tokens.add(`${tailNoExt}.js`);
    tokens.add(tailNoExt);
  }
  return [...tokens];
}

/** First occurrence of `token` not glued to a word char on EITHER side (so `xtui/foo.js` never matches
 * `tui/foo.js`, and `dir/foo-lane` never matches `dir/foo` — the trailing check was added in m0irai 3.6 after
 * four such prefix false positives). For dotfile-rooted tokens (`.codex/config.toml`) a preceding `/`,
 * `\`, `~` or `.` also disqualifies, so the HOME config `~/.codex/config.toml` never matches the deleted
 * repo-local file. Import tails preceded by `/` or followed by `.js`/`"` stay valid. */
function boundaryIndexOf(text, token) {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(token, from);
    if (idx < 0) return -1;
    const prev = idx === 0 ? "" : text[idx - 1];
    const next = text[idx + token.length] ?? "";
    const glued =
      /[A-Za-z0-9_-]/.test(prev) ||
      /[A-Za-z0-9_-]/.test(next) ||
      (token.startsWith(".") && /[/\\~.]/.test(prev));
    if (!glued) return idx;
    from = idx + 1;
  }
}

function tracked(root) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/** Tokens to search for one deletion entry: `scan:false` entries yield none (dotfile-config conventions — existence
 * check only); a relocated file skips tokens its NEW path also contains (its consumer was repointed to that path). */
function tokensFor(entry) {
  if (entry.scan === false) return [];
  const moved = typeof entry.relocatedTo === "string" ? entry.relocatedTo : undefined;
  return referenceTokens(entry.path).filter((t) => t.includes("/") && !moved?.includes(t));
}

/** First reference (file:line) to `entry` in `contents`, per scanned file. */
function findReferences(entry, contents) {
  const hits = [];
  const tokens = tokensFor(entry);
  for (const [p, text] of contents) {
    const t = tokens.find((token) => boundaryIndexOf(text, token) >= 0);
    if (t === undefined) continue;
    const line = text.slice(0, boundaryIndexOf(text, t)).split("\n").length;
    hits.push(`${p}:${String(line)} references deleted ${entry.path} via "${t}"`);
  }
  return hits;
}

/** FL-174, the reverse check: every path the committed tracked-surface.json inventory once listed but
 *  `trackedNow` (current `git ls-files`) no longer has, and `deletionPaths` (deletions.json's own path
 *  list) never recorded — a file that left the tree through a tracked-surface `--update` with no
 *  deletions.json entry ever written. Pure so the sibling test builds a fixture without touching disk. */
export function findUnrecordedRemovals(inventoryPaths, trackedNow, deletionPaths) {
  const trackedSet = new Set(trackedNow);
  const deletedSet = new Set(deletionPaths);
  return inventoryPaths.filter((p) => !trackedSet.has(p) && !deletedSet.has(p));
}

// B1-R2 (round 3): must match verify-staged.mjs's own PREV_TRACKED_SURFACE_OVERRIDE constant exactly --
// that script writes this file, relative to the stage root, AFTER `git add -A` has already run there, so
// it stays untracked and invisible to every git-based gate that walks `git ls-files`.
const PREV_TRACKED_SURFACE_OVERRIDE = ".verify-logs/prev-tracked-surface.json";

/** `raw` (the previous inventory JSON) parsed and validated. Throws — never silently drops to [] — because
 *  by the time this runs the content source (a real HEAD revision, or verify-staged's override file) was
 *  already confirmed to exist; a syntax error or missing "paths" array at that point is corruption, not
 *  "nothing to compare", and B1-R2 exists precisely because this function used to treat every failure mode
 *  the same way. */
function parseTrackedSurfacePaths(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `GATE FAIL cut-closure: ${source} is not valid JSON (B1-R2 fail-closed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed.paths))
    throw new Error(`GATE FAIL cut-closure: ${source} has no "paths" array (B1-R2 fail-closed)`);
  return parsed.paths;
}

/** B1: the PREVIOUS COMMIT's tracked-surface.json — the only source still holding a path after a
 *  `--update` has already scrubbed it from the working-tree copy.
 *  B1-R2 (round 3, CONFIRMED): `git show HEAD:...` cannot work at all inside `verify:staged`'s stage --
 *  that stage is a FRESH `git init` with a staged index and ZERO commits, so `HEAD` is not a ref that
 *  resolves there no matter how much real history the ORIGINAL repo has. The old code's blanket
 *  `catch { return []; }` made that structural impossibility indistinguishable from the legitimate case
 *  "HEAD exists, but this file wasn't tracked yet at that revision" — so the FL-174 reverse check was
 *  silently a no-op on every staged run, and a deletion baked into the very commit being verified, with
 *  no deletions.json record, sailed through both `verify:staged` and the post-commit `--assert-head` gate.
 *  Fixed: `verify-staged.mjs` writes the real repo's previous inventory into the stage at
 *  PREV_TRACKED_SURFACE_OVERRIDE before any gate runs there; this function checks that path FIRST. Absent
 *  the override (a plain worktree or CI checkout, not a stage), it falls back to `git show HEAD:...`, but
 *  now distinguishes "no HEAD ref at all" — fail closed, this IS the staged-tree bug shape and must never
 *  be silently treated as "nothing to compare" — from "HEAD exists, path just wasn't tracked yet there",
 *  which legitimately has nothing to compare and returns []. */
function readPreviousTrackedSurfacePaths(root) {
  const overridePath = resolve(root, PREV_TRACKED_SURFACE_OVERRIDE);
  if (existsSync(overridePath))
    return parseTrackedSurfacePaths(readFileSync(overridePath, "utf8"), overridePath);
  try {
    execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, encoding: "utf8" });
  } catch {
    throw new Error(
      `GATE FAIL cut-closure: no HEAD commit and no ${PREV_TRACKED_SURFACE_OVERRIDE} override (B1-R2 fail-closed) — the FL-174 reverse check has no previous inventory to compare against and cannot be silently skipped; a verify:staged run must write the override before this gate runs`,
    );
  }
  let raw;
  try {
    raw = execFileSync("git", ["show", `HEAD:${TRACKED_SURFACE}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return []; // HEAD exists; this file just wasn't tracked yet at that revision -- legitimately nothing to compare.
  }
  return parseTrackedSurfacePaths(raw, `HEAD:${TRACKED_SURFACE}`);
}

export function checkCutClosure(root = process.cwd()) {
  const file = resolve(root, DELETIONS);
  if (!existsSync(file)) throw new Error(`${DELETIONS} missing`);
  const entries = JSON.parse(readFileSync(file, "utf8")).entries ?? [];
  const files = tracked(root);
  const trackedSet = new Set(files);
  const stillTracked = entries.map((e) => e.path).filter((p) => trackedSet.has(p));
  const scanFiles = files.filter((p) => TEXT_EXT.test(p) && !SCAN_EXCLUDE.some((r) => r.test(p)));
  const contents = new Map(scanFiles.map((p) => [p, readFileSync(resolve(root, p), "utf8")]));
  const hits = entries.flatMap((e) => findReferences(e, contents));
  const deletionPaths = entries.map((e) => e.path);
  const unrecordedRemovals = findUnrecordedRemovals(
    readPreviousTrackedSurfacePaths(root),
    files,
    deletionPaths,
  );
  const problems = [];
  if (stillTracked.length)
    problems.push(
      `recorded as deleted but still tracked: ${stillTracked.length}\n  ${stillTracked.slice(0, 30).join("\n  ")}`,
    );
  if (hits.length)
    problems.push(
      `references to deleted paths: ${hits.length}\n  ${hits.slice(0, 60).join("\n  ")}${hits.length > 60 ? "\n  …" : ""}`,
    );
  if (unrecordedRemovals.length)
    problems.push(
      `tracked-surface.json lists path(s) no longer tracked, with no deletions.json record (FL-174): ${unrecordedRemovals.length}\n  ${unrecordedRemovals.slice(0, 30).join("\n  ")}`,
    );
  if (problems.length) throw new Error(`GATE FAIL cut-closure:\n${problems.join("\n")}`);
  return { ok: true, deletions: entries.length, scanned: scanFiles.length };
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const r = checkCutClosure(process.cwd());
    process.stdout.write(
      `cut-closure gate passed: ${String(r.deletions)} recorded deletions, ${String(r.scanned)} files scanned, no dangling reference\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
