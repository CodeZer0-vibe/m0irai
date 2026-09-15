import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { autoRefitPatches, inspectPatchIntegrity, installPatches } from "./patch-lifecycle.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("RED: clean adapter drift is dry-run first, applied, receipted, and healthy on the next check", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageJsonPath = join(root, "node_modules", "demo-pkg", "package.json");
  const patchPath = join(root, "patches", "demo-pkg+1.0.0.patch");
  const [packageBefore, patchBefore] = await Promise.all([
    readFile(packageJsonPath, "utf8"),
    readFile(patchPath, "utf8"),
  ]);

  const repaired = await autoRefitPatches(root);

  expect(repaired.status).toBe("repaired");
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(
    'export const meter = "patched";\n',
  );
  expect(await readFile(packageJsonPath, "utf8")).toBe(packageBefore);
  expect(await readFile(patchPath, "utf8")).toBe(patchBefore);
  const receipt = JSON.parse(
    await readFile(join(root, "node_modules", ".zer0", "patches-applied.json"), "utf8"),
  );
  expect(receipt.patches[0]).toMatchObject({
    declaredVersion: "1.0.0",
    installedVersion: "1.1.0",
    packageName: "demo-pkg",
    patchFile: "demo-pkg+1.0.0.patch",
  });
  expect(receipt.patches[0].targets[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(inspectPatchIntegrity(root)).resolves.toMatchObject({ status: "healthy" });
});

it("RED: incompatible adapter drift leaves installed bytes unchanged and reports degradation", async () => {
  const before = 'export const meter = "upstream-restructured";\n';
  const root = await fixture(before);

  const result = await autoRefitPatches(root);

  expect(result.status).toBe("degraded");
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(before);
});

