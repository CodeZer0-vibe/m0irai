import { afterEach, expect, it, vi } from "vitest";
import { Zer0ErrorCode } from "./error-codes.js";
import { createDbLogger, createLogger } from "./logger.js";

const ISO_PREFIX_PATTERN: RegExp = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /;
const INFO_SUFFIX: string = '[INFO] [-/build/BUILD-1/codex] started {"ok":true}\n';

let captured: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ZER0_LOG_LEVEL = undefined;
  captured = [];
});

it("writes formatted info logs to stderr", () => {
  captureStderr();
  const logger = createLogger();

  logger.info({ phase: "build", task: "BUILD-1", agent: "codex" }, "started", { ok: true });

  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatch(ISO_PREFIX_PATTERN);
  expect(captured[0]?.endsWith(INFO_SUFFIX)).toBe(true);
});

it("suppresses debug logs at the default info level", () => {
  captureStderr();
  const logger = createLogger();

  logger.debug({ phase: "build" }, "hidden");

  expect(captured).toEqual([]);
});

it("emits debug logs when the debug level is requested", () => {
  captureStderr();
  const logger = createLogger({ level: "debug" });

  logger.debug({ phase: "review", task: "BUILD-2", agent: "claude" }, "visible");

  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain("[DEBUG] [-/review/BUILD-2/claude] visible {}");
});

it("emits debug logs when the environment requests debug level", () => {
  captureStderr();
  process.env.ZER0_LOG_LEVEL = "debug";
  const logger = createLogger();

  logger.debug({ phase: "audit", agent: "gemini" }, "env-visible", { count: 1 });

  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain('[DEBUG] [-/audit/-/gemini] env-visible {"count":1}');
});

it("respects ZER0_LOG_LEVEL=debug env override when no opts.level provided", () => {
  const original = process.env.ZER0_LOG_LEVEL;
  process.env.ZER0_LOG_LEVEL = "debug";

  try {
    captureStderr();
    createLogger().debug({ phase: "test" }, "should write");

    expect(captured).toHaveLength(1);
  } finally {
    if (original === undefined) {
      process.env.ZER0_LOG_LEVEL = undefined;
    } else {
      process.env.ZER0_LOG_LEVEL = original;
    }
  }
});

it("uses explicit log level before the environment override", () => {
  process.env.ZER0_LOG_LEVEL = "debug";
  captureStderr();
  const logger = createLogger({ level: "error" });

  logger.debug({ phase: "test" }, "suppressed");

  expect(captured).toEqual([]);
});

it("floors to debug when ZER0_DEBUG is set (the master switch implies full audit logging)", () => {
  const original = process.env.ZER0_DEBUG;
  process.env.ZER0_DEBUG = "1";
  try {
    captureStderr();
    createLogger().debug({ phase: "audit" }, "switch-visible");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("[DEBUG]");
  } finally {
    restoreDebugEnv(original);
  }
});

it("does NOT floor when ZER0_DEBUG=0 (the falsy sentinel stays at info)", () => {
  const original = process.env.ZER0_DEBUG;
  process.env.ZER0_DEBUG = "0";
  try {
    captureStderr();
    createLogger().debug({ phase: "audit" }, "still-hidden");

    expect(captured).toEqual([]);
  } finally {
    restoreDebugEnv(original);
  }
});

function restoreDebugEnv(original: string | undefined): void {
  if (original === undefined) {
    Reflect.deleteProperty(process.env, "ZER0_DEBUG");
  } else {
    process.env.ZER0_DEBUG = original;
  }
}

it("filters messages below the configured error level", () => {
  captureStderr();
  const logger = createLogger({ level: "error" });

  logger.warn({ phase: "gate" }, "suppressed");
  logger.error({ phase: "gate", task: "BUILD-3" }, "failed", { reason: "tsc" });

  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain('[ERROR] [-/gate/BUILD-3/-] failed {"reason":"tsc"}');
});

