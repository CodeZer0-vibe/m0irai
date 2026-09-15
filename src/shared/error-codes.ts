/**
 * @file src/shared/error-codes.ts
 * @purpose Stable Zer0 error code enum and metadata catalog.
 * @exports Zer0ErrorCode, ErrorCategory, ErrorRetryability, ErrorCodeMetadata, ERROR_CODE_METADATA, getErrorMetadata, isZer0ErrorCode, NON_RETRYABLE_ERROR_TYPES
 * @depends (none)
 */

export enum Zer0ErrorCode {
  ConfigInvalid = "ZER0_CONFIG_INVALID",
  ConfigMissing = "ZER0_CONFIG_MISSING",
  TemporalUnreachable = "ZER0_TEMPORAL_UNREACHABLE",
  WorkflowNotFound = "ZER0_WORKFLOW_NOT_FOUND",
  WorkerTaskQueueStalled = "ZER0_WORKER_TASK_QUEUE_STALLED",
  WorkerCrashed = "ZER0_WORKER_CRASHED",
  DbLocked = "ZER0_DB_LOCKED",
  DbCorrupted = "ZER0_DB_CORRUPTED",
  EvidenceSchemaDrift = "ZER0_EVIDENCE_SCHEMA_DRIFT",
  BlobMissing = "ZER0_BLOB_MISSING",
  BlobCorrupted = "ZER0_BLOB_CORRUPTED",
  AgentDispatchFailed = "ZER0_AGENT_DISPATCH_FAILED",
  AgentTimeout = "ZER0_AGENT_TIMEOUT",
  AgentRateLimited = "ZER0_AGENT_RATE_LIMITED",
  AgentStdoutBufferExceeded = "ZER0_AGENT_STDOUT_BUFFER_EXCEEDED",
  AgentMalformedOutput = "ZER0_AGENT_MALFORMED_OUTPUT",
  GateClampViolated = "ZER0_GATE_CLAMP_VIOLATED",
  GateOwnershipViolated = "ZER0_OWNERSHIP_VIOLATION",
  GateNameEmpty = "ZER0_GATE_NAME_EMPTY",
  ContextOverBudget = "ZER0_CONTEXT_OVER_BUDGET",
  ContextNotFound = "ZER0_CONTEXT_NOT_FOUND",
  ContextStaleHash = "ZER0_CONTEXT_STALE_HASH",
  ContextReadFailed = "ZER0_CONTEXT_READ_FAILED",
  SchemaValidationFailed = "ZER0_SCHEMA_VALIDATION_FAILED",
  SchemaMigrationFailed = "ZER0_SCHEMA_MIGRATION_FAILED",
  SecurityDenylistViolation = "ZER0_SECURITY_DENYLIST_VIOLATION",
  SecurityHighEntropy = "ZER0_SECURITY_HIGH_ENTROPY",
  SecurityPrefilterBlocked = "ZER0_SECURITY_PREFILTER_BLOCKED",
  TrackingFileConflict = "ZER0_TRACKING_FILE_CONFLICT",
  TrackingFileMissing = "ZER0_TRACKING_FILE_MISSING",
  EventTooLarge = "ZER0_EVENT_TOO_LARGE",
  CompactionHashMismatch = "ZER0_COMPACTION_HASH_MISMATCH",
  ContextBudgetExceeded = "ZER0_CONTEXT_BUDGET_EXCEEDED",
  ReviewerOutputMalformed = "ZER0_REVIEWER_OUTPUT_MALFORMED",
  RevertNonTipCommit = "ZER0_REVERT_NON_TIP_COMMIT",
}

export type ErrorCategory =
  | "config"
  | "temporal"
  | "worker"
  | "db"
  | "blob"
  | "agent"
  | "gate"
  | "context"
  | "schema"
  | "security";

export type ErrorRetryability = "yes" | "no" | "after_fix" | "after_human";

export interface ErrorCodeMetadata {
  code: Zer0ErrorCode;
  category: ErrorCategory;
  retryability: ErrorRetryability;
  suggestedAction: string;
  relatedErrorCodes: Zer0ErrorCode[];
  evidenceFields: string[];
}

type MetadataSeed = Omit<ErrorCodeMetadata, "code">;

