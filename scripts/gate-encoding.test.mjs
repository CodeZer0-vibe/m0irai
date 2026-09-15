import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const gatePath = join(repoRoot, "scripts", "gate-encoding.mjs");
const tempRoots = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function cp(...codes) {
  return String.fromCodePoint(...codes);
}

async function tempFile(name, content) {
  const root = await mkdtemp(join(tmpdir(), "zer0-encoding-gate-"));
  tempRoots.push(root);
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

function runGate(...files) {
  try {
    return {
      status: 0,
      stderr: "",
      stdout: execFileSync(process.execPath, [gatePath, ...files], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return {
      status: error.status,
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
}

it("flags each mojibake marker class with file:line evidence", async () => {
  const hostile = await tempFile(
    "hostile.txt",
    [
      "clean",
      `latin1 ${cp(0x00c3, 0x00a9)}`,
      `win1252 ${cp(0x00e2, 0x20ac, 0x201d)}`,
      `nbsp ${cp(0x00c2, 0x00a7)}`,
      `emoji ${cp(0x00f0, 0x0178, 0x02dc, 0x20ac)}`,
      `multiply ${cp(0x00c3, 0x0192, 0x00c6, 0x2019)}`,
    ].join("\n"),
  );

  const result = runGate(hostile);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${hostile}:2`);
  expect(result.stderr).toContain(`${hostile}:3`);
  expect(result.stderr).toContain(`${hostile}:4`);
  expect(result.stderr).toContain(`${hostile}:5`);
  expect(result.stderr).toContain(`${hostile}:6`);
});

it("accepts legitimate project glyphs and non-Latin text", async () => {
  const clean = await tempFile(
    "clean.txt",
    `icons ${cp(0x25cb, 0x25d4, 0x25d0, 0x25d5, 0x25cf)} ` +
      `${cp(0x25b0, 0x25b1)} ${cp(0x27e8, 0x27e9)} ` +
      `${cp(0x2726, 0x2699, 0x25c7)} ${cp(0x2014)} ${cp(0x2192)} ` +
      `box ${cp(0x250c, 0x2500, 0x2510)} CJK ${cp(0x6f22, 0x5b57)}\n`,
  );

  const result = runGate(clean);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("GATE PASS");
});
