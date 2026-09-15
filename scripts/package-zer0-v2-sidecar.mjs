/**
 * @file scripts/package-zer0-v2-sidecar.mjs
 * @purpose Stage the compiled Zer0 V2 Node room host beside the Rust binary.
 * @exports stageZer0V2Sidecar, assertProductionJavaScript, assertProductionTree, assertStagedRuntime
 * @depends node:child_process, node:fs/promises, node:path, node:url
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED_HOST = join("dist", "src", "room", "zer0-v2-host.js");
// The detached digest child the room close path forks. It is resolved at runtime as digest-runner's own
// sibling, so no import names it and nothing but this requirement notices when a package ships without it.
const COMPILED_DIGEST_ENTRY = join("dist", "src", "memory", "digest-entry.js");
const COMPILED_EXTENSIONS = [".js", ".mjs", ".cjs"];
const SIDECAR_DIRECTORY = "zer0-v2-node";
const LAUNCHER_NAME = "zer0-v2-host.mjs";
const PRODUCTION_SCRIPTS = [
  "patch-lifecycle.mjs",
  "patch-contracts.mjs",
  "patch-state.mjs",
  "patch-state-files.mjs",
  "patch-state-worker.mjs",
  "patch-write.mjs",
];

/**
 * Builds and stages a self-contained Node runtime layout at `releaseDirectory`.
 * The launcher imports only compiled JavaScript. Production dependencies are
 * installed under the staged Node root, so Node resolves them from that root
 * rather than from the source checkout.
 */
export async function stageZer0V2Sidecar(releaseDirectory, { install = true } = {}) {
  const releaseRoot = resolve(releaseDirectory);
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:production"],
    sourceRoot,
  );

  const compiledHost = join(sourceRoot, COMPILED_HOST);
  await requireFile(compiledHost, "compiled room host");
  await requireFile(join(sourceRoot, COMPILED_DIGEST_ENTRY), "compiled digest entry");
  await assertProductionJavaScript(compiledHost);

  const stagedNodeRoot = join(releaseRoot, SIDECAR_DIRECTORY);
  await rm(stagedNodeRoot, { recursive: true, force: true });
  await mkdir(stagedNodeRoot, { recursive: true });
  await cp(join(sourceRoot, "dist"), join(stagedNodeRoot, "dist"), { recursive: true });
  await assertStagedRuntime(stagedNodeRoot);
  await copyAllowedFiles("scripts", PRODUCTION_SCRIPTS, stagedNodeRoot);
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const productionPatches = requireSafeFileList(sourcePackage.zer0Patches, "zer0Patches");
  await copyAllowedFiles("patches", productionPatches, stagedNodeRoot);
  await writeFile(
    join(stagedNodeRoot, "package.json"),
    `${JSON.stringify(productionPackageManifest(sourcePackage), null, 2)}\n`,
    "utf8",
  );
  await cp(join(sourceRoot, "package-lock.json"), join(stagedNodeRoot, "package-lock.json"));

  const launcher = join(releaseRoot, LAUNCHER_NAME);
  await writeFile(launcher, productionLauncherSource(), "utf8");
  await assertProductionJavaScript(launcher);

  if (install)
    await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--omit=dev"],
      stagedNodeRoot,
    );
  return {
    launcher,
    compiledHost: join(stagedNodeRoot, COMPILED_HOST),
    compiledDigestEntry: join(stagedNodeRoot, COMPILED_DIGEST_ENTRY),
    stagedNodeRoot,
  };
}

/**
 * Everything the SHIPPED Node root must satisfy: the detached digest entry is present, and the whole
 * compiled tree is free of any TypeScript runtime reference — not just the host file. The host was the only
 * file checked until the digest wiring gave the package a second executable entry; a ratchet over the tree
 * is what makes a third one safe by default.
 */
export async function assertStagedRuntime(stagedNodeRoot) {
  await requireFile(join(stagedNodeRoot, COMPILED_DIGEST_ENTRY), "compiled digest entry");
  await assertProductionTree(join(stagedNodeRoot, "dist"));
}

/** Applies assertProductionJavaScript to every compiled file under `root`, recursively. */
export async function assertProductionTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pathname = join(root, entry.name);
    if (entry.isDirectory()) await assertProductionTree(pathname);
    else if (COMPILED_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
      await assertProductionJavaScript(pathname);
  }
}