export const ERROR_CODE_METADATA: Record<Zer0ErrorCode, ErrorCodeMetadata> = {
  [Zer0ErrorCode.ConfigInvalid]: metadata(
    Zer0ErrorCode.ConfigInvalid,
    "config",
    "after_fix",
    "Inspect config path and parse error evidence.",
    ["path", "reason"],
  ),
  [Zer0ErrorCode.ConfigMissing]: metadata(
    Zer0ErrorCode.ConfigMissing,
    "config",
    "after_fix",
    "Create the missing config file or pass an explicit path.",
    ["path"],
  ),
  [Zer0ErrorCode.TemporalUnreachable]: metadata(
    Zer0ErrorCode.TemporalUnreachable,
    "temporal",
    "yes",
    "Start Temporal and retry the command.",
    ["address", "namespace"],
  ),
  [Zer0ErrorCode.WorkflowNotFound]: metadata(
    Zer0ErrorCode.WorkflowNotFound,
    "temporal",
    "after_fix",
    "Verify the run id and workflow namespace.",
    ["runId"],
  ),
  [Zer0ErrorCode.WorkerTaskQueueStalled]: metadata(
    Zer0ErrorCode.WorkerTaskQueueStalled,
    "worker",
    "yes",
    "Start a worker for the recorded task queue.",
    ["taskQueue"],
  ),
  [Zer0ErrorCode.WorkerCrashed]: metadata(
    Zer0ErrorCode.WorkerCrashed,
    "worker",
    "yes",
    "Read worker stderr and restart after the crash cause is fixed.",
    ["taskQueue", "stderrBlob"],
  ),
  [Zer0ErrorCode.DbLocked]: metadata(
    Zer0ErrorCode.DbLocked,
    "db",
    "yes",
    "Find the writer holding SQLite and retry after lock release.",
    ["dbPath"],
  ),
  [Zer0ErrorCode.DbCorrupted]: metadata(
    Zer0ErrorCode.DbCorrupted,
    "db",
    "after_human",
    "Copy the DB for forensics and restore from retained evidence.",
    ["dbPath"],
  ),
  [Zer0ErrorCode.EvidenceSchemaDrift]: metadata(
    Zer0ErrorCode.EvidenceSchemaDrift,
    "db",
    "after_fix",
    "Run the supported migration path or inspect schema version drift.",
    ["expected", "actual"],
  ),
  [Zer0ErrorCode.BlobMissing]: metadata(
    Zer0ErrorCode.BlobMissing,
    "blob",
    "after_fix",
    "Resolve the missing blob hash from state and dispatch rows.",
    ["hash", "blobRoot"],
  ),
  [Zer0ErrorCode.BlobCorrupted]: metadata(
    Zer0ErrorCode.BlobCorrupted,
    "blob",
    "after_fix",
    "Recompute blob hash and compare against the ledger row.",
    ["hash", "path"],
  ),
  [Zer0ErrorCode.AgentDispatchFailed]: metadata(
    Zer0ErrorCode.AgentDispatchFailed,
    "agent",
    "after_fix",
    "Read captured stderr and replay the stored dispatch argv.",
    ["agent", "exitCode", "stderrBlob"],
  ),
  [Zer0ErrorCode.AgentTimeout]: metadata(
    Zer0ErrorCode.AgentTimeout,
    "agent",
    "yes",
    "Retry with the same frozen context after checking CLI health.",
    ["agent", "timeoutMs"],
  ),
  [Zer0ErrorCode.AgentRateLimited]: metadata(
    Zer0ErrorCode.AgentRateLimited,
    "agent",
    "yes",
    "Wait for provider quota recovery and replay the dispatch.",
    ["agent"],
  ),
  [Zer0ErrorCode.AgentStdoutBufferExceeded]: metadata(
    Zer0ErrorCode.AgentStdoutBufferExceeded,
    "agent",
    "after_fix",
    "Reduce output volume or raise the configured buffer with evidence.",
    ["agent", "maxBuffer"],
  ),
  [Zer0ErrorCode.AgentMalformedOutput]: metadata(
    Zer0ErrorCode.AgentMalformedOutput,
    "agent",
    "after_fix",
    "Inspect output preview and strict parser schema errors.",
    ["agent", "preview"],
  ),
  [Zer0ErrorCode.GateClampViolated]: metadata(
    Zer0ErrorCode.GateClampViolated,
    "gate",
    "after_fix",
    "Read gate evidence and split or repair the violating code.",
    ["gate", "violations"],
  ),
  [Zer0ErrorCode.GateOwnershipViolated]: metadata(
    Zer0ErrorCode.GateOwnershipViolated,
    "gate",
    "after_fix",
    "Restrict changes to owned files or escalate the ownership mismatch.",
    ["path", "ownedFiles"],
  ),
  [Zer0ErrorCode.GateNameEmpty]: metadata(
    Zer0ErrorCode.GateNameEmpty,
    "gate",
    "after_fix",
    "Pass a non-empty gate name to the gate engine.",
    ["gate"],
  ),
  [Zer0ErrorCode.ContextOverBudget]: metadata(
    Zer0ErrorCode.ContextOverBudget,
    "context",
    "after_fix",
    "Trim lower-signal context until token budget is respected.",
    ["tokenCount", "tokenBudget"],
  ),
  [Zer0ErrorCode.ContextNotFound]: metadata(
    Zer0ErrorCode.ContextNotFound,
    "context",
    "after_fix",
    "Regenerate or locate the missing context artifact.",
    ["path", "taskId"],
  ),
  [Zer0ErrorCode.ContextStaleHash]: metadata(
    Zer0ErrorCode.ContextStaleHash,
    "context",
    "after_fix",
    "Rebuild context after source changes invalidated the hash.",
    ["expectedHash", "actualHash"],
  ),
  [Zer0ErrorCode.ContextReadFailed]: metadata(
    Zer0ErrorCode.ContextReadFailed,
    "context",
    "after_fix",
    "Read the context path error and restore the missing artifact.",
    ["path", "reason"],
  ),
  [Zer0ErrorCode.SchemaValidationFailed]: metadata(
    Zer0ErrorCode.SchemaValidationFailed,
    "schema",
    "after_fix",
    "Validate the JSON document against the schema bundle.",
    ["schemaName", "errors"],
  ),
  [Zer0ErrorCode.SchemaMigrationFailed]: metadata(
    Zer0ErrorCode.SchemaMigrationFailed,
    "schema",
    "after_fix",
    "Inspect migration SQL and DB version rows.",
    ["fromVersion", "toVersion"],
  ),
  [Zer0ErrorCode.SecurityDenylistViolation]: metadata(
    Zer0ErrorCode.SecurityDenylistViolation,
    "security",
    "after_human",
    "Remove denied secret-shaped content before dispatch.",
    ["path", "match"],
  ),
  [Zer0ErrorCode.SecurityHighEntropy]: metadata(
    Zer0ErrorCode.SecurityHighEntropy,
    "security",
    "after_human",
    "Review high-entropy content before it reaches an agent.",
    ["path", "score"],
  ),
  [Zer0ErrorCode.SecurityPrefilterBlocked]: metadata(
    Zer0ErrorCode.SecurityPrefilterBlocked,
    "security",
    "after_human",
    "Read prefilter findings and remove blocked content.",
    ["agent", "reason"],
  ),
  [Zer0ErrorCode.TrackingFileConflict]: metadata(
    Zer0ErrorCode.TrackingFileConflict,
    "context",
    "after_fix",
    "Retry after the active tracking writer completes.",
    ["path", "phase", "attempt"],
  ),
  [Zer0ErrorCode.TrackingFileMissing]: metadata(
    Zer0ErrorCode.TrackingFileMissing,
    "context",
    "after_fix",
    "Regenerate the missing tracking file for this phase attempt.",
    ["path", "phase", "attempt"],
  ),
  [Zer0ErrorCode.EventTooLarge]: metadata(
    Zer0ErrorCode.EventTooLarge,
    "context",
    "after_fix",
    "Reduce tracking event payload size before appending.",
    ["path", "bytes"],
  ),
  [Zer0ErrorCode.CompactionHashMismatch]: metadata(
    Zer0ErrorCode.CompactionHashMismatch,
    "context",
    "after_human",
    "Inspect restored history and archive bytes before retry.",
    ["historyPath", "archivePath"],
  ),
  [Zer0ErrorCode.ContextBudgetExceeded]: metadata(
    Zer0ErrorCode.ContextBudgetExceeded,
    "context",
    "after_human",
    "Split the phase or raise the manifest context budget.",
    ["maxLines", "sections"],
  ),
  [Zer0ErrorCode.ReviewerOutputMalformed]: metadata(
    Zer0ErrorCode.ReviewerOutputMalformed,
    "agent",
    "yes",
    "Reviewer output is not valid JSON matching ReviewReport. Re-dispatch (LLM output is non-deterministic); the workflow escalates after the retry budget is exhausted (SPEC-7).",
    ["reviewer", "stdoutPreview"],
  ),
  [Zer0ErrorCode.RevertNonTipCommit]: metadata(
    Zer0ErrorCode.RevertNonTipCommit,
    "context",
    "after_human",
    "Refusing to revert non-tip commit; investigate worktree state before retry.",
    ["sha", "head"],
  ),
};