it("RED: a live repair owner is never displaced just because its lock is old", async () => {
  const before = 'export const meter = "old";\n';
  const root = await fixture(before);
  const stateDir = join(root, "node_modules", ".zer0");
  const lockPath = join(stateDir, "patches.lock");
  await mkdir(stateDir, { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now() - 60_000 }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const result = await autoRefitPatches(root);

  expect(result).toMatchObject({ status: "degraded", reason: "patch repair is busy" });
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(before);
});

it("RED: patch state refuses a redirected directory and never writes outside node_modules", async () => {
  const before = 'export const meter = "old";\n';
  const root = await fixture(before);
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-state-outside-"));
  roots.push(outside);
  const stateDir = join(root, "node_modules", ".zer0");
  await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");

  const result = await autoRefitPatches(root);

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("patch state directory");
  await expect(readFile(join(outside, "patches-applied.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(before);
});

it("RED: node_modules redirected to the project root cannot create project patch state", async () => {
  const root = await mkdtemp(join(tmpdir(), "zer0-node-modules-root-loop-"));
  roots.push(root);
  await symlink(
    root,
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await expect(installPatches(root)).rejects.toThrow();
  await expect(readFile(join(root, ".zer0", "patches-applied.json"), "utf8")).rejects.toMatchObject(
    {
      code: "ENOENT",
    },
  );
  await expect(readFile(join(root, ".zer0", "patches.lock"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(lstat(join(root, ".zer0"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("RED: journal creation fails closed if patch state is redirected after lock acquisition", async () => {
  const before = 'export const meter = "old";\n';
  const root = await fixture(before);
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-journal-outside-"));
  roots.push(outside);
  const stateDir = join(root, "node_modules", ".zer0");

  const result = await autoRefitPatches(root, {
    beforeJournalWrite: async () => {
      await rm(stateDir, { recursive: true });
      await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  await expect(readFile(join(outside, "patch-refit-journal.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(before);
});

it("RED: receipt publication fails closed if patch state is redirected before its write", async () => {
  const before = 'export const meter = "old";\n';
  const root = await fixture(before);
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-receipt-outside-"));
  roots.push(outside);
  const stateDir = join(root, "node_modules", ".zer0");

  const result = await autoRefitPatches(root, {
    beforeReceiptWrite: async () => {
      await rm(stateDir, { recursive: true });
      await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  await expect(readFile(join(outside, "patches-applied.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(
    'export const meter = "old";\n',
  );
});

it("RED: lock cleanup cannot remove a file through a state-directory swap at the path operation", async () => {
  const root = await fixture('export const meter = "old";\n');
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-lock-race-outside-"));
  roots.push(outside);
  const stateDir = join(root, "node_modules", ".zer0");
  const displacedStateDir = join(root, "node_modules", ".zer0-displaced");
  const outsideLock = join(outside, "patches.lock");
  await writeFile(outsideLock, "outside owner must survive", "utf8");
  let redirected = false;

  const result = await autoRefitPatches(root, {
    beforeStatePathOperation: async ({ operation, path }) => {
      if (redirected || operation !== "remove" || path !== join(stateDir, "patches.lock")) return;
      redirected = true;
      await rename(stateDir, displacedStateDir);
      await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  expect(await readFile(outsideLock, "utf8")).toBe("outside owner must survive");
});

it("RED: lock cleanup preserves a replacement lock created by another process", async () => {
  const root = await fixture('export const meter = "old";\n');
  const lockPath = join(root, "node_modules", ".zer0", "patches.lock");
  const replacement = JSON.stringify({
    pid: process.pid,
    ownerToken: "replacement-owner",
    startedAtMs: Date.now(),
  });
  let replaced = false;

  const result = await autoRefitPatches(root, {
    beforeStatePathOperation: async ({ operation, path }) => {
      if (replaced || operation !== "remove" || path !== lockPath) return;
      replaced = true;
      await rm(lockPath);
      await writeFile(lockPath, replacement, "utf8");
    },
  });

  expect(result.status).toBe("degraded");
  expect(await readFile(lockPath, "utf8")).toBe(replacement);
});

it("RED: a redirected managed package root never permits outside-tree patch writes", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-package-outside-"));
  roots.push(outside);
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), 'export const meter = "old";\n'),
  ]);
  await rm(packageRoot, { recursive: true });
  await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");

  const result = await autoRefitPatches(root);

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("managed package root resolves outside node_modules");
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe('export const meter = "old";\n');
});

it("RED: strict install validates every patch target before any delegated write", async () => {
  const root = await fixture('export const meter = "old";\n');
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-install-outside-"));
  roots.push(outside);
  const victim = join(outside, "victim.js");
  const escapedTarget = relative(root, victim).replaceAll("\\", "/");
  await Promise.all([
    writeFile(victim, 'export const meter = "old";\n'),
    writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" })),
    writeFile(
      join(root, "node_modules", "demo-pkg", "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.0.0" }),
    ),
    writeFile(
      join(root, "patches", "demo-pkg+1.0.0.patch"),
      [
        `diff --git a/${escapedTarget} b/${escapedTarget}`,
        `--- a/${escapedTarget}`,
        `+++ b/${escapedTarget}`,
        "@@ -1 +1 @@",
        '-export const meter = "old";',
        '+export const meter = "patched";',
        "",
      ].join("\n"),
    ),
  ]);

  await expect(installPatches(root)).rejects.toThrow("targets a file outside demo-pkg");
  expect(await readFile(victim, "utf8")).toBe('export const meter = "old";\n');
});

it("RED: runtime refit revalidates containment immediately before live writes", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-before-apply-outside-"));
  roots.push(outside);
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), 'export const meter = "old";\n'),
  ]);

  const result = await autoRefitPatches(root, {
    beforeApply: async () => {
      await rm(packageRoot, { recursive: true });
      await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("managed package root resolves outside node_modules");
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe('export const meter = "old";\n');
});

it("RED: rollback snapshots never capture bytes through a redirected package target", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-snapshot-outside-"));
  roots.push(outside);
  const outsideBytes = 'export const meter = "old";\n// OUTSIDE_ONLY_SECRET\n';
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), outsideBytes),
  ]);

  const result = await autoRefitPatches(root, {
    beforeSnapshotCapture: async () => {
      await rm(packageRoot, { recursive: true });
      await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");
    },
    beforeApply: () => {
      throw new Error("stop after snapshot journal publication");
    },
  });

  let journal = "";
  try {
    journal = await readFile(
      join(root, "node_modules", ".zer0", "patch-refit-journal.json"),
      "utf8",
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
  expect(result.status).toBe("degraded");
  expect(journal).not.toContain(Buffer.from(outsideBytes).toString("base64"));
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe(outsideBytes);
});

it("RED: rollback refuses a managed package root redirected after patch application", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-rollback-outside-"));
  roots.push(outside);
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), 'export const meter = "patched";\n'),
  ]);

  const result = await autoRefitPatches(root, {
    afterApply: async () => {
      await rm(packageRoot, { recursive: true });
      await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");
      throw new Error("forced failure after package root redirection");
    },
  });

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("managed package root resolves outside node_modules");
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe(
    'export const meter = "patched";\n',
  );
});

it("RED: caught rollback revalidates a package redirect immediately before restore", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-rollback-race-outside-"));
  roots.push(outside);
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), 'export const meter = "patched";\n'),
  ]);

  const result = await autoRefitPatches(root, {
    afterApply: () => {
      throw new Error("forced failure before rollback");
    },
    beforeRollbackRestore: async () => {
      await rm(packageRoot, { recursive: true });
      await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("managed package root resolves outside node_modules");
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe(
    'export const meter = "patched";\n',
  );
});

it("RED: a killed refit leaves a durable journal that the next boot rolls back before retrying", async () => {
  const root = await fixture('export const meter = "old";\n');
  const crashed = crashRefit(root);

  expect(crashed.status).toBe(86);
  expect(await readFile(join(root, "node_modules", "demo-pkg", "index.js"), "utf8")).toBe(
    'export const meter = "patched";\n',
  );
  await expect(
    readFile(join(root, "node_modules", ".zer0", "patch-refit-journal.json"), "utf8"),
  ).resolves.toContain('"schemaVersion"');

  const recovered = await autoRefitPatches(root);

  expect(recovered.status).toBe("repaired");
  await expect(inspectPatchIntegrity(root)).resolves.toMatchObject({ status: "healthy" });
  await expect(
    readFile(join(root, "node_modules", ".zer0", "patch-refit-journal.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("RED: crash recovery revalidates a package redirect immediately before restore", async () => {
  const root = await fixture('export const meter = "old";\n');
  const packageRoot = join(root, "node_modules", "demo-pkg");
  expect(crashRefit(root).status).toBe(86);
  const outside = await mkdtemp(join(tmpdir(), "zer0-patch-recovery-race-outside-"));
  roots.push(outside);
  await Promise.all([
    writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    ),
    writeFile(join(outside, "index.js"), 'export const meter = "patched";\n'),
  ]);

  const result = await autoRefitPatches(root, {
    beforeRecoveryRestore: async () => {
      await rm(packageRoot, { recursive: true });
      await symlink(outside, packageRoot, process.platform === "win32" ? "junction" : "dir");
    },
  });

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("managed package root resolves outside node_modules");
  expect(await readFile(join(outside, "index.js"), "utf8")).toBe(
    'export const meter = "patched";\n',
  );
});

it("RED: caught rollback preserves dependency bytes changed by another process", async () => {
  const root = await fixture('export const meter = "old";\n');
  const target = join(root, "node_modules", "demo-pkg", "index.js");

  const result = await autoRefitPatches(root, {
    afterApply: async () => {
      await writeFile(target, 'export const meter = "external";\n');
      throw new Error("forced failure after an external write");
    },
  });

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("changed outside the patch transaction");
  expect(await readFile(target, "utf8")).toBe('export const meter = "external";\n');
});

it("RED: crash recovery preserves dependency bytes changed by another process", async () => {
  const root = await fixture('export const meter = "old";\n');
  const target = join(root, "node_modules", "demo-pkg", "index.js");
  expect(crashRefit(root).status).toBe(86);
  await writeFile(target, 'export const meter = "external";\n');

  const result = await autoRefitPatches(root);

  expect(result.status).toBe("degraded");
  expect(result.reason).toContain("changed outside the patch transaction");
  expect(await readFile(target, "utf8")).toBe('export const meter = "external";\n');
});

function crashRefit(root) {
  const moduleUrl = new URL("./patch-lifecycle.mjs", import.meta.url).href;
  const source = [
    `import { autoRefitPatches } from ${JSON.stringify(moduleUrl)};`,
    "await autoRefitPatches(process.argv[1], { afterApply: () => process.exit(86) });",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
    encoding: "utf8",
  });
}

async function fixture(installedSource) {
  const root = await mkdtemp(join(tmpdir(), "zer0-patch-refit-"));
  roots.push(root);
  await mkdir(join(root, "patches"), { recursive: true });
  await mkdir(join(root, "node_modules", "demo-pkg"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "demo-pkg", "package.json"),
    JSON.stringify({ name: "demo-pkg", version: "1.1.0" }),
    "utf8",
  );
  await writeFile(join(root, "node_modules", "demo-pkg", "index.js"), installedSource, "utf8");
  await writeFile(
    join(root, "patches", "demo-pkg+1.0.0.patch"),
    [
      "diff --git a/node_modules/demo-pkg/index.js b/node_modules/demo-pkg/index.js",
      "--- a/node_modules/demo-pkg/index.js",
      "+++ b/node_modules/demo-pkg/index.js",
      "@@ -1 +1 @@",
      '-export const meter = "old";',
      '+export const meter = "patched";',
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}
