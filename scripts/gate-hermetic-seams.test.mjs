// Unit tests for scripts/gate-hermetic-seams.mjs. Fixtures are real TypeScript source snippets parsed
// through the real findSeams, not synthetic call shapes — every review finding (round 1: B2, B3, I1, I2,
// I3, I4; round 3: N2, N3) gets the reviewer's own reproduction as a test here.
//
// N2 (round 3): the guard is now resolved through a REAL import, exactly like a spawn — so every fixture
// below that needs a working guard imports it explicitly, with a realistic file path (one level under
// src/, matching most real production files) so the relative specifier resolves correctly.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXEMPT,
  MIN_FILES_CHECKED,
  MIN_SEAMS_SCANNED,
  checkHermeticSeams,
  findOrphanedExemptions,
  findSeams,
  scanHermeticSeams,
} from "./gate-hermetic-seams.mjs";

const FIXTURE_FILE = "src/adapters/made-up.ts";
const GUARD_IMPORT = 'import { assertNotHermetic } from "../shared/hermetic.js";';

describe("findSeams — basic detection", () => {
  it("RED: an execa( call with no assertNotHermetic anywhere is unguarded", () => {
    const text = ['import { execa } from "execa";', 'execa("agy", []);'].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 2, guarded: false }]);
  });

  it("a spawn( call guarded by assertNotHermetic earlier in the SAME function is guarded", () => {
    const text = [
      GUARD_IMPORT,
      'import { spawn } from "node:child_process";',
      "function run() {",
      '  assertNotHermetic("x.run");',
      "  return spawn(cmd, args);",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: true }]);
  });

  it("a guard many lines above still counts — no arbitrary line-window limit (AST scope, not text distance)", () => {
    const pad = Array.from({ length: 40 }, (_, i) => `  // pad ${String(i)}`).join("\n");
    const text = [
      GUARD_IMPORT,
      'import { spawnSync } from "node:child_process";',
      "function run() {",
      '  assertNotHermetic("x");',
      pad,
      "  return spawnSync(cmd);",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 45, guarded: true }]);
  });

  it("never flags a RegExp.exec( call — PATTERN.exec(raw) is not a spawn (codex.ts:142,223 shape)", () => {
    const text = [
      "const MODEL_EFFORT_PATTERN = /x/;",
      "function f(model) {",
      "  const match = MODEL_EFFORT_PATTERN.exec(model);",
      "  return match;",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([]);
  });

  it("pty.spawn( via a namespace import is recognized as its own seam shape", () => {
    const text = ['import * as pty from "node-pty";', "term = pty.spawn(agyExePath(), []);"].join(
      "\n",
    );
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 2, guarded: false }]);
  });

  it("never confuses an unrelated identifier that merely CONTAINS the word spawn (spawnImpl with no import tie)", () => {
    const text = ["function f(spawnImpl) {", "  return spawnImpl(cmd, args, opts);", "}"].join(
      "\n",
    );
    expect(findSeams(text, FIXTURE_FILE)).toEqual([]);
  });
});

describe("N2 (round 3, CONFIRMED) — the guard is resolved, never matched by bare name", () => {
  it("RED: a LOCAL no-op function of the same name does NOT satisfy the guard", () => {
    const text = [
      'import { execa } from "execa";',
      "function assertNotHermetic(site) { /* decoy, never imported */ }",
      "function danger() {",
      '  assertNotHermetic("fake");',
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: false }]);
  });

  it("a renamed guard import (`as`) still satisfies it", () => {
    const text = [
      'import { assertNotHermetic as guard } from "../shared/hermetic.js";',
      'import { execa } from "execa";',
      "function danger() {",
      '  guard("danger");',
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: true }]);
  });

  it("a namespace-imported guard call still satisfies it", () => {
    const text = [
      'import * as hermetic from "../shared/hermetic.js";',
      'import { execa } from "execa";',
      "function danger() {",
      '  hermetic.assertNotHermetic("danger");',
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: true }]);
  });

  it("a guard imported from an UNRELATED module (same name, wrong source) does NOT satisfy it", () => {
    const text = [
      'import { assertNotHermetic } from "some-other-package";',
      'import { execa } from "execa";',
      "function danger() {",
      '  assertNotHermetic("wrong module");',
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: false }]);
  });
});

