import { expect, expectTypeOf, it } from "vitest";
import type { infer as ZodInfer, ZodType } from "zod";
import type {
  BuildTask,
  ContextRun,
  Finding,
  GateResult,
  PipelineStatus,
  RubricReviewOutput,
} from "./types.js";
import {
  BuildTaskSchema,
  FindingSchema,
  GateResultSchema,
  PipelinePhaseSchema,
  PipelineStatusSchema,
  RubricReviewOutputSchema,
} from "./types.js";

const VALID_PIPELINE_STATUS: PipelineStatus = {
  runId: "run-alpha",
  phase: "build",
  mode: "semi",
  progress: {
    tasksCompleted: 1,
    tasksTotal: 2,
    currentTask: "BUILD-shared",
  },
  blockedAt: null,
  startedAt: "2026-05-03T00:00:00.000Z",
  elapsedMs: 100,
};

const VALID_BUILD_TASK: BuildTask = {
  id: "BUILD-shared",
  implements: "docs/PLAN.md section 15",
  creates: ["src/shared/types.ts"],
  modifies: [],
  reads: ["docs/PLAN.md"],
  contracts: [],
  owned_files: ["src/shared/types.ts"],
  forbidden_files: ["docs/**"],
  acceptance: ["types match plan"],
  depends_on: [],
  enrichment_sources: [],
  requirement_links: ["docs/PLAN.md#15"],
  sandbox_level: 1,
  agent: "codex",
};

const VALID_FINDING: Finding = {
  severity: "P1",
  path: "src/shared/types.ts",
  line: 1,
  finding: "Missing runtime validation",
  category: "type-safety",
  confidence: 0.95,
};

const VALID_REVIEW: RubricReviewOutput = {
  verdict: "PASS_WITH_COMMENTS",
  rubricResults: [{ id: "R1", status: "MET", evidence: "src/shared/types.ts:1" }],
  additionalFindings: [VALID_FINDING],
  categoriesChecked: ["type-safety"],
};

const VALID_GATE: GateResult = {
  gate: "typecheck",
  passed: true,
  evidence: { command: "tsc --noEmit" },
};

const VALID_CONTEXT_RUN: ContextRun = {
  agent: "codex",
  blobPath: ".zer0/blobs/context",
  contextHash: "c".repeat(64),
  headCommit: "abc123",
  id: 1,
  promptHash: "p".repeat(64),
  runId: "run-alpha",
  taskId: "BUILD-shared",
  tokenBudget: 16_000,
  tokenCount: 100,
};

it("keeps schema inference aligned with exported interfaces", () => {
  expectTypeOf<ZodInfer<typeof PipelineStatusSchema>>().toEqualTypeOf<PipelineStatus>();
  expectTypeOf<ZodInfer<typeof BuildTaskSchema>>().toEqualTypeOf<BuildTask>();
  expectTypeOf<ZodInfer<typeof FindingSchema>>().toEqualTypeOf<Finding>();
  expectTypeOf<ZodInfer<typeof RubricReviewOutputSchema>>().toEqualTypeOf<RubricReviewOutput>();
  expectTypeOf<ZodInfer<typeof GateResultSchema>>().toEqualTypeOf<GateResult>();
});

it("accepts valid pipeline status and rejects invalid progress edges", () => {
  expectAccepted(PipelinePhaseSchema, "review");
  expectRejected(PipelinePhaseSchema, "invalid");
  expectAccepted(PipelineStatusSchema, VALID_PIPELINE_STATUS);
  expectRejected(PipelineStatusSchema, { ...VALID_PIPELINE_STATUS, runId: "bad-run" });
  expectRejected(PipelineStatusSchema, {
    ...VALID_PIPELINE_STATUS,
    progress: { ...VALID_PIPELINE_STATUS.progress, tasksCompleted: -1 },
  });
  expectRejected(PipelineStatusSchema, { ...VALID_PIPELINE_STATUS, phase: "done" });
});

it("keeps context run type usable by evidence queries", () => {
  expect(VALID_CONTEXT_RUN.taskId).toBe("BUILD-shared");
});

it("accepts valid build tasks and rejects malformed ownership fields", () => {
  expectAccepted(BuildTaskSchema, VALID_BUILD_TASK);
  expectAccepted(BuildTaskSchema, { ...VALID_BUILD_TASK, tournament: { agents: ["claude"] } });
  expectRejected(BuildTaskSchema, { ...VALID_BUILD_TASK, id: "TASK-shared" });
  expectRejected(BuildTaskSchema, { ...VALID_BUILD_TASK, sandbox_level: 4 });
  expectRejected(BuildTaskSchema, { ...VALID_BUILD_TASK, agent: "openai" });
});

it("accepts valid findings and rejects invalid severity, line, and confidence", () => {
  expectAccepted(FindingSchema, VALID_FINDING);
  expectAccepted(FindingSchema, {
    severity: "P2",
    path: "src/shared/errors.ts",
    finding: "Name not set",
    category: "errors",
  });
  expectRejected(FindingSchema, { ...VALID_FINDING, severity: "P3" });
  expectRejected(FindingSchema, { ...VALID_FINDING, line: 0 });
  expectRejected(FindingSchema, { ...VALID_FINDING, confidence: 2 });
});

it("accepts valid rubric output and rejects malformed review payloads", () => {
  expectAccepted(RubricReviewOutputSchema, VALID_REVIEW);
  expectAccepted(RubricReviewOutputSchema, { ...VALID_REVIEW, additionalFindings: [] });
  expectRejected(RubricReviewOutputSchema, { ...VALID_REVIEW, verdict: "MAYBE" });
  expectRejected(RubricReviewOutputSchema, { ...VALID_REVIEW, rubricResults: [{ id: "" }] });
  expectRejected(RubricReviewOutputSchema, { ...VALID_REVIEW, categoriesChecked: "types" });
});

it("accepts valid gate results and rejects malformed gate evidence", () => {
  expectAccepted(GateResultSchema, VALID_GATE);
  expectAccepted(GateResultSchema, { ...VALID_GATE, retryable: false, errors: ["tsc failed"] });
  expectRejected(GateResultSchema, { ...VALID_GATE, gate: "" });
  expectRejected(GateResultSchema, { ...VALID_GATE, passed: "true" });
  expectRejected(GateResultSchema, { ...VALID_GATE, errors: [1] });
});

function expectAccepted<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

function expectRejected<T>(schema: ZodType<T>, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}
