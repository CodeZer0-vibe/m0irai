/**
 * @file scripts/gate-tracked-surface.mjs
 * @purpose The tracked-surface guard (plan v5 Phase 2.6 / 7.2). `docs/provenance/tracked-surface.json` is an EXACT
 *   inventory of tracked paths plus a policy (`work` | `final`). Default mode fails on (a) any tracked path not in
 *   the inventory or inventory path no longer tracked — unreviewed drift; every cut updates the inventory in the
 *   same commit via `--update` — and (b) any tracked path matching a forbidden root/pattern for the policy
 *   (`work`: runtime/private/build roots and databases/logs; `final` additionally: historical docs beyond the
 *   allow-list and machine-local absolute paths). Empty inventories are a failure (a guard that passes on nothing
 *   is not a guard). Tracked = `git ls-files` (index), so it works before the first commit.
 *   R5-F5 (M4 reviewer finding, H2 item 5): `git ls-files` lists an UNMERGED path once per index stage during an
 *   unresolved merge (verified live: 1 conflicted file -> 3 rows), so `--update` run mid-conflict wrote duplicate
 *   rows into the committed inventory — live case docs/provenance/tracked-surface.json at commit fd389e7 on
 *   branch m4-file-projection, three paths duplicated, `count` computed from the already-duplicated array so it
 *   agreed with the corrupt `paths.length` and gave no signal either. The old verify path compared Sets
 *   (`new Set(inv.paths)`), which can never see a duplicate — a Set erases the very fact this check exists to
 *   catch. `tracked()` now passes `--deduplicate` (git's own fix for this exact `-z`-mode stage quirk) so a
 *   future `--update` mid-conflict can no longer write one; the verify path separately fails closed on any
 *   duplicate row already sitting in the committed inventory, and on `count !== paths.length`.
 *   I5-1 (round 2, second occurrence of the R5-F5 class the same day — the operator's own D-merge incident
 *   wrote 2170 duplicated rows via `--update` on an unmerged index): `--deduplicate` fixes the ROW COUNT but
 *   an unresolved merge is still an invalid moment to trust `git ls-files` for either mode. A modify/delete
 *   conflict (verified live: `git ls-files -u` shows stage 1 + stage 3, no stage 2 — "ours" deleted it) is
 *   the sharpest case: `--update` writes the path as tracked while the natural resolution is about to delete
 *   it, the gate then fails "no longer tracked" once the conflict resolves, and the operator's next
 *   `--update` scrubs it silently — composing with a fresh FL-174 gap. Both modes now refuse closed, by
 *   name, whenever `git ls-files -u` is non-empty — before `tracked()` is even called.
 *   I5-2: the count check used to fail OPEN whenever `count` was anything other than a number that disagreed
 *   with `paths.length` — missing, a string, `null`, `NaN` all passed silently. Fixed to require
 *   `Number.isInteger(count)` first.
 * @exports checkTrackedSurface, FORBIDDEN_WORK, FORBIDDEN_FINAL, findDuplicates, collectVerifyProblems,
 *   tracked
 * @depends node:child_process, node:fs, node:path, node:url
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY = "docs/provenance/tracked-surface.json";
export const FORBIDDEN_WORK = [
  // `.council/` HISTORICAL material is retained under `work` until its last consumer is cut (rule 4); its RUNTIME roots
  // (what the room writes) are forbidden everywhere; `final` forbids all of `.council/`.
  /^\.zer0\//,
  /^\.council\/(runs|logs)\//,
  /^\.council\/\.tool-sequence\.log$/,
  /^\.council\/\.grounding-/,
  /^codex review\//,
  /^dist\//,
  /^target\//,
  /^rust\/target\//,
  /^node_modules\//,
  /(^|\/)node_modules\//,
  /^\.cache\//,
  /^\.verify-logs\//,
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.sqlite$/,
  /\.log$/,
  /^\.codex\//,
  /^\.gemini\//,
  /^scratch\//,
];
const FINAL_DOC_ALLOW = [
  /^README\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^GEMINI\.md$/,
  /^NOTICE$/,
  /^LICENSE$/,
  /^CONTRIBUTING\.md$/,
  /^SECURITY\.md$/,
  /^docs\/STATE\.md$/,
  /^docs\/agents\//,
  /^docs\/provenance\//,
  /^docs\/specs\/2026-08-17-m0irai-standalone-plan-v5\.md$/,
  /^protocol\//,
  /^rust\//,
];
export const FORBIDDEN_FINAL = [/^ROUND_TABLE\.md$/, /^docker-compose\.yml$/, /^\.council\//];

/** I5-1: every path the index currently holds unresolved (any conflict stage present), deduped, sorted.
 *  `git ls-files -u -z` emits `mode SP sha SP stage TAB path`, NUL-separated; the path is everything
 *  after the first tab (verified live: a modify/delete conflict has no space in the mode/sha/stage
 *  prefix, so the first tab is always the field boundary, never inside the path itself on this repo's
 *  paths — none contain a literal tab byte). */
