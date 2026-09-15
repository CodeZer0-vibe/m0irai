/**
 * @file src/shared/types/review.ts
 * @purpose Reviewer verdict/finding/rubric contracts with runtime Zod schemas guarded against interface drift.
 * @exports FindingSeverity, RubricStatus, ReviewVerdict, Finding, RubricResult, RubricReviewOutput, FindingSchema, RubricReviewOutputSchema
 * @depends zod, ./schema-guard.js
 */
import { z } from "zod";
import type { AssertTrue, OptionalUndefined, SchemaMatches } from "./schema-guard.js";

/**
 * Review finding severity.
 */
export type FindingSeverity = "P0" | "P1" | "P2";

/**
 * Requirement rubric result status.
 */
export type RubricStatus = "MET" | "NOT_MET" | "UNVERIFIABLE";

/**
 * Overall review verdict.
 */
export type ReviewVerdict = "PASS" | "FAIL" | "PASS_WITH_COMMENTS";

/**
 * One actionable reviewer finding.
 */
export interface Finding {
  severity: FindingSeverity;
  path: string;
  line?: number;
  finding: string;
  category: string;
  confidence?: number;
}

/**
 * One rubric item and its evidence.
 */
export interface RubricResult {
  id: string;
  status: RubricStatus;
  evidence: string;
}

/**
 * Structured reviewer response validated before gates consume it.
 */
export interface RubricReviewOutput {
  verdict: ReviewVerdict;
  rubricResults: RubricResult[];
  additionalFindings: Finding[];
  categoriesChecked: string[];
}

type FindingSchemaInput = OptionalUndefined<Finding, "line" | "confidence">;
type RubricReviewOutputSchemaInput = Omit<RubricReviewOutput, "additionalFindings"> & {
  additionalFindings: FindingSchemaInput[];
};

const FindingSeveritySchema: z.ZodType<FindingSeverity> = z.enum(["P0", "P1", "P2"]);

const RubricStatusSchema: z.ZodType<RubricStatus> = z.enum(["MET", "NOT_MET", "UNVERIFIABLE"]);

const ReviewVerdictSchema: z.ZodType<ReviewVerdict> = z.enum([
  "PASS",
  "FAIL",
  "PASS_WITH_COMMENTS",
]);

const FindingBaseSchema = z
  .object({
    severity: FindingSeveritySchema,
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    finding: z.string().min(1),
    category: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/** Runtime schema for Finding objects. Validates and normalizes raw input via toFinding. */
export const FindingSchema: z.ZodType<Finding, z.ZodTypeDef, FindingSchemaInput> =
  FindingBaseSchema.transform(toFinding);

const RubricResultSchema: z.ZodType<RubricResult> = z
  .object({
    id: z.string().min(1),
    status: RubricStatusSchema,
    evidence: z.string().min(1),
  })
  .strict();

/** Runtime schema for RubricReviewOutput objects (top-level reviewer output structure). */
export const RubricReviewOutputSchema: z.ZodType<
  RubricReviewOutput,
  z.ZodTypeDef,
  RubricReviewOutputSchemaInput
> = z
  .object({
    verdict: ReviewVerdictSchema,
    rubricResults: z.array(RubricResultSchema),
    additionalFindings: z.array(FindingSchema),
    categoriesChecked: z.array(z.string()),
  })
  .strict();

function toFinding(value: z.infer<typeof FindingBaseSchema>): Finding {
  const finding: Finding = {
    severity: value.severity,
    path: value.path,
    finding: value.finding,
    category: value.category,
  };
  return withFindingOptionals(finding, value);
}

function withFindingOptionals(finding: Finding, value: z.infer<typeof FindingBaseSchema>): Finding {
  const withLine = value.line !== undefined ? { ...finding, line: value.line } : finding;
  if (value.confidence !== undefined) {
    return { ...withLine, confidence: value.confidence };
  }
  return withLine;
}

/**
 * Compile-time guard forcing TypeScript to evaluate schema-versus-interface drift for Finding.
 * Void-referenced (no runtime semantics); typecheck FAILS if the schema and interface diverge.
 */
const _REVIEW_SCHEMA_GUARDS: readonly [AssertTrue<SchemaMatches<typeof FindingSchema, Finding>>] = [
  true,
];
void _REVIEW_SCHEMA_GUARDS;
