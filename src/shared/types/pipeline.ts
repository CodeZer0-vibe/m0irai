/**
 * @file src/shared/types/pipeline.ts
 * @purpose Pipeline phase/status projections and the build-packet contract, with runtime Zod schemas guarded against interface drift.
 * @exports PipelinePhase, ControlMode, PipelineStatus, BuildTask, PipelinePhaseSchema, PipelineStatusSchema, BuildTaskSchema
 * @depends zod, ./branded.js, ./schema-guard.js
 */
import { z } from "zod";
import { AgentNameSchema, RunIdSchema, TaskIdSchema } from "./branded.js";
import type { AgentName, RunId, TaskId } from "./branded.js";
import type { AssertTrue, OptionalUndefined, SchemaMatches } from "./schema-guard.js";

/**
 * Pipeline phases persisted in Temporal status projections.
 */
export type PipelinePhase =
  | "init"
  | "recon"
  | "intent"
  | "qa"
  | "research"
  | "spec"
  | "architecture"
  | "plan"
  | "build"
  | "review"
  | "audit"
  | "ship"
  | "completed"
  | "failed"
  | "blocked";

/**
 * Human approval policy for pipeline execution.
 */
export type ControlMode = "auto" | "semi" | "full";

/**
 * Current observable state for a pipeline run.
 */
export interface PipelineStatus {
  runId: RunId;
  phase: PipelinePhase;
  mode: ControlMode;
  progress: {
    tasksCompleted: number;
    tasksTotal: number;
    currentTask: TaskId | null;
  };
  blockedAt: string | null;
  startedAt: string;
  elapsedMs: number;
}

/**
 * Build packet sent to a builder agent.
 */
export interface BuildTask {
  id: TaskId;
  implements: string;
  creates: string[];
  modifies: string[];
  reads: string[];
  contracts: string[];
  owned_files: string[];
  forbidden_files: string[];
  acceptance: string[];
  depends_on: TaskId[];
  enrichment_sources: string[];
  requirement_links: string[];
  sandbox_level: 0 | 1 | 2 | 3;
  agent: AgentName;
  tournament?: { agents: AgentName[] };
}

type BuildTaskSchemaInput = OptionalUndefined<BuildTask, "tournament">;

export const PipelinePhaseSchema: z.ZodType<PipelinePhase> = z.enum([
  "init",
  "recon",
  "intent",
  "qa",
  "research",
  "spec",
  "architecture",
  "plan",
  "build",
  "review",
  "audit",
  "ship",
  "completed",
  "failed",
  "blocked",
]);

const ControlModeSchema: z.ZodType<ControlMode> = z.enum(["auto", "semi", "full"]);

/**
 * Runtime schema for PipelineStatus objects.
 */
export const PipelineStatusSchema: z.ZodType<PipelineStatus> = z
  .object({
    runId: RunIdSchema,
    phase: PipelinePhaseSchema,
    mode: ControlModeSchema,
    progress: z.object({
      tasksCompleted: z.number().int().nonnegative(),
      tasksTotal: z.number().int().nonnegative(),
      currentTask: TaskIdSchema.nullable(),
    }),
    blockedAt: z.string().nullable(),
    startedAt: z.string(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

const BuildTaskBaseSchema = z
  .object({
    id: TaskIdSchema,
    implements: z.string().min(1),
    creates: z.array(z.string()),
    modifies: z.array(z.string()),
    reads: z.array(z.string()),
    contracts: z.array(z.string()),
    owned_files: z.array(z.string()),
    forbidden_files: z.array(z.string()),
    acceptance: z.array(z.string()),
    depends_on: z.array(TaskIdSchema),
    enrichment_sources: z.array(z.string()),
    requirement_links: z.array(z.string()),
    sandbox_level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    agent: AgentNameSchema,
    tournament: z
      .object({ agents: z.array(AgentNameSchema) })
      .strict()
      .optional(),
  })
  .strict();

/** Runtime schema for BuildTask objects. Validates and normalizes raw input via toBuildTask. */
export const BuildTaskSchema: z.ZodType<BuildTask, z.ZodTypeDef, BuildTaskSchemaInput> =
  BuildTaskBaseSchema.transform(toBuildTask);

function toBuildTask(value: z.infer<typeof BuildTaskBaseSchema>): BuildTask {
  const task: BuildTask = {
    id: value.id,
    implements: value.implements,
    creates: value.creates,
    modifies: value.modifies,
    reads: value.reads,
    contracts: value.contracts,
    owned_files: value.owned_files,
    forbidden_files: value.forbidden_files,
    acceptance: value.acceptance,
    depends_on: value.depends_on,
    enrichment_sources: value.enrichment_sources,
    requirement_links: value.requirement_links,
    sandbox_level: value.sandbox_level,
    agent: value.agent,
  };
  if (value.tournament !== undefined) {
    return { ...task, tournament: value.tournament };
  }
  return task;
}

/**
 * Compile-time guard forcing TypeScript to evaluate schema-versus-interface drift for BuildTask.
 * Void-referenced (no runtime semantics); typecheck FAILS if the schema and interface diverge.
 */
const _PIPELINE_SCHEMA_GUARDS: readonly [
  AssertTrue<SchemaMatches<typeof BuildTaskSchema, BuildTask>>,
] = [true];
void _PIPELINE_SCHEMA_GUARDS;