it("does not throw when meta contains a circular reference", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  captureStderr();
  const logger = createLogger();

  expect(() => logger.info({ phase: "test" }, "msg", circular)).not.toThrow();

  expect(captured.at(-1)).toContain("_meta_serialization_error");
});

it("serializes plain meta unchanged", () => {
  captureStderr();
  const logger = createLogger();

  logger.info({ phase: "test" }, "msg", { ok: 1 });

  expect(captured.at(-1)).toContain('"ok":1');
  expect(captured.at(-1)).not.toContain("_meta_serialization_error");
});

it("includes runId in the default context when present", () => {
  captureStderr();
  const logger = createLogger();

  logger.info({ agent: "codex", phase: "build", runId: "run-1", task: "BUILD-1" }, "started");

  expect(captured.at(-1)).toContain("[INFO] [run-1/build/BUILD-1/codex] started {}");
});

it("does not require runId for log entries", () => {
  captureStderr();
  const logger = createLogger();

  expect(() => logger.info({ phase: "build" }, "started")).not.toThrow();

  expect(captured.at(-1)).toContain("[INFO] [-/build/-/-] started {}");
});

it("createDbLogger writes log events and error rows", () => {
  captureStderr();
  const db = fakeDb();
  const logger = createDbLogger({ runId: "run-logger", db, source: "test" });

  logger.error({ phase: "test" }, "failed", { code: Zer0ErrorCode.AgentDispatchFailed });

  expect(db.events).toHaveLength(1);
  expect(db.errors).toHaveLength(1);
  expect(captured.at(-1)).toContain("failed");
});

it("createDbLogger swallows DB write failures after stderr output", () => {
  captureStderr();
  const db = throwingDb();
  const logger = createDbLogger({ runId: "run-logger", db, source: "test" });

  expect(() => logger.info({ phase: "test" }, "msg")).not.toThrow();
  expect(captured.join("")).toContain("database log write failed");
});

it("FAIL-SOFT (sol wave-8 DECISION 3): a throwing process.stderr.write never propagates out of the logger", () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("EPIPE: broken pipe");
  });
  const logger = createLogger();

  // Every debug/info/warn/error call site across the codebase — including ones sitting inside a
  // db.transaction() callback — depends on this never throwing (a real Windows EPIPE-on-closed-
  // stderr case). "Logging can never affect outcomes" is only true if THIS is true.
  expect(() => logger.error({ phase: "test" }, "should survive a broken pipe")).not.toThrow();
});

it("FAIL-SOFT: a swallowed sink failure increments the diagnostic counter (never silence without a trace)", async () => {
  const { loggerSinkFailureCount, resetLoggerSinkFailureCount } = await import("./logger.js");
  resetLoggerSinkFailureCount();
  vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("EPIPE: broken pipe");
  });
  const logger = createLogger();
  const before = loggerSinkFailureCount();

  logger.error({ phase: "test" }, "swallowed but counted");

  expect(loggerSinkFailureCount()).toBe(before + 1);
  resetLoggerSinkFailureCount();
});

function captureStderr(): void {
  vi.spyOn(process.stderr, "write").mockImplementation(
    (...args: Parameters<typeof process.stderr.write>): boolean => {
      captured.push(String(args[0]));
      return true;
    },
  );
}

interface FakeDb {
  events: unknown[][];
  errors: unknown[][];
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

function fakeDb(): FakeDb {
  const db: FakeDb = {
    errors: [],
    events: [],
    prepare: (sql: string) => ({
      get: (): unknown => ({ sequence: db.events.length + 1 }),
      run: (...args: unknown[]): unknown => {
        if (sql.includes("INSERT INTO events")) {
          db.events.push(args);
        }
        if (sql.includes("INSERT INTO errors")) {
          db.errors.push(args);
        }
        return {};
      },
    }),
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
  };
  return db;
}

function throwingDb(): FakeDb {
  return {
    errors: [],
    events: [],
    prepare: () => ({
      get: (): unknown => {
        throw new Error("db write denied");
      },
      run: (): unknown => {
        throw new Error("db write denied");
      },
    }),
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
  };
}