describe("N3 (round 3) — flow-insensitivity and the dynamic-import shape", () => {
  it("a guard inside `if (false)` still counts (flow-insensitive by design, documented in @purpose)", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      "function f() {",
      "  if (false) {",
      '    assertNotHermetic("unreachable branch");',
      "  }",
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 7, guarded: true }]);
  });

  it("a guard inside an always-swallowing try still counts", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      "function f() {",
      "  try {",
      '    assertNotHermetic("f");',
      "  } catch {",
      "    /* swallowed */",
      "  }",
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 9, guarded: true }]);
  });

  it("RED (the live src/chat/evidence.ts:475 shape): a dynamic `await import(...)` destructure is resolved, not invisible", () => {
    const text = [
      "async function headCommit() {",
      "  try {",
      '    const { execa: execaFn } = await import("execa");',
      '    const result = await execaFn("git", ["rev-parse", "HEAD"], {});',
      "    return result.stdout;",
      "  } catch {",
      "    return undefined;",
      "  }",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 4, guarded: false }]);
  });
});

describe("I1 — a comment can never satisfy the guard (round-1 CONFIRMED, now fixed)", () => {
  it("a comment mentioning assertNotHermetic( is not a guard", () => {
    const text = [
      'import { execa } from "execa";',
      "function danger() {",
      "  // historically we called assertNotHermetic( here but removed it",
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 4, guarded: false }]);
  });
});

describe("I2 — a guard in a sibling function never guards this one (round-1 CONFIRMED, now fixed)", () => {
  it("guard in a DIFFERENT function fails", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      'function safe() { assertNotHermetic("safe"); }',
      "function danger() {",
      '  return execa("claude", args);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: false }]);
  });

  it("a guard in an ENCLOSING function DOES protect a nested inner function", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      "function outer() {",
      '  assertNotHermetic("outer");',
      "  function inner() {",
      '    return execa("claude", args);',
      "  }",
      "  return inner();",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 6, guarded: true }]);
  });

  it("a guard placed AFTER the seam in the same function does not count (ordering, not just scope)", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      "function f() {",
      '  const r = execa("claude", args);',
      '  assertNotHermetic("too late");',
      "  return r;",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 4, guarded: false }]);
  });
});

describe("I3 — strings and comments never match as a seam (round-1 CONFIRMED, now fixed)", () => {
  it("a seam token inside a STRING literal is not a call", () => {
    const text = 'const msg = "call spawn( to start";';
    expect(findSeams(text, FIXTURE_FILE)).toEqual([]);
  });

  it("a seam token in a TRAILING comment is not a call", () => {
    const text = "const x = 1; // we used to spawn( here";
    expect(findSeams(text, FIXTURE_FILE)).toEqual([]);
  });

  it("a real multi-line execa( call is still ONE seam, found and correctly guarded", () => {
    const text = [
      GUARD_IMPORT,
      'import { execa } from "execa";',
      "async function f() {",
      '  assertNotHermetic("f");',
      "  const r = await execa(",
      '    "claude",',
      "    args,",
      "  );",
      "  return r;",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 5, guarded: true }]);
  });
});

