/**
 * @file src/shared/types/agent.ts
 * @purpose Model-CLI adapter contract, agent process/health results, and the deterministic gate result with its drift-guarded Zod schema.
 * @exports DispatchMode, AgentAdapter, AgentResult, AgentHealth, GateResult, GateResultSchema
 * @depends zod, ./branded.js, ./schema-guard.js
 */
import { z } from "zod";
import type { AgentName } from "./branded.js";
import type { AssertTrue, OptionalUndefined, SchemaMatches } from "./schema-guard.js";

/**
 * Dispatch mode controlling an agent's write capability and tooling.
 * `build` grants a writable sandbox (codex workspace-write, gemini auto_edit);
 * `chat`/`research` stay read-only. Reviews use `chat` so they cannot mutate the worktree.
 */
export type DispatchMode = "build" | "chat" | "research";

/**
 * Adapter contract for a model CLI.
 *
 * @public Consumed by `src/adapters/registry.ts`; declared in foundation per MODULE-MAP §src/shared.
 */
export interface AgentAdapter {
  name: AgentName;
  buildCommand(contextFile: string, worktreePath: string, mode: DispatchMode): string;
  parseOutput(raw: string, requireStructured?: boolean): AgentResult;
  healthCheck(): Promise<AgentHealth>;
}

/**
 * Parsed result from an agent process.
 */
export interface AgentResult {
  files?: { path: string; content: string }[];
  stdout: string;
  exitCode: number;
  structured?: Record<string, unknown>;
}

/**
 * Health check response for an agent CLI.
 */
export interface AgentHealth {
  healthy: boolean;
  version?: string;
  error?: string;
}

/**
 * Deterministic gate result consumed by the pipeline.
 */
export interface GateResult {
  gate: string;
  passed: boolean;
  evidence: Record<string, unknown>;
  reason?: string;
  retryable?: boolean;
  errors?: string[];
}

type GateResultSchemaInput = OptionalUndefined<GateResult, "reason" | "retryable" | "errors">;

const GateResultBaseSchema = z
  .object({
    gate: z.string().min(1),
    passed: z.boolean(),
    evidence: z.record(z.unknown()),
    reason: z.string().optional(),
    retryable: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
  })
  .strict();

/** Runtime schema for GateResult objects. Validates and normalizes raw input via toGateResult. */
export const GateResultSchema: z.ZodType<GateResult, z.ZodTypeDef, GateResultSchemaInput> =
  GateResultBaseSchema.transform(toGateResult);

function toGateResult(value: z.infer<typeof GateResultBaseSchema>): GateResult {
  const result: GateResult = {
    gate: value.gate,
    passed: value.passed,
    evidence: value.evidence,
  };
  return withGateOptionals(result, value);
}

function withGateOptionals(
  result: GateResult,
  value: z.infer<typeof GateResultBaseSchema>,
): GateResult {
  return {
    ...result,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.retryable !== undefined ? { retryable: value.retryable } : {}),
    ...(value.errors !== undefined ? { errors: value.errors } : {}),
  };
}

/**
 * Compile-time guard forcing TypeScript to evaluate schema-versus-interface drift for GateResult.
 * Void-referenced (no runtime semantics); typecheck FAILS if the schema and interface diverge.
 */
const _AGENT_SCHEMA_GUARDS: readonly [
  AssertTrue<SchemaMatches<typeof GateResultSchema, GateResult>>,
] = [true];
void _AGENT_SCHEMA_GUARDS;
