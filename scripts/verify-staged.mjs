/**
 * @file scripts/verify-staged.mjs
 * @purpose `npm run verify:staged` — rule 3 of plan v5 ("no red commit"). Writes the INDEX as a tree (`git
 *   write-tree`), archives exactly that tree (EOL conversion off; .gitattributes inside the tree still apply) into a
 *   disposable root, runs `npm ci && npm run verify` there, and writes an EXTERNAL receipt
 *   `.verify-logs/receipts/<tree>.json` (gitignored — never inside the tree it describes). Untracked node_modules,
 *   dist or Cargo output in the working tree can therefore never make a commit look green. Cargo's target dir is a
 *   shared cache outside the tree (`.verify-logs/cargo-target`; fingerprints keep it honest); `npm ci` is always
 *   fresh. `--assert-head` checks that HEAD's tree has a green receipt (used by ship:gate and after each commit).
 *   B1-R2 (round 3): the stage is a fresh `git init` with a staged index and ZERO commits — `HEAD` cannot resolve
 *   there structurally, which used to make gate-cut-closure.mjs's FL-174 reverse check a silent no-op on every
 *   staged run. Fixed here by writing the real repo's previous tracked-surface.json into the stage at
 *   `.verify-logs/prev-tracked-surface.json`, after `git add -A` runs (so it stays untracked in the stage's own
 *   index) — see writePreviousTrackedSurfaceOverride. This never touches the receipt key: `tree` at line 58 is
 *   `git write-tree` on the REAL repo's index, computed before the stage directory even exists, so nothing done
 *   inside the stage afterward — this override write included — can change which receipt a given commit reads.
 * @exports verifyStaged, assertHeadReceipt, writePreviousTrackedSurfaceOverride, PREV_TRACKED_SURFACE_OVERRIDE
 * @depends node:child_process, node:fs, node:os, node:path, node:url
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RECEIPTS = ".verify-logs/receipts";
const CARGO_CACHE = ".verify-logs/cargo-target";
// B1-R2 (round 3): must match gate-cut-closure.mjs's own PREV_TRACKED_SURFACE_OVERRIDE constant exactly.
// The stage below is a fresh `git init` with zero commits, so `git show HEAD:...` can never resolve there;
// this is the real repo's previous tracked-surface.json, handed to the stage at a well-known path so the
// FL-174 reverse check has something to compare against instead of failing closed on every staged run.
export const PREV_TRACKED_SURFACE_OVERRIDE = ".verify-logs/prev-tracked-surface.json";
const TRACKED_SURFACE = "docs/provenance/tracked-surface.json";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** npm without a shell: through the running npm's own CLI script when we were started by npm (`npm_execpath`),
 * else the platform launcher via a shell (Windows `npm.cmd` needs one). */
function npmInvocation(npmArgs) {
  const cli = process.env.npm_execpath;
  if (cli !== undefined && cli.length > 0)
    return { cmd: process.execPath, args: [cli, ...npmArgs], shell: false };
  return { cmd: "npm", args: npmArgs, shell: process.platform === "win32" };
}

/** B1-R2: writes the REAL repo's previous tracked-surface.json into the stage at
 *  PREV_TRACKED_SURFACE_OVERRIDE, AFTER the stage's own `git add -A` has already run (so the file stays
 *  untracked there — invisible to `git ls-files` / `git write-tree` inside the stage, exactly like any
 *  other file no gate should count as part of the archived tree). If the real repo has no HEAD yet, or
 *  never tracked this file at HEAD, writes an explicit "nothing to compare" marker — the same content
 *  gate-cut-closure.mjs's own non-staged fallback already treats as legitimate — so the override file is
 *  ALWAYS present once the stage is built, and the gate's fail-closed path only ever fires on a real gap. */
