import { describe, expect, it } from "vitest";
import { ConfigError } from "../shared/errors.js";
import {
  findingId,
  nowIso,
  toChatMessageParams,
  toChatSessionParams,
  toContextItemParams,
  toContextRunParams,
  toDispatchParams,
  toErrorParams,
  toEventParams,
  toFindingParams,
  toGateTransitionParams,
  toRunStatusParams,
  toTaskParams,
  toTaskStatusParams,
} from "./queries-params.js";
import type { InsertFindingArgs } from "./types.js";

const RUN_ID = "run-1" as const;
const TASK_ID = "BUILD-1" as const;

function findingArgs(overrides: Partial<InsertFindingArgs> = {}): InsertFindingArgs {
  return {
    severity: "P1",
    path: "src/a.ts",
    line: 42,
    finding: "missing nullcheck",
    category: "test",
    taskId: TASK_ID,
    runId: RUN_ID,
    sourceAgent: "claude",
    ...overrides,
  };
}

describe("run and task param mappers", () => {
  it("toRunStatusParams defaults completedAt to null for non-complete status", () => {
    expect(toRunStatusParams({ id: RUN_ID, status: "running" })).toEqual({
      id: RUN_ID,
      status: "running",
      completedAt: null,
    });
  });

  it("toRunStatusParams honours an explicit completedAt", () => {
    const at = "2026-05-28T00:00:00.000Z";
    expect(toRunStatusParams({ id: RUN_ID, status: "completed", completedAt: at })).toEqual({
      id: RUN_ID,
      status: "completed",
      completedAt: at,
    });
  });

  it("toTaskParams JSON-encodes array fields", () => {
    expect(
      toTaskParams({
        id: TASK_ID,
        runId: RUN_ID,
        objective: "build",
        agent: "codex",
        ownedFiles: ["src/a.ts"],
        forbiddenFiles: ["src/b.ts"],
        acceptance: ["passes"],
      }),
    ).toEqual({
      id: TASK_ID,
      runId: RUN_ID,
      objective: "build",
      agent: "codex",
      ownedFiles: JSON.stringify(["src/a.ts"]),
      forbiddenFiles: JSON.stringify(["src/b.ts"]),
      acceptance: JSON.stringify(["passes"]),
    });
  });
});

describe("task status validation", () => {
  it("toTaskStatusParams throws ConfigError when completing without a head commit", () => {
    expect(() => toTaskStatusParams({ id: TASK_ID, status: "completed" })).toThrow(ConfigError);
  });

  it("toTaskStatusParams maps undefined result to null", () => {
    expect(toTaskStatusParams({ id: TASK_ID, status: "running" })).toEqual({
      id: TASK_ID,
      status: "running",
      result: null,
      headCommit: null,
    });
  });
});

describe("context param mappers", () => {
  it("toContextRunParams projects every column", () => {
    expect(
      toContextRunParams({
        agent: "codex",
        blobPath: ".zer0/blobs/x",
        contextHash: "c".repeat(64),
        headCommit: "abc",
        id: 1,
        promptHash: "p".repeat(64),
        runId: RUN_ID,
        taskId: TASK_ID,
        tokenBudget: 16_000,
        tokenCount: 12,
      }),
    ).toMatchObject({ id: 1, taskId: TASK_ID, agent: "codex", tokenBudget: 16_000 });
  });

  it("toContextItemParams throws ConfigError when id is missing", () => {
    expect(() => toContextItemParams(contextItemWithoutId())).toThrow(ConfigError);
  });

  it("toContextItemParams maps an absent symbol to null", () => {
    expect(toContextItemParams(contextItem()).symbol).toBeNull();
  });
});

function contextItem(): Parameters<typeof toContextItemParams>[0] {
  return {
    contentHash: "a".repeat(64),
    contextRunId: 1,
    id: 2,
    kind: "hot",
    path: "src/a.ts",
    reason: "ownership",
    score: 1,
    tokenCount: 12,
  };
}

function contextItemWithoutId(): Parameters<typeof toContextItemParams>[0] {
  const { id: _id, ...rest } = contextItem();
  return rest as Parameters<typeof toContextItemParams>[0];
}

describe("finding param mappers", () => {
  it("toFindingParams composes a deterministic id and open status", () => {
    const params = toFindingParams(findingArgs());
    expect(params).toMatchObject({
      id: `${RUN_ID}:${TASK_ID}:claude:P1:missing nullcheck`,
      status: "open",
      line: 42,
      reviewerContextHash: null,
    });
  });

  it("toFindingParams maps an absent line to null", () => {
    const { line: _line, ...withoutLine } = findingArgs();
    expect(toFindingParams(withoutLine).line).toBeNull();
  });

  it("findingId joins run, task, agent, severity, and finding", () => {
    expect(findingId(findingArgs())).toBe(`${RUN_ID}:${TASK_ID}:claude:P1:missing nullcheck`);
  });
});

describe("gate, dispatch, event, and error mappers", () => {
  it("toGateTransitionParams encodes the boolean pass flag as 1/0 and JSON evidence", () => {
    expect(
      toGateTransitionParams({
        runId: RUN_ID,
        fromState: "build",
        toState: "review",
        gateName: "typecheck",
        passed: true,
        evidence: { ok: true },
      }),
    ).toMatchObject({ passed: 1, evidenceJson: JSON.stringify({ ok: true }), idPrefix: "gate-" });
  });

  it("toDispatchParams defaults optional fields to null", () => {
    expect(
      toDispatchParams({
        taskId: TASK_ID,
        agent: "codex",
        commandHash: "h".repeat(64),
        exitCode: 0,
        stdoutBlob: "s".repeat(64),
        durationMs: 100,
      }),
    ).toMatchObject({ idPrefix: "dispatch-", stderrBlob: null, tokensIn: null, repoCommit: null });
  });

  it("toEventParams threads the sequence and nulls optional fields", () => {
    expect(
      toEventParams({ id: "e1", runId: RUN_ID, kind: "phase", payloadJson: "{}" }, 7),
    ).toMatchObject({ id: "e1", sequence: 7, phase: null, taskId: null });
  });

  it("toErrorParams nulls optional foreign keys", () => {
    expect(
      toErrorParams({
        id: "err-1",
        code: "X",
        category: "config",
        retryability: "fatal",
        message: "boom",
        evidenceJson: "{}",
        fingerprint: "fp",
      }),
    ).toMatchObject({ id: "err-1", runId: null, taskId: null, dispatchId: null });
  });
});

describe("chat param mappers", () => {
  it("toChatSessionParams passes through every session field", () => {
    expect(
      toChatSessionParams({
        id: "sess-1",
        runId: RUN_ID,
        repoRoot: "/repo",
        runDir: ".zer0/runs/x",
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:01.000Z",
        defaultAgent: "claude",
        lastAgent: null,
        summaryText: "",
        summaryThroughTurn: 0,
      }),
    ).toMatchObject({ id: "sess-1", runId: RUN_ID, defaultAgent: "claude", lastAgent: null });
  });

  it("toChatMessageParams passes through every message field", () => {
    expect(
      toChatMessageParams({
        id: "msg-1",
        sessionId: "sess-1",
        turn: 0,
        role: "user",
        agent: "user",
        textBlobHash: "deadbeef",
        createdAt: "2026-05-28T00:00:00.000Z",
        status: "completed",
        tokenEstimate: 1,
        dispatchId: null,
      }),
    ).toMatchObject({ id: "msg-1", sessionId: "sess-1", role: "user", dispatchId: null });
  });
});

describe("nowIso", () => {
  it("returns an ISO-8601 UTC timestamp", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
