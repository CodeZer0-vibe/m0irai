/**
 * @file src/shared/types/evidence.ts
 * @purpose Context-compilation and build-result records persisted to the evidence ledger.
 * @exports ContextRun, ContextPack, ContextItem, BuildResult
 * @depends ./branded.js
 */
import type { AgentName, RunId, TaskId } from "./branded.js";

/**
 * Persisted context compilation run stored in the evidence ledger.
 */
export interface ContextRun {
  id: number;
  taskId: TaskId;
  runId: RunId;
  agent: AgentName;
  headCommit: string;
  promptHash: string;
  contextHash: string;
  tokenCount: number;
  tokenBudget: number;
  blobPath: string;
}

/**
 * Compiled context bundle delivered to an agent dispatch.
 *
 * @public Declared in foundation per MODULE-MAP §src/shared; its two consumers (prompt-builder, the pipeline dispatch activity) left in m0irai 3.6/3.5 — it stays as the shape `ContextRun` carries.
 */
export interface ContextPack {
  assembled: string;
  hash: string;
  tokenCount: number;
  budget: number;
  items: ContextItem[];
  enrichmentFlags: string[];
}

/**
 * One source item included in a context pack.
 */
export interface ContextItem {
  id?: number;
  contextRunId?: number;
  kind: "hot" | "warm" | "cold";
  path: string;
  symbol?: string;
  contentHash: string;
  tokenCount: number;
  score: number;
  reason: string;
}

/**
 * Builder output summary captured after gates run.
 *
 * @public Consumed by `src/evidence/types.ts` (the pipeline evidence activity that also consumed it left with Temporal, m0irai 3.5); declared in foundation per MODULE-MAP §src/shared.
 */
export interface BuildResult {
  agent: AgentName;
  files: { path: string; action: "created" | "modified" }[];
  testsPassed: boolean;
  lintClean: boolean;
  diffLines: number;
  acceptanceMet: number;
  stdout: string;
  stderr: string;
}