export function writePreviousTrackedSurfaceOverride(root, stage) {
  const overridePath = join(stage, PREV_TRACKED_SURFACE_OVERRIDE);
  mkdirSync(dirname(overridePath), { recursive: true });
  let raw = '{"paths":[]}';
  try {
    raw = execFileSync("git", ["show", `HEAD:${TRACKED_SURFACE}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // No HEAD yet, or this file wasn't tracked at HEAD -- both legitimately mean "nothing to compare".
  }
  writeFileSync(overridePath, raw);
}

function runStep(label, npmArgs, cwd, env, log) {
  const started = Date.now();
  const inv = npmInvocation(npmArgs);
  const r = spawnSync(inv.cmd, inv.args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    shell: inv.shell,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(
    join(log, `${label.replace(/[^a-z0-9]+/gi, "-")}.log`),
    `${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`,
  );
  process.stdout.write(
    `[verify:staged] ${label}: exit ${String(r.status)} in ${String(seconds)}s\n`,
  );
  return { label, status: r.status, seconds };
}

export function verifyStaged(root = process.cwd(), { keep = false } = {}) {
  const tree = git(root, ["write-tree"]);
  const receipts = resolve(root, RECEIPTS);
  mkdirSync(receipts, { recursive: true });
  const cargoCache = resolve(root, CARGO_CACHE);
  mkdirSync(cargoCache, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "m0irai-staged-"));
  const log = join(receipts, `${tree}.logs`);
  mkdirSync(log, { recursive: true });
  const startedAt = new Date().toISOString();
  process.stdout.write(`[verify:staged] tree ${tree} → ${stage}\n`);
  const steps = [];
  let ok = false;
  try {
    // Archive exactly the index tree. -c core.autocrlf=false: no host-config EOL rewriting (F1); attributes in the tree still apply.
    const archive = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", tree],
      { cwd: root, maxBuffer: 1024 * 1024 * 1024 },
    );
    if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr.toString()}`);
    const untar = spawnSync("tar", ["-x", "-C", stage], {
      input: archive.stdout,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (untar.status !== 0) throw new Error(`tar extract failed: ${untar.stderr.toString()}`);
    // The archive IS the tracked set. Give it a throwaway index so every git-based gate (tracked-surface,
    // cut-closure, encoding) sees exactly what a checkout would — no gate needs a special "no git" mode.
    for (const args of [
      ["init", "-q"],
      ["-c", "core.autocrlf=false", "add", "-A"],
    ]) {
      const r = spawnSync("git", args, { cwd: stage, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in stage: ${r.stderr}`);
    }
    // B1-R2: must run AFTER `git add -A` above so the override file is never staged/tracked in the stage's
    // own index -- see writePreviousTrackedSurfaceOverride's own doc comment.
    writePreviousTrackedSurfaceOverride(root, stage);
    // The staged run inherits the ambient env unchanged (the Ink-era CI refusal left with the TUI; measured in 3.9:
    // the suite is green under CI=1), so a local proof and the GitHub run see the same environment shape.
    const env = { ...process.env, CARGO_TARGET_DIR: cargoCache };
    steps.push(runStep("npm ci", ["ci", "--no-audit", "--no-fund"], stage, env, log));
    if (steps.at(-1).status === 0)
      steps.push(runStep("npm run verify", ["run", "verify"], stage, env, log));
    ok = steps.length === 2 && steps.every((s) => s.status === 0);
  } catch (error) {
    steps.push({
      label: "setup",
      status: -1,
      seconds: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!keep) rmSync(stage, { recursive: true, force: true });
  }
  const receipt = {
    tree,
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    steps,
    stage: keep ? stage : undefined,
  };
  writeFileSync(join(receipts, `${tree}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `[verify:staged] ${ok ? "GREEN" : "RED"} — receipt ${RECEIPTS}/${tree}.json\n`,
  );
  return receipt;
}

export function assertHeadReceipt(root = process.cwd()) {
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const file = resolve(root, RECEIPTS, `${tree}.json`);
  if (!existsSync(file))
    throw new Error(
      `no verification receipt for HEAD tree ${tree} (${RECEIPTS}/${tree}.json) — run npm run verify:staged before committing`,
    );
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  if (receipt.ok !== true) throw new Error(`receipt for HEAD tree ${tree} is RED`);
  return { tree, receipt };
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    if (process.argv.includes("--assert-head")) {
      const { tree } = assertHeadReceipt(process.cwd());
      process.stdout.write(`HEAD tree ${tree} has a GREEN receipt\n`);
    } else {
      const r = verifyStaged(process.cwd(), { keep: process.argv.includes("--keep") });
      process.exitCode = r.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
