// Unit tests for scripts/gate-reachability.mjs — injected program/inventory sets, no tsc/git spawns.
// A vitest suite like every other scripts/*.test.mjs here (the unit pool collects this folder; the first
// staging of 3.8 proved a plain node:assert script fails collection with "No test suite found").
import { describe, expect, it } from "vitest";
import { DECLARED_TEST_SUPPORT, checkReachability } from "./gate-reachability.mjs";

const declared = DECLARED_TEST_SUPPORT[0];
const program = new Set(["src/a.ts", "src/b.ts"]);
for (let i = 0; i < 130; i += 1) program.add(`src/pad/p${i}.ts`); // clear the floors
// EVERY declared test-support file must be in the inventory or the gate reports a stale declaration
// (lab run 2 proved it: seeding only one of them fails the clean case by design).
const baseInventory = [...program, ...DECLARED_TEST_SUPPORT, "src/x.fixtures.ts"];

describe("gate-reachability (injected sets)", () => {
  it("passes a clean tree: every inventory file is in the program or declared", () => {
    const r = checkReachability(process.cwd(), { program, inventory: [...baseInventory] });
    expect(r.ok).toBe(true);
  });

  it("reports a tracked orphan by name", () => {
    expect(() =>
      checkReachability(process.cwd(), {
        program,
        inventory: [...baseInventory, "src/__orphan__.ts"],
      }),
    ).toThrowError(/orphans[\s\S]*__orphan__/u);
  });

  it("fails a declared test-support file that IS in the production program (stale declaration)", () => {
    expect(() =>
      checkReachability(process.cwd(), {
        program: new Set([...program, declared]),
        inventory: [...baseInventory],
      }),
    ).toThrowError(/stale declaration/u);
  });

  it("fails a declared test-support file missing from the inventory", () => {
    expect(() =>
      checkReachability(process.cwd(), {
        program,
        inventory: [...baseInventory].filter((p) => p !== declared),
      }),
    ).toThrowError(/not tracked/u);
  });

  it("refuses a broken invocation via the nonzero floors, even when the tiny sets agree", () => {
    expect(() =>
      checkReachability(process.cwd(), { program: new Set(["src/a.ts"]), inventory: ["src/a.ts"] }),
    ).toThrowError(/floor/u);
  });
});