async function copyAllowedFiles(directory, filenames, stagedNodeRoot) {
  const destination = join(stagedNodeRoot, directory);
  await mkdir(destination, { recursive: true });
  for (const filename of filenames)
    await cp(join(sourceRoot, directory, filename), join(destination, filename));
}

function requireSafeFileList(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (filename) =>
        typeof filename !== "string" ||
        filename.length === 0 ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename === "." ||
        filename === "..",
    )
  )
    throw new Error(`${label} must be a non-empty list of safe filenames`);
  return value;
}

function productionPackageManifest(source) {
  return {
    name: source.name,
    version: source.version,
    private: true,
    license: source.license,
    type: "module",
    engines: source.engines,
    zer0Patches: source.zer0Patches,
    scripts: { postinstall: "node scripts/patch-lifecycle.mjs install" },
    dependencies: source.dependencies,
    overrides: source.overrides,
  };
}

function productionLauncherSource() {
  return [
    "#!/usr/bin/env node",
    "// Generated room-host launcher. Do not replace with a development runtime.",
    `import { runZer0V2Host } from \"./${SIDECAR_DIRECTORY}/${COMPILED_HOST.replaceAll("\\", "/")}\";`,
    "runZer0V2Host();",
    "",
  ].join("\n");
}

// A runtime TypeScript reference in compiled output can only appear as a module SPECIFIER, so that is
// exactly what these match: a quoted path naming a TypeScript source (with or without a `?query` suffix),
// the tsx loader as a bare specifier or a path segment, or ts-node in any quoted specifier. The earlier
// bare-word patterns (/\btsx\b/, /\.ts["']/) also matched ENGLISH: 27 of the compiled files carry prose like
// "driver-boot.ts's own misuse" or "(cockpit.tsx's seedCockpitState)", so extending the check from the one
// host file to the whole tree was impossible without this precision.
//
// Backticks (codex #13) need one more turn of the screw. A template literal IS a valid dynamic specifier —
// import(`./entry.ts`) — but a backtick is also how this codebase quotes filenames in prose, and two
// compiled files carry exactly that (`native-mode.ts`, an @example path). So a template literal counts only
// where a specifier can go: directly inside import( or require(. Measured on the current dist: 0 of 177
// files match any of these, while the sibling test's eleven planted references all still fail.
//
// Stated limitation, unchanged by this round: a specifier assembled at runtime (`./entry${extension}`)
// evades every pattern here. That is deliberate — digest-runner resolves its sibling entry exactly that
// way so the same source works compiled and under a loader — and it is why the packaging assertion is a
// ratchet against accidental references, not a proof of their absence.
const PROHIBITED_RUNTIME_REFERENCES = [
  /["'][^"'\s]*\.tsx?(?:\?[^"'\s]*)?["']/i,
  /["'](?:[^"'\s]*[/\\])?tsx(?:[/\\][^"'\s]*)?["']/i,
  /["'][^"'\s]*ts-node[^"'\s]*["']/i,
  /\b(?:import|require)\s*\(\s*`(?:[^`\s]*\.tsx?(?:\?[^`\s]*)?|(?:[^`\s]*[/\\])?tsx(?:[/\\][^`\s]*)?|[^`\s]*ts-node[^`\s]*)`/i,
];

export async function assertProductionJavaScript(pathname) {
  const source = await readFile(pathname, "utf8");
  const match = PROHIBITED_RUNTIME_REFERENCES.find((expression) => expression.test(source));
  if (match !== undefined)
    throw new Error(
      `production sidecar must not contain a TypeScript runtime reference (${match}) in ${pathname}`,
    );
}

async function requireFile(pathname, description) {
  try {
    await access(pathname, constants.R_OK);
  } catch {
    throw new Error(`${description} is missing: ${pathname}`);
  }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const executableArgs = windows ? ["/d", "/s", "/c", `${command} ${args.join(" ")}`] : args;
    const child = spawn(executable, executableArgs, {
      cwd,
      stdio: "inherit",
      // Windows resolves npm through a .cmd shim; invoke the fixed command
      // through cmd.exe without enabling Node's shell interpolation mode.
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseDirectory = process.argv[2];
  if (releaseDirectory === undefined)
    throw new Error(
      "usage: node scripts/package-zer0-v2-sidecar.mjs <release-directory> [--no-install]",
    );
  void stageZer0V2Sidecar(releaseDirectory, { install: process.argv[3] !== "--no-install" }).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
