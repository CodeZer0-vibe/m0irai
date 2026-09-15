/**
 * @file src/shared/errors.ts
 * @purpose Typed error class hierarchy with discriminated Zer0 error codes.
 * @exports Zer0Error, ConfigError, GateError, DispatchError, MalformedAgentOutputError, ContextError, StabilityError, isZer0Error
 * @depends ./error-codes
 */
import { Zer0ErrorCode } from "./error-codes.js";

/**
 * Error raised when project configuration cannot be loaded or parsed.
 */
export class ConfigError extends Error {
  public readonly code: Zer0ErrorCode;

  public constructor(message: string, code: Zer0ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
  }
}

/**
 * Error raised when a deterministic quality gate fails.
 */
export class GateError extends Error {
  public readonly code: Zer0ErrorCode;
  public readonly gate: string;
  public readonly evidence: Record<string, unknown>;

  public constructor(
    message: string,
    code: Zer0ErrorCode,
    gate: string,
    evidence: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GateError";
    this.code = code;
    this.gate = gate;
    this.evidence = evidence;
  }
}

/**
 * Error raised when an agent process dispatch fails.
 */
export class DispatchError extends Error {
  public readonly code: Zer0ErrorCode;
  public readonly agent: string;
  public readonly exitCode: number;
  public readonly stderr?: string;

  public constructor(
    message: string,
    agent: string,
    exitCode: number,
    stderr?: string,
    options?: DispatchErrorOptions,
  ) {
    super(message, options);
    this.name = "DispatchError";
    this.code = options?.code ?? Zer0ErrorCode.AgentDispatchFailed;
    this.agent = agent;
    this.exitCode = exitCode;
    if (stderr !== undefined) {
      this.stderr = stderr;
    }
  }
}

export interface DispatchErrorOptions extends ErrorOptions {
  code?: Zer0ErrorCode;
}

/**
 * Error raised when an agent response must be structured but cannot be parsed.
 */
export class MalformedAgentOutputError extends Error {
  public readonly code: Zer0ErrorCode.AgentMalformedOutput;
  public readonly agent: string;
  public readonly preview: string;

  public constructor(message: string, agent: string, preview: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MalformedAgentOutputError";
    this.code = Zer0ErrorCode.AgentMalformedOutput;
    this.agent = agent;
    this.preview = preview;
  }
}

/**
 * Error raised when context assembly violates its contract.
 */
export class ContextError extends Error {
  public readonly code: Zer0ErrorCode;

  public constructor(message: string, code: Zer0ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextError";
    this.code = code;
  }
}

/**
 * Error raised when the stability monitor escalates a failing trajectory.
 */
export class StabilityError extends Error {
  public readonly code: Zer0ErrorCode;
  public readonly signal: string;
  public readonly action: string;

  public constructor(
    message: string,
    code: Zer0ErrorCode,
    signal: string,
    action: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StabilityError";
    this.code = code;
    this.signal = signal;
    this.action = action;
  }
}

export type Zer0Error =
  | ConfigError
  | GateError
  | DispatchError
  | MalformedAgentOutputError
  | ContextError
  | StabilityError;

/**
 * Checks whether an unknown value is a typed Zer0 domain error.
 *
 * @param err - value to check
 * @returns true when the value is one of the typed Zer0 errors
 */
export function isZer0Error(err: unknown): err is Zer0Error {
  return (
    err instanceof ConfigError ||
    err instanceof GateError ||
    err instanceof DispatchError ||
    err instanceof MalformedAgentOutputError ||
    err instanceof ContextError ||
    err instanceof StabilityError
  );
}
