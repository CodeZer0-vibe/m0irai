import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  assertProductionJavaScript,
  assertStagedRuntime,
  stageZer0V2Sidecar,
} from "./package-zer0-v2-sidecar.mjs";

const roots = [];
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([
  ["tsx", 'import "tsx";'],
  ["ts-node", 'import "ts-node/register";'],
  ["a double-quoted TypeScript source", 'import "./host.ts";'],
  ["a single-quoted TypeScript source", "import './host.ts';"],
  ["a tsx loader path", 'await import("/x/node_modules/tsx/dist/esm/index.mjs");'],
  ["a TSX source", 'import "./cockpit.tsx";'],
  ["a template-literal TypeScript source", "await import(`./entry.ts`);"],
  ["a template-literal tsx module", "require(`tsx`);"],
  ["a template-literal loader path", "await import(`/x/node_modules/tsx/dist/esm/index.mjs`);"],
  ["a template-literal ts-node", "require(`ts-node/register`);"],
  ["a query-suffixed TypeScript source", 'import "./x.ts?raw";'],
  ["a query-suffixed TSX source", 'import "./x.tsx?v=1";'],
])("RED: rejects %s as a production runtime reference", async (_description, source) => {
  const candidate = await fixtureFile(source);

  await expect(assertProductionJavaScript(candidate)).rejects.toThrow(
    "production sidecar must not contain",
  );
});

it("accepts a compiled JavaScript import", async () => {
  const candidate = await fixtureFile('import "./host.js";');

  await expect(assertProductionJavaScript(candidate)).resolves.toBeUndefined();
});

// The measurement that forced the check to be about specifiers rather than words: 27 of the 172 compiled
// files carry prose naming a TypeScript file, so a bare-word rule could never be extended over the tree.
it.each([
  [
    "a possessive in prose",
    "// once driver-boot.ts's and loop-boot.ts's own misuse (opening the tier)",
  ],
  [
    "a deleted component in prose",
    "// (cockpit.tsx's seedCockpitState previously seeded nativeMode)",
  ],
  [
    "a bare filename in prose",
    "// the ALWAYS-VISIBLE bottom chrome row (status-bar.tsx), which is now",
  ],
  // Backticks are this codebase's prose quoting for filenames; two compiled files carry exactly this.
  ["a backtick-quoted filename in prose", "// the reducer in `native-mode.ts` owns this"],
  ["a backtick-quoted example path", "// * @example `srcchata.ts`"],
  ["a compiled template specifier", "await import(`./digest-entry.js`);"],
])("accepts %s: prose is not a runtime reference", async (_description, source) => {
  const candidate = await fixtureFile(source);

  await expect(assertProductionJavaScript(candidate)).resolves.toBeUndefined();
});

it("RED: a staged tree missing the compiled digest entry fails the runtime assertion", async () => {
  const staged = await stagedFixture({ entry: false });

  await expect(assertStagedRuntime(staged)).rejects.toThrow(
    `compiled digest entry is missing: ${join(staged, "dist", "src", "memory", "digest-entry.js")}`,
  );
});

it("RED: a TypeScript runtime reference ANYWHERE under dist fails, not only in the host file", async () => {
  const staged = await stagedFixture({ entry: true });
  await writeFile(
    join(staged, "dist", "src", "chat", "session-store.js"),
    'export const loader = "tsx";\n',
    "utf8",
  );

  await expect(assertStagedRuntime(staged)).rejects.toThrow(
    "production sidecar must not contain a TypeScript runtime reference",
  );
});

it("accepts a staged tree whose compiled entry is present and whose tree is loader-free", async () => {
  const staged = await stagedFixture({ entry: true });

  await expect(assertStagedRuntime(staged)).resolves.toBeUndefined();
});