describe("B3 — aliased spawns are no longer invisible (round-1 CONFIRMED, now fixed)", () => {
  it("a renamed import (`as`) is still resolved to its real export", () => {
    const text = [
      'import { spawn as launch } from "node:child_process";',
      "function bypassA() {",
      '  return launch("claude", ["-p", "hi"]);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 3, guarded: false }]);
  });

  it("a local const alias of an imported spawn function is still resolved", () => {
    const text = [
      'import { execa } from "execa";',
      "const runner = execa;",
      "function bypassB() {",
      '  return runner("claude", ["-p", "hi"]);',
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 4, guarded: false }]);
  });

  it("a parameter DEFAULT VALUE aliasing an imported spawn function is resolved (the live digest-runner.ts:206,219 shape)", () => {
    const text = [
      'import { spawn } from "node:child_process";',
      "function createDetachedSpawn(entry, spawnImpl = spawn) {",
      "  return (request) => {",
      "    const child = spawnImpl(process.execPath, [], {});",
      "    return child;",
      "  };",
      "}",
    ].join("\n");
    expect(findSeams(text, FIXTURE_FILE)).toEqual([{ line: 4, guarded: false }]);
  });

  it("execFileSync, fork, execSync, execaSync, execaCommand and cp.exec( are all recognized (round-1's 'latent' token list)", () => {
    const cases = [
      ['import { execFileSync } from "node:child_process";', "execFileSync(cmd);"],
      ['import { fork } from "node:child_process";', "fork(cmd);"],
      ['import { execSync } from "node:child_process";', "execSync(cmd);"],
      ['import { execaSync } from "execa";', "execaSync(cmd);"],
      ['import { execaCommand } from "execa";', "execaCommand(cmd);"],
      ['import * as cp from "node:child_process";', "cp.exec(cmd);"],
      ['import { execa } from "execa";', "execa.command(cmd);"],
    ];
    for (const [importLine, callLine] of cases) {
      expect(
        findSeams([importLine, callLine].join("\n"), FIXTURE_FILE),
        `${importLine} / ${callLine}`,
      ).toEqual([{ line: 2, guarded: false }]);
    }
  });
});

describe("scanHermeticSeams — count-keyed exemptions (B2, round-1 CONFIRMED, now fixed)", () => {
  it("RED: an unguarded seam in a non-exempt file fails closed, naming file:line", () => {
    const files = {
      "src/adapters/made-up.ts": 'import { execa } from "execa";\nexeca("agy", []);\n',
    };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(false);
    expect(r.unguarded).toEqual(["src/adapters/made-up.ts:2"]);
  });

  it("GREEN: the same seam passes once assertNotHermetic guards it (with a real import)", () => {
    const files = {
      "src/adapters/made-up.ts": [
        GUARD_IMPORT,
        'import { execa } from "execa";',
        "function f() {",
        '  assertNotHermetic("made-up.run");',
        '  return execa("agy", []);',
        "}",
      ].join("\n"),
    };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(true);
    expect(r.unguarded).toEqual([]);
  });

  it("an EXEMPT file passes when its seam count matches the recorded count exactly", () => {
    const exemptPath = Object.keys(EXEMPT)[0];
    const files = {
      [exemptPath]: 'import { spawnSync } from "node:child_process";\nspawnSync("taskkill", []);\n',
    };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(true);
    expect(r.exemptionMismatches).toEqual([]);
  });

  it("RED (the reviewer's exact B2 mutation): a NEW seam added to an exempted file fails — an exemption is not a blanket licence", () => {
    const exemptPath = Object.keys(EXEMPT)[0]; // count: 1
    const files = {
      [exemptPath]:
        'import { spawnSync } from "node:child_process";\nspawnSync("taskkill", []);\nspawnSync("smuggled", []);\n',
    };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(false);
    expect(r.exemptionMismatches).toEqual([
      `${exemptPath}: exemption recorded count=1, found 2 seam(s) at line(s) 2,3`,
    ]);
  });

  it("RED: a seam REMOVED from an exempted file (count too low) also fails, not silently accepted", () => {
    const exemptPath = "src/adapters/agy-mode-probe.ts"; // count: 2
    const files = {
      [exemptPath]: 'import { execa } from "execa";\nexeca("agyExePath", []);\n',
    };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(false);
    expect(r.exemptionMismatches).toEqual([
      `${exemptPath}: exemption recorded count=2, found 1 seam(s) at line(s) 2`,
    ]);
  });

  it("RED: an EXEMPT entry naming a file with NO seams at all is a stale exemption", () => {
    const exemptPath = Object.keys(EXEMPT)[0];
    const files = { [exemptPath]: "export const nothing = 1;\n" };
    const r = scanHermeticSeams(files);
    expect(r.ok).toBe(false);
    expect(r.staleExemptions).toEqual([exemptPath]);
  });

  it("counts every seam scanned, guarded and unguarded and exempt alike (the positive-control number)", () => {
    const exemptPath = Object.keys(EXEMPT)[0];
    const files = {
      "src/a.ts": [
        GUARD_IMPORT,
        'import { execa } from "execa";',
        "function f() {",
        '  assertNotHermetic("a");',
        '  return execa("x", []);',
        "}",
      ].join("\n"),
      "src/b.ts": 'import { spawn } from "node:child_process";\nspawn(cmd, args);\n',
      [exemptPath]: 'import { spawnSync } from "node:child_process";\nspawnSync("taskkill", []);\n',
    };
    const r = scanHermeticSeams(files);
    expect(r.seamsScanned).toBe(3);
  });
});

