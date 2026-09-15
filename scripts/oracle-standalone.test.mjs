import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertDistMatchesSrc, hermeticEnv, releaseEnv } from "./oracle-standalone.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const BUILT_AT = new Date("2026-08-25T13:13:00Z");
const EDITED_AFTER = new Date("2026-08-25T13:20:00Z");
const EDITED_BEFORE = new Date("2026-08-25T12:36:00Z");

/** A repo root holding one production source and, unless `output` says otherwise, its compiled twin. */
async function fixture({ sourceMtime, output = true }) {
  const root = await mkdtemp(join(tmpdir(), "oracle-dist-age-"));
  roots.push(root);
  const source = join(root, "src", "chat", "agent-readiness-probe.ts");
  await mkdir(join(root, "src", "chat"), { recursive: true });
  await writeFile(source, "export const probe = 1;\n", "utf8");
  await utimes(source, sourceMtime, sourceMtime);
  if (output) {
    const compiled = join(root, "dist", "src", "chat", "agent-readiness-probe.js");
    await mkdir(join(root, "dist", "src", "chat"), { recursive: true });
    await writeFile(compiled, "export const probe = 1;\n", "utf8");
    await utimes(compiled, BUILT_AT, BUILT_AT);
  }
  return root;
}

it("RED: refuses to prove a dist whose source was edited after the build, and names the file", async () => {
  const root = await fixture({ sourceMtime: EDITED_AFTER });

  expect(() => assertDistMatchesSrc(root)).toThrow(/src[\\/]chat[\\/]agent-readiness-probe\.ts/);
  expect(() => assertDistMatchesSrc(root)).toThrow(/npm run build/);
});

it("accepts a dist built after its sources", async () => {
  const root = await fixture({ sourceMtime: EDITED_BEFORE });

  expect(() => assertDistMatchesSrc(root)).not.toThrow();
});

// gate-reachability's DECLARED_TEST_SUPPORT files and every *.test.ts are outside the production
// program (tsconfig.production.json), so they emit nothing. Editing one is not a stale build, and a
// check that said otherwise would refuse to run the oracle after an ordinary test edit.
it("ignores a source with no compiled output at all", async () => {
  const root = await fixture({ sourceMtime: EDITED_AFTER, output: false });

  expect(() => assertDistMatchesSrc(root)).not.toThrow();
});

// An absent dist is already the launcher's own error, which names the missing host — a second, vaguer
// error here would arrive first and bury it.
it("stays silent when there is no dist to compare against", async () => {
  const root = await mkdtemp(join(tmpdir(), "oracle-dist-age-"));
  roots.push(root);

  expect(() => assertDistMatchesSrc(root)).not.toThrow();
});

// FL-173: Windows environment variables are case-insensitive at the OS level, but object-rest excludes
// only the literal key spelling. A lowercase `zer0_hermetic` surviving releaseEnv() into a release
// child would still read hermeticEnabled() === true there — a release proof that silently ran hermetic
// and proved nothing about the real provider paths it exists to prove.
describe("releaseEnv (FL-173: no spelling of ZER0_HERMETIC/ZER0_DIGEST_FAKE survives)", () => {
  const HERMETIC_KEYS = ["ZER0_HERMETIC", "zer0_hermetic", "ZER0_DIGEST_FAKE", "zer0_digest_fake"];
  const saved = new Map();

  afterEach(() => {
    for (const key of HERMETIC_KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    saved.clear();
  });

  function setLowercase() {
    for (const key of HERMETIC_KEYS) saved.set(key, process.env[key]);
    for (const key of ["ZER0_HERMETIC", "ZER0_DIGEST_FAKE"]) delete process.env[key];
    process.env.zer0_hermetic = "1";
    process.env.zer0_digest_fake = '{"decisions":[],"summary":""}';
  }

  it("RED-shape: no key matching /^zer0_hermetic$/i or /^zer0_digest_fake$/i remains, whichever case the parent set", () => {
    setLowercase();
    const env = releaseEnv();
    const survivors = Object.keys(env).filter((k) => /^zer0_(hermetic|digest_fake)$/i.test(k));
    expect(survivors).toEqual([]);
  });

  it("a REAL child spawned with releaseEnv()'s output never reads itself as hermetic (the live FL-173 case)", () => {
    setLowercase();
    const env = releaseEnv();
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.ZER0_HERMETIC))"],
      { env, encoding: "utf8" },
    );
    expect(child.stdout).toBe("undefined");
  });

  it("still excludes the ordinary uppercase spelling (no regression on the documented case)", () => {
    saved.set("ZER0_HERMETIC", process.env.ZER0_HERMETIC);
    saved.set("ZER0_DIGEST_FAKE", process.env.ZER0_DIGEST_FAKE);
    process.env.ZER0_HERMETIC = "1";
    process.env.ZER0_DIGEST_FAKE = '{"decisions":[],"summary":""}';
    const env = releaseEnv();
    expect(env.ZER0_HERMETIC).toBeUndefined();
    expect(env.ZER0_DIGEST_FAKE).toBeUndefined();
  });
});

// hermeticEnv's mirror case: unlike releaseEnv (exclusion over the live process.env), hermeticEnv BUILDS
// a fresh plain object and sets ZER0_HERMETIC via an explicit Object.assign literal as its last step, so
// no pre-existing lowercase key in the parent's env can reach it through any path. Proven live rather
// than assumed, because this is exactly the class of belief that was wrong for releaseEnv.
describe("hermeticEnv (mirror check: a pre-existing lowercase key never reaches the child two ways)", () => {
  const roots2 = [];
  afterEach(async () => {
    for (const root of roots2.splice(0)) await rm(root, { recursive: true, force: true });
    for (const key of ["zer0_hermetic"]) delete process.env[key];
  });

  it("the built env carries exactly one ZER0_HERMETIC key even when the parent already has a lowercase one", async () => {
    process.env.zer0_hermetic = "0"; // a pre-existing, differently-valued lowercase key on the parent
    const root = await mkdtemp(join(tmpdir(), "oracle-hermetic-env-"));
    roots2.push(root);

    const env = hermeticEnv(root);
    const spellings = Object.keys(env).filter((k) => /^zer0_hermetic$/i.test(k));
    expect(spellings).toEqual(["ZER0_HERMETIC"]);
    expect(env.ZER0_HERMETIC).toBe("1"); // the explicit Object.assign literal, never the parent's "0"
  });

  it("a real child spawned with hermeticEnv()'s output reads ZER0_HERMETIC=1, never the parent's stale lowercase value", async () => {
    process.env.zer0_hermetic = "0";
    const root = await mkdtemp(join(tmpdir(), "oracle-hermetic-env-"));
    roots2.push(root);

    const env = hermeticEnv(root);
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.ZER0_HERMETIC))"],
      { env, encoding: "utf8" },
    );
    expect(child.stdout).toBe("1");
  });

  it("never carries two spellings of PATH/SYSTEMDRIVE/PROGRAMFILES either (same case-fold fix)", async () => {
    const root = await mkdtemp(join(tmpdir(), "oracle-hermetic-env-"));
    roots2.push(root);

    const env = hermeticEnv(root);
    // Exactly 1, not <= 1 (round-2 nit): <= 1 would also pass if the key vanished entirely, which
    // proves nothing about the case-fold fix — the key must survive AND survive under one spelling.
    for (const name of ["path", "systemdrive", "programfiles"]) {
      const spellings = Object.keys(env).filter((k) => k.toLowerCase() === name);
      expect(spellings.length).toBe(1);
    }
  });
});
