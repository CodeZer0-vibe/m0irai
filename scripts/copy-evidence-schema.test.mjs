import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyEvidenceSchema, copyProductionRuntimeAssets } from "./copy-evidence-schema.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("copyEvidenceSchema", () => {
  it("copies schema bytes into a newly created compiled evidence directory", async () => {
    const sourceRoot = await temporaryRoot("zer0-evidence-schema-source-");
    const distRoot = join(await temporaryRoot("zer0-evidence-schema-dist-"), "dist");
    const source = join(sourceRoot, "src", "evidence", "schema.sql");
    const expected = Buffer.from("-- schema\r\nCREATE TABLE sample (id INTEGER);\r\n", "utf8");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, expected);

    const { destination } = await copyEvidenceSchema({ distRoot, sourceRoot });

    expect(destination).toBe(join(distRoot, "src", "evidence", "schema.sql"));
    await expect(readFile(destination)).resolves.toEqual(expected);
  });

  it("fails loudly when the source schema is unavailable", async () => {
    const sourceRoot = await temporaryRoot("zer0-evidence-schema-missing-");
    const distRoot = join(await temporaryRoot("zer0-evidence-schema-output-"), "dist");

    await expect(copyEvidenceSchema({ distRoot, sourceRoot })).rejects.toThrow(
      "Failed to copy evidence schema build asset",
    );
  });
});

describe("copyProductionRuntimeAssets", () => {
  it("copies the statusline emitter beside compiled chat modules", async () => {
    const sourceRoot = await temporaryRoot("zer0-runtime-assets-source-");
    const distRoot = join(await temporaryRoot("zer0-runtime-assets-dist-"), "dist");
    const schema = join(sourceRoot, "src", "evidence", "schema.sql");
    const emitter = join(sourceRoot, "src", "chat", "statusline-emit.cjs");
    await mkdir(dirname(schema), { recursive: true });
    await mkdir(dirname(emitter), { recursive: true });
    await writeFile(schema, "-- schema\n");
    await writeFile(emitter, "process.stdout.write('ctx');\n");

    const copied = await copyProductionRuntimeAssets({ distRoot, sourceRoot });

    await expect(readFile(copied.statuslineEmitter.destination, "utf8")).resolves.toBe(
      "process.stdout.write('ctx');\n",
    );
  });
});

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
