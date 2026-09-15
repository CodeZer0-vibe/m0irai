/**
 * @file src/shared/types.ts
 * @purpose Re-export barrel for the shared cross-cutting type surface — split into ./types/ domain modules; import shared types from here.
 * @exports (re-export barrel — full shared public surface: 28 types + 12 schemas/consts sourced from the ./types/ domain modules)
 * @depends ./types/*
 */
export { BuildTaskSchema, PipelinePhaseSchema, PipelineStatusSchema } from "./types/pipeline.js";
export { FindingSchema, RubricReviewOutputSchema } from "./types/review.js";
export { GateResultSchema } from "./types/agent.js";
export {
  ChatLaunchedPeerRefSchema,
  ChatPeerRefSchema,
  ChatPeerRefsSchema,
  ChatUnlaunchedPeerRefSchema,
  ChatWorkingSetOutcomeSchema,
  WORKING_SET_OUTCOMES,
} from "./types/chat.js";
export type { AgentName, RunId, TaskId } from "./types/branded.js";
export type { BuildTask, ControlMode, PipelinePhase, PipelineStatus } from "./types/pipeline.js";
export type {
  Finding,
  FindingSeverity,
  ReviewVerdict,
  RubricResult,
  RubricReviewOutput,
  RubricStatus,
} from "./types/review.js";
export type {
  AgentAdapter,
  AgentHealth,
  AgentResult,
  DispatchMode,
  GateResult,
} from "./types/agent.js";
export type { BuildResult, ContextItem, ContextPack, ContextRun } from "./types/evidence.js";
export type {
  ChatLaunchedPeerRef,
  ChatPeerRef,
  ChatUnlaunchedPeerRef,
  ChatWorkingSetOutcome,
} from "./types/chat.js";
