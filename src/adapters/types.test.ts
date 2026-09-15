/**
 * @file src/adapters/types.test.ts
 * @purpose Tests adapter-shaped type contracts.
 * @exports (none)
 * @depends vitest, ./types, ../shared/errors
 */
import { expect, expectTypeOf, it } from "vitest";
import type { DispatchError } from "../shared/errors.js";
import { AdapterCommand, type AdapterError, type AgentInput } from "./types.js";

it("keeps adapter input and command contracts concrete", () => {
  expectTypeOf<AgentInput>().toHaveProperty("signal").toEqualTypeOf<AbortSignal>();
  expectTypeOf<AdapterCommand>().toHaveProperty("args").toEqualTypeOf<readonly string[]>();
  expectTypeOf<AdapterError>().toEqualTypeOf<DispatchError>();
});

it("validates adapter command objects at runtime", () => {
  expect(AdapterCommand.parse({ args: ["--version"], cmd: "codex" })).toEqual({
    args: ["--version"],
    cmd: "codex",
  });
});
