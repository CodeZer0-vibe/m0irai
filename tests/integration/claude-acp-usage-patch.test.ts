/**
 * @file tests/integration/claude-acp-usage-patch.test.ts
 * @purpose Guard the real installed Claude ACP dependency against silently losing Zer0's headless
 *   quota-window forwarding when the package version changes. The test reads the installed package and
 *   patch artifact directly: no mock can make an unapplied version-specific patch look healthy.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ROOT = join(REPO_ROOT, "node_modules", "@agentclientprotocol", "claude-agent-acp");

it("RED: install and full gates both enforce the patch lifecycle", async () => {
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
    readonly dependencies: Record<string, string>;
    readonly devDependencies: Record<string, string>;
    readonly scripts: Record<string, string>;
    readonly zer0Patches: readonly string[];
  };

  expect(packageJson.scripts.postinstall).toContain("patch-lifecycle.mjs install");
  expect(packageJson.scripts.gates).toContain("gate-patches.mjs");
  expect(packageJson.dependencies["patch-package"]).toBe("8.0.1");
  expect(packageJson.devDependencies["patch-package"]).toBeUndefined();
  const patchFiles = (await readdir(join(REPO_ROOT, "patches")))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  expect(packageJson.zer0Patches).toEqual(patchFiles);
  const receipt = JSON.parse(
    await readFile(join(REPO_ROOT, "node_modules", ".zer0", "patches-applied.json"), "utf8"),
  ) as {
    readonly patches: ReadonlyArray<{
      readonly installedVersion: string;
      readonly packageName: string;
      readonly patchFile: string;
      readonly targets: ReadonlyArray<{ readonly sha256: string | null }>;
    }>;
  };
  expect(receipt.patches.map((entry) => entry.patchFile).sort()).toEqual(patchFiles);
  expect(receipt.patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        installedVersion: "0.75.1",
        packageName: "@agentclientprotocol/claude-agent-acp",
      }),
    ]),
  );
  for (const entry of receipt.patches) {
    expect(entry.targets.every((target) => /^[a-f0-9]{64}$/.test(target.sha256 ?? ""))).toBe(true);
  }
});

it("the installed Claude ACP version has its quota-window forwarding patch applied", async () => {
  const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    readonly version: string;
  };
  const patchPath = join(
    REPO_ROOT,
    "patches",
    `@agentclientprotocol+claude-agent-acp+${packageJson.version}.patch`,
  );
  const [patch, installedAdapter] = await Promise.all([
    readFile(patchPath, "utf8"),
    readFile(join(PACKAGE_ROOT, "dist", "acp-agent.js"), "utf8"),
  ]);

  expect(patch).toContain('"_claude/usageWindows"');
  expect(installedAdapter).toContain('"_claude/usageWindows"');
  expect(installedAdapter).toContain("usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET");
});

it("the installed Claude SDK still exposes the experimental usage method the patch calls", async () => {
  const sdkTypes = await readFile(
    join(PACKAGE_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"),
    "utf8",
  );

  expect(sdkTypes).toContain(
    "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>",
  );
});
