/**
 * @file src/shared/hermetic.test.ts
 * @purpose ZER0_HERMETIC=1 semantics: exact-value switch, deterministic refusal naming the seam, no effect otherwise.
 *   (The spawn-seam refusal itself is proved beside the seam: src/adapters/acp/acp-turn-session.hermetic.test.ts.)
 * @exports (none)
 * @depends vitest, ./hermetic
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  HERMETIC_ENV,
  HermeticSpawnRefused,
  assertNotHermetic,
  hermeticEnabled,
} from "./hermetic.js";

const saved = process.env[HERMETIC_ENV];
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, HERMETIC_ENV);
  else process.env[HERMETIC_ENV] = saved;
});

describe("hermetic switch", () => {
  it('is off unless the value is exactly "1"', () => {
    Reflect.deleteProperty(process.env, HERMETIC_ENV);
    expect(hermeticEnabled()).toBe(false);
    expect(() => assertNotHermetic("x")).not.toThrow();
    process.env[HERMETIC_ENV] = "true";
    expect(hermeticEnabled()).toBe(false);
    process.env[HERMETIC_ENV] = "1";
    expect(hermeticEnabled()).toBe(true);
  });

  it("refuses with a deterministic error naming the seam", () => {
    process.env[HERMETIC_ENV] = "1";
    let caught: unknown;
    try {
      assertNotHermetic("unit.seam");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermeticSpawnRefused);
    expect((caught as HermeticSpawnRefused).site).toBe("unit.seam");
    expect((caught as Error).message).toContain("ZER0_HERMETIC=1");
  });
});
