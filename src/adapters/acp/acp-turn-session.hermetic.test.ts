/**
 * @file src/adapters/acp/acp-turn-session.hermetic.test.ts
 * @purpose The ACP bridge spawn seam refuses under ZER0_HERMETIC=1 BEFORE any process is created — the guarantee
 *   the standalone oracle's hermetic mode rests on (a missing seam would attempt a real spawn).
 * @exports (none)
 * @depends vitest, ../../shared/hermetic, ./acp-turn-session
 */
import { afterEach, expect, it } from "vitest";
import { HERMETIC_ENV, HermeticSpawnRefused } from "../../shared/hermetic.js";
import { spawnServer } from "./acp-turn-session.js";

const saved = process.env[HERMETIC_ENV];
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, HERMETIC_ENV);
  else process.env[HERMETIC_ENV] = saved;
});

it("spawnServer refuses under ZER0_HERMETIC=1 before spawning (a nonexistent entry never gets a chance to fail differently)", () => {
  process.env[HERMETIC_ENV] = "1";
  expect(() =>
    spawnServer("codex", { agent: "codex", entry: "/nonexistent/acp-entry.js", env: {} }),
  ).toThrow(HermeticSpawnRefused);
});
