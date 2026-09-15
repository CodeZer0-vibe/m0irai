/**
 * @file scripts/verify-rust.mjs
 * @purpose `npm run verify:rust` — the Rust half of `npm run verify` (plan v5 §5), all `--locked`:
 *   metadata (workspace closed inside rust/), the whole-workspace test run, the room's seam proofs re-run on
 *   the ASCII glyph set (a legacy Windows console is a supported render path and the suite only ever
 *   exercised the modern one, which is how a chip pin that PANICS on ASCII shipped green), the feature-gated
 *   host lifecycle test (real Node host; needs `npm run build` — the test runs it itself), the feature-gated
 *   digest handoff test (F10: the close digest must outlive the packaged host's Job Object; same real-host
 *   requirement), release-dist build. The three counted steps fail if they execute ZERO tests. Prints one
 *   JSON summary line; exit 1 on the first failure. TEST SCOPE: `--workspace` — since Phase 4 the workspace
 *   IS the room's closure (20 members, pinned by rust/crates/zer0-v2-bin/tests/room_dependency_closure.rs);
 *   before Phase 4 only the room crates ran, because grok's dev-deps did not compile on Windows (K2: protoc).
 * @exports verifyRust
 * @depends node:child_process, node:fs, node:path, node:url
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUST_DIR = "rust";
const BIN = "m0irai";
const TEST_SCOPE = ["--workspace"];
/**
 * The one test the legacy-glyph step exists to run, named so the step cannot
 * go green without it. It lives in `room_scrollback`, the SECOND of that
 * step's two filters — the filter that was missing entirely until FL-141, and
 * the one a future rename would silently drop while `seam_tests` kept the
 * count healthy. If this test is renamed, rename it here too; a red gate
 * saying "never executed <name>" is the intended outcome of forgetting.
 */
const LEGACY_GLYPH_WITNESS = "the_cancelled_marker_survives_markdown_on_every_glyph_set";

function run(label, args, cwd, env) {
  const started = Date.now();
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  const result = spawnSync(cargo, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(
    `[verify:rust] ${label}: exit ${String(result.status)} in ${String(seconds)}s\n`,
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout.slice(-4000));
    process.stderr.write(result.stderr.slice(-8000));
  }
  return { label, status: result.status, seconds, stdout: result.stdout, stderr: result.stderr };
}

/** Assert every workspace member's manifest lives under rust/ (no path outside the tree). */
function assertClosed(metadataJson, rustRoot) {
  const md = JSON.parse(metadataJson);
  const byId = new Map(md.packages.map((p) => [p.id, p]));
  const outside = [];
  for (const id of md.workspace_members) {
    const manifest = byId.get(id)?.manifest_path ?? "";
    if (!resolve(manifest).toLowerCase().startsWith(resolve(rustRoot).toLowerCase()))
      outside.push(manifest);
  }
  if (outside.length > 0)
    throw new Error(`workspace member manifest outside rust/: ${outside.join(", ")}`);
  return { members: md.workspace_members.length, packages: md.packages.length };
}

/**
 * How many tests one cargo step actually EXECUTED, across every target it ran.
 *
 * Pure and exported so it can be unit-tested against CAPTURED cargo output: the
 * thing this has to get right is a shape of text, and the only honest fixture
 * for that is text cargo really printed.
 *
 * Reads EVERY `running N tests` line rather than the first. Each step here
 * covers one target today and prints exactly one such line; a step that ever
 * covered two would otherwise have its second target's zero hidden behind the
 * first target's healthy count.
 *
 * When the answer is zero, the caller is handed cargo's OWN line to quote.
 * "reported zero tests executed" against an output that already says
 * `ok. 0 passed; 0 failed` is the same sentence twice, and neither copy names
 * the target.
 *
 * A1 (H-0 r2): the feature-gated targets are now refused by cargo itself —
 * `required-features` in `crates/zer0-v2-bin/Cargo.toml` — so a missing
 * `--features test-support` can no longer reach this function at all; it fails
 * the step on a non-zero exit with the feature named. What still arrives here is
 * a FILTER that stopped matching: a renamed test, a moved module. Same defect
 * class, different door, and this is the door that stays open.
 */
export function executedCount(stdout) {
  const counts = [...stdout.matchAll(/running (\d+) tests?/g)].map((match) => Number(match[1]));
  if (counts.length === 0)
    return { ok: false, quote: "no `running N tests` line in cargo's output" };
  if (counts.some((count) => count === 0)) {
    const zero = /test result:[^\n]*\b0 passed[^\n]*/.exec(stdout);
    return { ok: false, quote: zero ? zero[0].trim() : "running 0 tests" };
  }
  return { ok: true, count: counts.reduce((total, value) => total + value, 0) };
}

/**
 * Run one cargo test step and assert it actually executed tests.
 *
 * Returns `{ ok: true, count }`, or `{ ok: false, reason }` for the caller to
 * finish on. Three steps need this exact shape — the two feature-gated tests and
 * the legacy-glyph run — and inlining the third copy pushed `verifyRust` past the
 * cognitive-complexity clamp. The clamp does not move to accommodate that; the
 * duplication comes out instead.
 *
 * A step that compiles, runs and executes NOTHING is a failure here on purpose:
 * a filter that stops matching is exactly how a gate silently stops guarding.
 *
 * `witness` is the half-dead case, and it is why zero-is-a-failure is not
 * enough. The legacy step passes TWO filters; if one of them stopped matching
 * — a module rename, a test moved — the other would still report a healthy
 * count and the gate would stay green over a hole. So the caller may name one
 * test that MUST appear in the run's output. Cargo prints a `test <path> ... ok`
 * line per executed test, so this proves the test ran, not merely that a filter
 * matched something.
 */