describe("findOrphanedExemptions (EXEMPT entry naming a file that no longer exists)", () => {
  it("RED: an EXEMPT path absent from the current production file list is orphaned", () => {
    const present = Object.keys(EXEMPT).slice(1);
    expect(findOrphanedExemptions(present)).toEqual([Object.keys(EXEMPT)[0]]);
  });

  it("GREEN: every EXEMPT path present in the file list is not orphaned", () => {
    expect(findOrphanedExemptions(Object.keys(EXEMPT))).toEqual([]);
  });
});

describe("I4 — the fail-closed floors are load-bearing, not decorative (round-1 CONFIRMED, now tested)", () => {
  const roots = [];
  const cleanup = async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  };

  it("RED: a src/ tree with too few files throws citing the floor, never passes silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermetic-floor-files-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "one.ts"), "export const x = 1;\n", "utf8");

    expect(() => checkHermeticSeams(root)).toThrowError(
      new RegExp(`only 1 src files scanned \\(< floor ${String(MIN_FILES_CHECKED)}\\)`),
    );
    await cleanup();
  }, 30_000);

  it("RED: enough files but too few real seams throws citing the seams floor, never passes silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermetic-floor-seams-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    // Enough FILES to clear MIN_FILES_CHECKED, none of them containing a real spawn call.
    for (let i = 0; i < MIN_FILES_CHECKED + 5; i += 1) {
      await writeFile(
        join(root, "src", `f${String(i)}.ts`),
        `export const x${String(i)} = ${String(i)};\n`,
        "utf8",
      );
    }

    expect(() => checkHermeticSeams(root)).toThrowError(
      new RegExp(`only 0 seam call\\(s\\) scanned \\(< floor ${String(MIN_SEAMS_SCANNED)}\\)`),
    );
    await cleanup();
  }, 30_000);
});

describe("checkHermeticSeams (real tree, positive control)", () => {
  // I5 (round-1 CONFIRMED near-tautological): a bare `r.exempted === Object.keys(EXEMPT).length`
  // assertion was deleted rather than kept — checkHermeticSeams throwing on a stale/orphaned/mismatched
  // EXEMPT entry (already covered above and by the mutation tests) is the real assertion; a passing
  // count derived from the same table it's compared against proves nothing extra.
  it("passes the real repo tree with a nonzero seam count — never silently zero", () => {
    const r = checkHermeticSeams(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.seamsScanned).toBeGreaterThan(0);
    expect(r.filesScanned).toBeGreaterThan(100);
  });
});