/** A minimal staged Node root: the two executable entries plus one ordinary compiled module. */
async function stagedFixture({ entry }) {
  const root = await temporaryRoot("zer0-v2-staged-");
  await mkdir(join(root, "dist", "src", "room"), { recursive: true });
  await mkdir(join(root, "dist", "src", "memory"), { recursive: true });
  await mkdir(join(root, "dist", "src", "chat"), { recursive: true });
  await writeFile(
    join(root, "dist", "src", "room", "zer0-v2-host.js"),
    "export function runZer0V2Host() {}\n",
    "utf8",
  );
  await writeFile(
    join(root, "dist", "src", "chat", "session-store.js"),
    'export const runs = ".council/runs";\n',
    "utf8",
  );
  if (entry)
    await writeFile(
      join(root, "dist", "src", "memory", "digest-entry.js"),
      "export async function runDigestEntry() {}\n",
      "utf8",
    );
  return root;
}

it("stages a launcher without a TypeScript runtime reference", async () => {
  const releaseDirectory = await temporaryRoot("zer0-v2-sidecar-release-");

  const staged = await stageZer0V2Sidecar(releaseDirectory, { install: false });
  const launcher = await readFile(staged.launcher, "utf8");
  const sourceSchema = await readFile(join(SOURCE_ROOT, "src", "evidence", "schema.sql"));
  const stagedSchema = await readFile(
    join(staged.stagedNodeRoot, "dist", "src", "evidence", "schema.sql"),
  );
  const sourceEmitter = await readFile(join(SOURCE_ROOT, "src", "chat", "statusline-emit.cjs"));
  const stagedEmitter = await readFile(
    join(staged.stagedNodeRoot, "dist", "src", "chat", "statusline-emit.cjs"),
  );
  const stagedDigestEntry = await readFile(staged.compiledDigestEntry, "utf8");
  const stagedFiles = await listFiles(staged.stagedNodeRoot);
  const stagedScripts = stagedFiles.filter((pathname) => pathname.startsWith("scripts/")).sort();
  const stagedPatches = stagedFiles.filter((pathname) => pathname.startsWith("patches/")).sort();
  const stagedPackage = JSON.parse(
    await readFile(join(staged.stagedNodeRoot, "package.json"), "utf8"),
  );

  expect(launcher).toContain(
    'import { runZer0V2Host } from "./zer0-v2-node/dist/src/room/zer0-v2-host.js";',
  );
  expect(launcher).toContain("runZer0V2Host();");
  expect(launcher).not.toMatch(/\btsx\b/i);
  expect(launcher).not.toMatch(/\bts-node\b/i);
  expect(launcher).not.toMatch(/\.ts["']/i);
  expect(stagedSchema).toEqual(sourceSchema);
  expect(sha256(stagedSchema)).toBe(sha256(sourceSchema));
  expect(stagedEmitter).toEqual(sourceEmitter);
  // The detached digest child ships: no import names it, so only this assertion notices if it stops.
  expect(staged.compiledDigestEntry).toBe(
    join(staged.stagedNodeRoot, "dist", "src", "memory", "digest-entry.js"),
  );
  expect(stagedDigestEntry).toContain("runDigestEntry");
  expect(stagedFiles.some((pathname) => /(?:^|\/)tests?(?:\/|$)|\.test\.js$/u.test(pathname))).toBe(
    false,
  );
  expect(stagedScripts).toEqual([
    "scripts/patch-contracts.mjs",
    "scripts/patch-lifecycle.mjs",
    "scripts/patch-state-files.mjs",
    "scripts/patch-state-worker.mjs",
    "scripts/patch-state.mjs",
    "scripts/patch-write.mjs",
  ]);
  expect(stagedPatches).toEqual(["patches/@agentclientprotocol+claude-agent-acp+0.75.1.patch"]);
  expect(stagedPackage.scripts).toEqual({
    postinstall: "node scripts/patch-lifecycle.mjs install",
  });
  expect(stagedPackage.bin).toBeUndefined();
  expect(stagedPackage.devDependencies).toBeUndefined();
}, 120_000);

async function fixtureFile(source) {
  const root = await temporaryRoot("zer0-v2-sidecar-source-");
  const pathname = join(root, "candidate.mjs");
  await writeFile(pathname, source, "utf8");
  return pathname;
}

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, pathname)));
    else files.push(pathname.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return files.sort();
}
