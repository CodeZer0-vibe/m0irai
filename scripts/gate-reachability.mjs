/**
 * @file scripts/gate-reachability.mjs
 * @purpose The reachability guard (plan v5 3.8): every production TypeScript file under src/ must be either
 *   (a) in the production program (`tsc -p tsconfig.production.json --listFiles`, the compiler's own closure from
 *   the declared roots), or (b) a DECLARED test-support/fixture file. Anything else is an orphan and fails the
 *   gate — so a file can never quietly stay tracked without a consumer. A declared test-support file that turns
 *   out to be IN the program is a stale declaration and fails too. Nonzero floors catch a broken tsc invocation
 *   (an empty program would otherwise make everything an orphan — loud — but an empty inventory would pass —
 *   silent; both are floored).
 * @exports checkReachability, listProductionProgram, DECLARED_TEST_SUPPORT
 * @depends node:child_process, node:fs, node:path, node:url
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Production TS that is tracked on purpose but must NOT be in the compiled program: test support + fixtures. */
export const DECLARED_TEST_SUPPORT = [
  "src/room/room-host-process.ts", // spawns the real host for integration tests
  "src/memory/baseline-fixture.ts", // pinned pre-unit baseline for memory tests
  "src/memory/digest-evidence.ts", // real-child evidence reader for digest tests (Phase 5)
];
const FIXTURE_SUFFIX = ".fixtures.ts";
const MIN_PROGRAM_FILES = 120; // measured 171 (3.6) → 177 (Phase 5c, 2026-08-19); below this = a broken tsc invocation
const MIN_INVENTORY_FILES = 120; // measured 182 (Phase 5c); below this = a broken git ls-files

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}

/** The compiler's own production closure, as repo-relative posix paths under src/. */
export function listProductionProgram(root = process.cwd()) {
  const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error(`typescript not installed at ${tsc}`);
  const out = execFileSync(
    process.execPath,
    [tsc, "-p", "tsconfig.production.json", "--noEmit", "--listFiles"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  const rootPosix = resolve(root).replaceAll("\\", "/").toLowerCase();
  const files = new Set();
  for (const line of out.split(/\r?\n/)) {
    const posix = line.trim().replaceAll("\\", "/");
    if (!posix.toLowerCase().startsWith(`${rootPosix}/src/`)) continue;
    files.add(posix.slice(rootPosix.length + 1));
  }
  return files;
}

/** Tracked production TS under src/ (tests and .d.ts excluded). */
export function listProductionInventory(root = process.cwd()) {
  return git(["ls-files", "-z", "src/**/*.ts"], root)
    .split("\0")
    .filter((p) => p && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"));
}

/**
 * @param root - repo root
 * @param opts.program - injected program set (tests / falsifier); default = tsc
 * @param opts.inventory - injected inventory (tests / falsifier); default = git ls-files
 */
export function checkReachability(root = process.cwd(), opts = {}) {
  const program = opts.program ?? listProductionProgram(root);
  const inventory = opts.inventory ?? listProductionInventory(root);
  const problems = [];
  if (program.size < MIN_PROGRAM_FILES)
    problems.push(
      `production program lists ${program.size} src files (< floor ${MIN_PROGRAM_FILES}) — broken tsc invocation?`,
    );
  if (inventory.length < MIN_INVENTORY_FILES)
    problems.push(
      `inventory lists ${inventory.length} src files (< floor ${MIN_INVENTORY_FILES}) — broken git ls-files?`,
    );
  const declared = new Set(DECLARED_TEST_SUPPORT);
  const isDeclared = (p) => declared.has(p) || p.endsWith(FIXTURE_SUFFIX);
  const orphans = inventory.filter((p) => !program.has(p) && !isDeclared(p));
  const staleDeclared = inventory.filter((p) => isDeclared(p) && program.has(p));
  const missingDeclared = DECLARED_TEST_SUPPORT.filter((p) => !inventory.includes(p));
  if (orphans.length)
    problems.push(
      `tracked production files reachable from NO declared root (orphans): ${orphans.length}\n  ${orphans.join("\n  ")}`,
    );
  if (staleDeclared.length)
    problems.push(
      `declared test-support files that ARE in the production program (stale declaration): ${staleDeclared.join(", ")}`,
    );
  if (missingDeclared.length)
    problems.push(
      `declared test-support files not tracked (stale declaration): ${missingDeclared.join(", ")}`,
    );
  if (problems.length) throw new Error(`GATE FAIL reachability:\n${problems.join("\n")}`);
  return {
    ok: true,
    program: program.size,
    inventory: inventory.length,
    declared: inventory.filter(isDeclared).length,
  };
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    if (process.argv.includes("--falsify")) {
      // The must-fail: an injected tracked orphan MUST be reported. A passing falsifier is a red result.
      const program = listProductionProgram(process.cwd());
      const inventory = [...listProductionInventory(process.cwd()), "src/__planted_orphan__.ts"];
      let failed = false;
      try {
        checkReachability(process.cwd(), { program, inventory });
      } catch (error) {
        failed = String(error).includes("__planted_orphan__");
      }
      if (!failed)
        throw new Error("reachability falsifier: a planted tracked orphan was NOT reported");
      process.stdout.write("reachability falsifier: planted orphan reported (must-fail passed)\n");
    } else {
      const r = checkReachability(process.cwd());
      process.stdout.write(
        `reachability gate passed: program ${r.program} src files, inventory ${r.inventory}, declared test-support ${r.declared}, orphans 0\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
