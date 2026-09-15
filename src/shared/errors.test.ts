import { expect, it } from "vitest";
import { Zer0ErrorCode } from "./error-codes.js";
import {
  ConfigError,
  ContextError,
  DispatchError,
  GateError,
  MalformedAgentOutputError,
  StabilityError,
  isZer0Error,
} from "./errors.js";

const CAUSE: Error = new Error("underlying failure");

it("sets ConfigError name, code, and cause", () => {
  const error = new ConfigError("config invalid at path", Zer0ErrorCode.ConfigInvalid, {
    cause: CAUSE,
  });

  expect(error.name).toBe("ConfigError");
  expect(error.code).toBe(Zer0ErrorCode.ConfigInvalid);
  expect(error.cause).toBe(CAUSE);
});

it("sets GateError name, code, gate, evidence, and cause", () => {
  const evidence = { command: "npm run typecheck" };
  const error = new GateError(
    "gate failed",
    Zer0ErrorCode.GateClampViolated,
    "typecheck",
    evidence,
    { cause: CAUSE },
  );

  expect(error.name).toBe("GateError");
  expect(error.code).toBe(Zer0ErrorCode.GateClampViolated);
  expect(error.gate).toBe("typecheck");
  expect(error.evidence).toBe(evidence);
  expect(error.cause).toBe(CAUSE);
});

it("sets DispatchError name, agent, exit code, stderr, and cause", () => {
  const error = new DispatchError("agent failed", "codex", 1, "stderr text", { cause: CAUSE });

  expect(error.name).toBe("DispatchError");
  expect(error.code).toBe(Zer0ErrorCode.AgentDispatchFailed);
  expect(error.agent).toBe("codex");
  expect(error.exitCode).toBe(1);
  expect(error.stderr).toBe("stderr text");
  expect(error.cause).toBe(CAUSE);
});

it("sets MalformedAgentOutputError name, code, agent, preview, and cause", () => {
  const error = new MalformedAgentOutputError("bad output", "gemini", "raw", {
    cause: CAUSE,
  });

  expect(error.name).toBe("MalformedAgentOutputError");
  expect(error.code).toBe(Zer0ErrorCode.AgentMalformedOutput);
  expect(error.agent).toBe("gemini");
  expect(error.preview).toBe("raw");
  expect(error.cause).toBe(CAUSE);
});

it("sets ContextError name, code, and cause", () => {
  const error = new ContextError("budget exceeded", Zer0ErrorCode.ContextOverBudget, {
    cause: CAUSE,
  });

  expect(error.name).toBe("ContextError");
  expect(error.code).toBe(Zer0ErrorCode.ContextOverBudget);
  expect(error.cause).toBe(CAUSE);
});

it("sets StabilityError name, signal, action, and cause", () => {
  const error = new StabilityError(
    "trajectory failed",
    Zer0ErrorCode.WorkerCrashed,
    "SAME_TEST_FAILS",
    "STOP",
    { cause: CAUSE },
  );

  expect(error.name).toBe("StabilityError");
  expect(error.code).toBe(Zer0ErrorCode.WorkerCrashed);
  expect(error.signal).toBe("SAME_TEST_FAILS");
  expect(error.action).toBe("STOP");
  expect(error.cause).toBe(CAUSE);
});

it("narrows typed Zer0 errors and rejects generic errors", () => {
  expect(isZer0Error(new ConfigError("missing config", Zer0ErrorCode.ConfigMissing))).toBe(true);
  expect(isZer0Error(new MalformedAgentOutputError("bad output", "codex", "raw"))).toBe(true);
  expect(isZer0Error(new Error("generic"))).toBe(false);
  expect(isZer0Error({ name: "ConfigError", code: Zer0ErrorCode.ConfigInvalid })).toBe(false);
});