function countedTest(steps, label, args, rustRoot, env, witness) {
  steps.push(run(label, args, rustRoot, env));
  const last = steps.at(-1);
  if (last.status !== 0) return { ok: false };
  const executed = executedCount(last.stdout);
  if (!executed.ok)
    return { ok: false, reason: `${label} executed no tests — cargo said: ${executed.quote}` };
  if (witness && !last.stdout.includes(witness))
    return { ok: false, reason: `${label} never executed ${witness}` };
  return { ok: true, count: executed.count };
}

export function verifyRust(repoRoot = process.cwd()) {
  const rustRoot = resolve(repoRoot, RUST_DIR);
  if (!existsSync(resolve(rustRoot, "Cargo.toml")))
    throw new Error(`no ${RUST_DIR}/Cargo.toml under ${repoRoot}`);
  const targetDir = process.env.CARGO_TARGET_DIR ?? resolve(rustRoot, "target");
  mkdirSync(targetDir, { recursive: true });
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  const steps = [];
  const metadata = run(
    "cargo metadata --locked",
    ["metadata", "--locked", "--format-version", "1"],
    rustRoot,
    env,
  );
  steps.push(metadata);
  if (metadata.status !== 0) return finish(steps, false);
  const closure = assertClosed(metadata.stdout, rustRoot);
  process.stdout.write(
    `[verify:rust] workspace members=${String(closure.members)} packages=${String(closure.packages)} (all manifests under rust/)\n`,
  );
  steps.push(run("cargo test --workspace", ["test", "--locked", ...TEST_SCOPE], rustRoot, env));
  if (steps.at(-1).status !== 0) return finish(steps, false);
  // The room's seam and scrollback proofs, re-run on the ASCII glyph set. A
  // legacy Windows console is a supported render path and the suite only ever
  // exercised the modern one, which is how a chip pin that PANICS on ASCII
  // shipped green: it located a chip by searching the footer for the identity
  // glyph, and codex's ASCII glyph is `#`, which the metadata row also prints.
  // Re-executes the already-built test binary with one env var, so it costs
  // about a second.
  //
  // SCOPE: THE WHOLE CRATE, since 2026-09-02. It was the seam tests alone
  // until FL-141, and that gap let the identical defect through a second time
  // — a cancelled lane's marker was appended into a markdown message, where
  // codex's ASCII `#` was read as a heading and vanished from the row. The
  // test written to catch it lived in `room_scrollback`, so this step filtered
  // it out while its own doc comment claimed to run it. Adding that second
  // filter left the same hole one module further out: `room_runtime::tests`
  // was excluded because four of its assertions FAILED on this path — a
  // pre-existing gap this step was documenting rather than closing, and a
  // filtered gate is a gate that grows a blind spot every time someone writes
  // a test outside it. Codex measured the cost in a legacy console: the pager
  // suite came back 969 passed / 4 failed.
  //
  // Those four now pin both consoles explicitly (sealed-lanes #4), so the
  // filters come off and the crate runs whole. `--lib` stays: the integration
  // targets spawn a real pager binary and have nothing to do with glyphs.
  const legacy = countedTest(
    steps,
    "cargo test -p xai-grok-pager --lib (legacy console glyphs)",
    ["test", "--locked", "-p", "xai-grok-pager", "--lib"],
    rustRoot,
    { ...env, GROK_FORCE_LEGACY_CONSOLE: "1" },
    LEGACY_GLYPH_WITNESS,
  );
  if (!legacy.ok) return finish(steps, false, legacy.reason);
  const lifecycle = countedTest(
    steps,
    "cargo test host_lifecycle (test-support)",
    [
      "test",
      "--locked",
      "-p",
      "zer0-v2-bin",
      "--features",
      "test-support",
      "--test",
      "host_lifecycle",
    ],
    rustRoot,
    env,
  );
  if (!lifecycle.ok) return finish(steps, false, lifecycle.reason);
  const handoff = countedTest(
    steps,
    "cargo test digest_handoff (test-support)",
    [
      "test",
      "--locked",
      "-p",
      "zer0-v2-bin",
      "--features",
      "test-support",
      "--test",
      "digest_handoff",
    ],
    rustRoot,
    env,
  );
  if (!handoff.ok) return finish(steps, false, handoff.reason);
  steps.push(
    run(
      "cargo build --profile release-dist",
      ["build", "--locked", "-p", "zer0-v2-bin", "--profile", "release-dist"],
      rustRoot,
      env,
    ),
  );
  if (steps.at(-1).status !== 0) return finish(steps, false);
  const exe = resolve(targetDir, "release-dist", process.platform === "win32" ? `${BIN}.exe` : BIN);
  if (!existsSync(exe)) return finish(steps, false, `release-dist binary missing: ${exe}`);
  const bytes = statSync(exe).size;
  return finish(steps, true, undefined, {
    exe,
    bytes,
    closure,
    legacyGlyphTests: legacy.count,
    lifecycleTests: lifecycle.count,
    handoffTests: handoff.count,
  });
}

function finish(steps, ok, reason, extra = {}) {
  const summary = {
    ok,
    reason,
    steps: steps.map(({ label, status, seconds }) => ({ label, status, seconds })),
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  try {
    const summary = verifyRust(process.cwd());
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
