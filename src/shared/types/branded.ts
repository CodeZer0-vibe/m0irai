/**
 * @file src/shared/types/branded.ts
 * @purpose Branded run/task/agent identifiers and their Zod guards — the leaf types every other shared domain builds on.
 * @exports RunId, TaskId, AgentName, RunIdSchema, TaskIdSchema, AgentNameSchema
 * @depends zod
 */
import { z } from "zod";

const RUN_ID_PATTERN: RegExp = /^run-/;
const TASK_ID_PATTERN: RegExp = /^BUILD-/;

/**
 * Unique identifier for one pipeline run.
 */
export type RunId = `run-${string}`;

/**
 * Unique identifier for one build packet.
 */
export type TaskId = `BUILD-${string}`;

/**
 * Supported model CLI families.
 */
export type AgentName = "claude" | "codex" | "gemini";

export const RunIdSchema: z.ZodType<RunId> = z.custom<RunId>(
  (value: unknown): value is RunId => typeof value === "string" && RUN_ID_PATTERN.test(value),
  "RunId must start with run-",
);

export const TaskIdSchema: z.ZodType<TaskId> = z.custom<TaskId>(
  (value: unknown): value is TaskId => typeof value === "string" && TASK_ID_PATTERN.test(value),
  "TaskId must start with BUILD-",
);

export const AgentNameSchema: z.ZodType<AgentName> = z.enum(["claude", "codex", "gemini"]);