/**
 * Looks up metadata for one stable error code.
 *
 * @param code - Zer0 error code
 * @returns metadata entry
 */
export function getErrorMetadata(code: Zer0ErrorCode): ErrorCodeMetadata {
  return ERROR_CODE_METADATA[code];
}

/**
 * Checks whether a value is a known Zer0 error code.
 *
 * @param value - candidate value
 * @returns true when value is a catalogued code
 */
export function isZer0ErrorCode(value: unknown): value is Zer0ErrorCode {
  return typeof value === "string" && Object.values(Zer0ErrorCode).includes(value as Zer0ErrorCode);
}

function metadata(
  code: Zer0ErrorCode,
  category: ErrorCategory,
  retryability: ErrorRetryability,
  suggestedAction: string,
  evidenceFields: string[],
): ErrorCodeMetadata {
  const seed: MetadataSeed = {
    category,
    retryability,
    suggestedAction,
    relatedErrorCodes: [],
    evidenceFields,
  };
  return { code, ...seed };
}

export const NON_RETRYABLE_ERROR_TYPES: readonly string[] = Object.freeze(
  Object.values(ERROR_CODE_METADATA)
    .filter((metadataEntry) => metadataEntry.retryability !== "yes")
    .map((metadataEntry) => metadataEntry.code as string),
);