function unmergedPaths(root) {
  const out = execFileSync("git", ["ls-files", "-u", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = new Set();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    paths.add(record.slice(tab + 1));
  }
  return [...paths].sort();
}

/** I5-1: refuses BOTH modes, by name, whenever the index has an unresolved conflict — the moment
 *  `git ls-files` (deduplicated or not) cannot be trusted for either the write path or the verify path. */
function assertNoUnmergedPaths(root, update) {
  const unmerged = unmergedPaths(root);
  if (unmerged.length === 0) return;
  throw new Error(
    `GATE FAIL tracked-surface: refusing to ${update ? "--update" : "verify"} against an unresolved merge (git ls-files -u non-empty) (I5-1): ${unmerged.length}\n  ${unmerged.join("\n  ")}`,
  );
}

/** Every tracked path, deduplicated. Exported (N1, round 3): I5-1 means `checkTrackedSurface` now
 *  refuses BEFORE this ever runs on an unresolved index, so the --deduplicate mechanism below is
 *  unreachable through the gate mid-conflict — this export is what lets the sibling test defend
 *  --deduplicate DIRECTLY (call tracked() on a real conflicted repo, assert one row per path) instead of
 *  only through raw git commands that never touch this function at all. */
export function tracked(root) {
  // --deduplicate: git's own fix for the `-z`-mode stage quirk (R5-F5) — during an unresolved merge an
  // unmerged path is listed once per index stage; without this flag the generator would write the same
  // path into the inventory multiple times.
  const out = execFileSync("git", ["ls-files", "-z", "--deduplicate"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).sort();
}

/** Every value that appears more than once in `list`, sorted, each once. Pure so the sibling test can
 *  prove it against a fixture without a real repo. */
export function findDuplicates(list) {
  const seen = new Map();
  for (const item of list) seen.set(item, (seen.get(item) ?? 0) + 1);
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([item]) => item)
    .sort();
}

/** R5-F5, second layer: `tracked()` already dedupes at the source (--deduplicate); this refuses the
 *  write itself if `now` is ever corrupt anyway, so a future git-flag regression or an unrelated change
 *  to `tracked()` cannot silently reopen the hole. Throws instead of returning, matching the caller's
 *  fail-closed contract for the write path. */
function assertWritable(now) {
  const nowDuplicates = findDuplicates(now);
  if (nowDuplicates.length)
    throw new Error(
      `GATE FAIL tracked-surface: refusing to write duplicate row(s) even after --deduplicate: ${nowDuplicates.length}\n  ${nowDuplicates.slice(0, 40).join("\n  ")}`,
    );
}

function updateInventory(file, now) {
  assertWritable(now);
  const prev = safeRead(file);
  const policy = prev?.policy ?? "work";
  writeFileSync(file, `${JSON.stringify({ policy, count: now.length, paths: now }, null, 2)}\n`);
  return { ok: true, updated: true, count: now.length, policy };
}

function finalPolicyViolations(now, policy) {
  if (policy !== "final") return [];
  return now.filter(
    (p) =>
      FORBIDDEN_FINAL.some((r) => r.test(p)) ||
      (/^docs\//.test(p) && !FINAL_DOC_ALLOW.some((r) => r.test(p))) ||
      (/\.md$/.test(p) && !/\//.test(p) && !FINAL_DOC_ALLOW.some((r) => r.test(p))),
  );
}

/** Every problem the verify path can name for one comparison of `inv` (the committed inventory) against
 *  `now` (this run's `git ls-files --deduplicate`). Pure and exported so a fixture test can drive it
 *  directly without a real repo on disk. R5-F5's duplicate/count checks run over the RAW arrays: the
 *  extra/missing comparison above them is Set-based and can never see a duplicate row (a Set erases
 *  repeats), which is exactly how the live incident passed silently before this fix. */
export function collectVerifyProblems(inv, now, policy) {
  const invSet = new Set(inv.paths);
  const nowSet = new Set(now);
  const extra = now.filter((p) => !invSet.has(p));
  const missing = inv.paths.filter((p) => !nowSet.has(p));
  const forbidden = now.filter((p) => FORBIDDEN_WORK.some((r) => r.test(p)));
  const inventoryDuplicates = findDuplicates(inv.paths);
  const nowDuplicates = findDuplicates(now);
  // I5-2: fail CLOSED on anything that is not a finite integer equal to paths.length — a missing,
  // stringly-typed, null or NaN `count` used to slip past the old `typeof === "number"` guard silently.
  const countMismatch = !Number.isInteger(inv.count) || inv.count !== inv.paths.length;
  const finalViolations = finalPolicyViolations(now, policy);
  const problems = [];
  if (extra.length)
    problems.push(
      `tracked but not in inventory (unreviewed drift): ${extra.length}\n  ${extra.slice(0, 40).join("\n  ")}${extra.length > 40 ? "\n  …" : ""}`,
    );
  if (missing.length)
    problems.push(
      `in inventory but no longer tracked: ${missing.length}\n  ${missing.slice(0, 40).join("\n  ")}${missing.length > 40 ? "\n  …" : ""}`,
    );
  if (forbidden.length)
    problems.push(
      `forbidden paths tracked (${policy}): ${forbidden.length}\n  ${forbidden.slice(0, 40).join("\n  ")}`,
    );
  if (finalViolations.length)
    problems.push(
      `final-policy violations: ${finalViolations.length}\n  ${finalViolations.slice(0, 60).join("\n  ")}`,
    );
  if (inventoryDuplicates.length)
    problems.push(
      `inventory contains duplicate row(s) (R5-F5, likely an --update mid-unresolved-merge): ${inventoryDuplicates.length}\n  ${inventoryDuplicates.slice(0, 40).join("\n  ")}`,
    );
  if (nowDuplicates.length)
    problems.push(
      `git ls-files --deduplicate still returned duplicate row(s) (R5-F5): ${nowDuplicates.length}\n  ${nowDuplicates.slice(0, 40).join("\n  ")}`,
    );
  if (countMismatch)
    problems.push(
      `inventory count field (${String(inv.count)}) does not match paths.length (${String(inv.paths.length)})`,
    );
  return problems;
}

export function checkTrackedSurface(root = process.cwd(), { update = false } = {}) {
  assertNoUnmergedPaths(root, update);
  const now = tracked(root);
  const file = resolve(root, INVENTORY);
  if (update) return updateInventory(file, now);
  const inv = safeRead(file);
  if (!inv || !Array.isArray(inv.paths) || inv.paths.length === 0)
    throw new Error(
      `${INVENTORY} missing or empty — run with --update after reviewing the tracked set`,
    );
  const policy = inv.policy === "final" ? "final" : "work";
  const problems = collectVerifyProblems(inv, now, policy);
  if (problems.length)
    throw new Error(`GATE FAIL tracked-surface (${policy}):\n${problems.join("\n")}`);
  return { ok: true, count: now.length, policy };
}

function safeRead(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const r = checkTrackedSurface(process.cwd(), { update: process.argv.includes("--update") });
    process.stdout.write(
      `tracked-surface ${r.updated ? "updated" : "gate passed"}: ${String(r.count)} paths, policy=${r.policy}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
