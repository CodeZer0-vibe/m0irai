import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validatePatchVersions } from "./gate-patches.mjs";
import { installPatches } from "./patch-lifecycle.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("RED: rejects a version-specific patch whose installed package version drifted", async () => {
  const root = await fixture("1.1.0", "demo-pkg+1.0.0.patch");

  await expect(validatePatchVersions(root)).rejects.toThrow(
    "demo-pkg+1.0.0.patch targets demo-pkg@1.0.0 but 1.1.0 is installed",
  );
});

it("RED: accepts a scoped package patch only when its filename exactly matches the installed version", async () => {
  const root = await fixture("2.3.4", "@scope+demo-pkg+2.3.4.patch", "@scope/demo-pkg");
  await installPatches(root);

  await expect(validatePatchVersions(root)).resolves.toMatchObject([
    { packageName: "@scope/demo-pkg", packageVersion: "2.3.4" },
  ]);
});

it("RED: fails when the product's expected patch set is not present", async () => {
  const root = await fixture("1.0.0", "demo-pkg+1.0.0.patch");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ zer0Patches: ["demo-pkg+1.0.0.patch", "missing-pkg+2.0.0.patch"] }),
    "utf8",
  );

  await expect(validatePatchVersions(root)).rejects.toThrow(
    "expected patch set is missing: missing-pkg+2.0.0.patch",
  );
});

it("RED: rejects patch content changed after the strict install receipt", async () => {
  const patchFile = "demo-pkg+1.0.0.patch";
  const root = await fixture("1.0.0", patchFile);
  await installPatches(root);
  const patchPath = join(root, "patches", patchFile);
  await writeFile(patchPath, `${await readFile(patchPath, "utf8")}# changed after install\n`);

  await expect(validatePatchVersions(root)).rejects.toThrow(
    `${patchFile} changed after the patch receipt was written`,
  );
});

it("RED: rejects installed bytes that no longer match the applied-patch receipt", async () => {
  const root = await fixture("1.0.0", "demo-pkg+1.0.0.patch");
  await installPatches(root);
  await writeFile(join(root, "node_modules", "demo-pkg", "index.js"), "old\n");

  await expect(validatePatchVersions(root)).rejects.toThrow(
    "node_modules/demo-pkg/index.js no longer matches its applied-patch receipt",
  );
});

async function fixture(version, patchFile, packageName = "demo-pkg") {
  const root = await mkdtemp(join(tmpdir(), "zer0-gate-patches-"));
  roots.push(root);
  const packagePath = join(root, "node_modules", ...packageName.split("/"));
  const target = `node_modules/${packageName}/index.js`;
  await mkdir(join(root, "patches"), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(root, "patches", patchFile),
    [
      `diff --git a/${target} b/${target}`,
      `--- a/${target}`,
      `+++ b/${target}`,
      "@@ -1 +1 @@",
      "-old",
      "+patched",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ zer0Patches: [patchFile] }), "utf8");
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({ name: packageName, version }),
    "utf8",
  );
  await writeFile(join(packagePath, "index.js"), "old\n", "utf8");
  return root;
}
