// @size-justified: round 4 added TWO real-path proof sections (live-FK sampling, commit-ordering)
// to acceptance 5's posture pin alongside its simulacrum; splitting the simulacrum off would orphan
// the empirical regime table below from the pins that cite it. Under the 600-line hard gate.
//
// FL-077 round 3 (acceptance 5) — THE v10->v11 REBUILD POSTURE IS OBSERVED, NOT ASSUMED.
//
// `foreign_keys=OFF` + `legacy_alter_table=ON` must hold DURING the assignments rebuild and be
// restored (and verified) afterwards — PRAGMAs are no-ops inside a transaction, so the posture
// belongs around runGlobalTier's outer BEGIN IMMEDIATE.
//
// METHOD, and why: the posture is per-connection RUNTIME state, invisible in end-state artifacts,
// so part 1 observes the connection's own pragma seam during a REAL triggered rebuild (a sculpted
// pre-v11-shape table forces applyV10ToV11 down the rebuild path inside the tier). THE ACCEPTANCE,
// though, rests on the REAL-PATH assertions (r3b finding 1): the pragma-order pin below is blind to
// WHERE the posture is established, because call ORDER and the restored readback are identical when
// the pragmas are set INSIDE the tier transaction — where SQLite silently ignores them. So part 1b
// re-runs the same real openDb over the sculpted database while SAMPLING the live foreign_keys
// value off the very handle executing each statement (PRAGMA foreign_keys may be QUERIED inside an
// open transaction even though setting it there is a no-op), and then inspects the COMMITTED
// chat_artifacts DDL — the artifact the posture exists to protect. Under the forbidden placement
// every statement runs with enforcement ON and the RENAME rewrites the child FK onto
// _chat_build_assignments_v10, which the rebuild then DROPs: textual damage in the schema that
// row-level checks cannot see on empty tables. Part 2 proves WHY THE FULL POSTURE is required by
// running the same rebuild under each half of it and inspecting sqlite_master: SQLite's RENAME
// rewrites every child FK clause onto the temp table name unless BOTH pragmas hold — probed
// empirically against this build (SQLite 3.53.1):
//   foreign_keys=OFF + legacy_alter_table=OFF -> rewritten   (fk OFF alone is NOT enough)
//   foreign_keys=OFF + legacy_alter_table=ON  -> PRESERVED   (the production posture)
//   foreign_keys=ON  + legacy_alter_table=OFF -> rewritten
//   foreign_keys=ON  + legacy_alter_table=ON  -> rewritten   (fk ON overrides the legacy flag)
// better-sqlite3 turns foreign_keys ON by default on every fresh connection, so a fixture that
// sets only legacy_alter_table silently lands in the rewriting regime. The damage is textual —
// the child chases the temp table the rebuild then DROPs — and lives in the schema even when
// both tables are empty, where row-level checks see nothing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { type Db, closeDb, openDb } from "./db.js";
import { runGlobalTier } from "./migration-tiers.js";
import { MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS } from "./migrations-v8-v12.js";

// The FULL contract shape: chainReadiness reads all three tier lists, so a global-only fixture
// would throw deep inside readiness instead of exercising the rebuild.
const KEYS = {
  global: ["14", "14,15", "14,15,16", "14,15,16,20"],
  memory: ["14,15", "14,15,16", "14,15,16,20"],
  lane: ["14,15,16,20"],
};

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
  }
});

function tempDbPath(): string {
  root = mkdtempSync(join(tmpdir(), "zer0-migration-fk-posture-"));
  return join(root, "evidence.db");
}

interface PragmaObservation {
  readonly sql: string;
  readonly simple: boolean;
  readonly result: unknown;
}

// Wraps ONE connection's pragma seam with a recording pass-through (defineProperty on the
// instance shadows the non-writable prototype method; the original descriptor goes back in the
// finally so the connection ends the test unmodified).
function observePragmas(db: Database.Database): PragmaObservation[] {
  const descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "pragma");
  if (descriptor === undefined || descriptor.value === undefined) {
    throw new Error("Database.prototype.pragma not found — cannot observe the posture");
  }
  const original = descriptor.value;
  const observations: PragmaObservation[] = [];
  Object.defineProperty(db, "pragma", {
    value: function observedPragma(this: Database.Database, source: string, options?: unknown) {
      const result = original.call(this, source, options);
      observations.push({
        sql: String(source),
        simple:
          options !== undefined &&
          options !== null &&
          typeof options === "object" &&
          "simple" in options,
        result,
      });
      return result;
    },
    writable: true,
    configurable: true,
  });
  return observations;
}

function stopObserving(db: Database.Database): void {
  Reflect.deleteProperty(db, "pragma");
}

// --- part 1b: the REAL-PATH acceptance (r3b finding 1) ----------------------------------

interface ForeignKeysSample {
  /** The LIVE foreign_keys value read off the executing connection just before the statement. */
  readonly foreignKeys: string;
  readonly sqlHead: string;
}

// A write-class statement is anything whose FIRST token is not a read, a pragma, or transaction
// control (same classifier the race proof uses; better-sqlite3's internal BEGIN/COMMIT never
// appear on this seam anyway — measured: an .immediate() invocation records no such event).
const NON_WRITE_PREFIXES = /^(SELECT|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i;

// Prototype-level pass-through over exec that samples the LIVE foreign_keys value off whichever
// connection executes each statement (the reviewer probe-fk.mjs shape). Querying the pragma is
// legal inside an open transaction even though SETTING it there is a no-op — that asymmetry is
// exactly what lets this pin observe the regime each statement ACTUALLY ran under instead of
// inferring it from where the setter calls sit in the source. The original descriptor goes back
// in stop() so the connection ends the test unmodified.
function traceForeignKeysDuringExec(): {
  readonly samples: ForeignKeysSample[];
  stop(): void;
} {
  const descriptor = requireSeam(Database.prototype, "exec");
  const pragmaDescriptor = requireSeam(Database.prototype, "pragma");
  const originalExec = descriptor.value as typeof Database.prototype.exec;
  const originalPragma = pragmaDescriptor.value as typeof Database.prototype.pragma;
  const samples: ForeignKeysSample[] = [];
  Object.defineProperty(Database.prototype, "exec", {
    value: function sampledExec(this: Database.Database, sql: string) {
      if (typeof sql === "string") {
        let foreignKeys = "?";
        try {
          foreignKeys = String(originalPragma.call(this, "foreign_keys", { simple: true }));
        } catch {
          foreignKeys = "?"; // sampling must never alter the run; unreadable is recorded as "?"
        }
        samples.push({ foreignKeys, sqlHead: sql.trim().split("\n")[0] ?? "" });
      }
      return originalExec.call(this, sql);
    },
    writable: true,
    configurable: true,
  });
  return {
    samples,
    stop(): void {
      Object.defineProperty(Database.prototype, "exec", descriptor);
    },
  };
}

// The real openDb over a sculpted rebuild-pending database, with every executed statement's live
// FK regime captured. Returns the opened handle so assertions run on the SAME connection.
function openDbSamplingForeignKeys(dbPath: string): {
  db: Db;
  samples: ForeignKeysSample[];
} {
  const tracer = traceForeignKeysDuringExec();
  try {
    return { db: openDb(dbPath), samples: tracer.samples };
  } finally {
    tracer.stop();
  }
}

// --- part 1c: the pre-commit foreign_key_check contract (r3b finding 2) -----------------

type CommitOrderingEvent = "write" | "fk-check" | "tx-exit-top";

interface CommitOrderingTrace {
  readonly events: CommitOrderingEvent[];
  /** Violation rows reported by the LAST foreign_key_check observed. */
  readonly lastCheckViolations: number;
  stop(): void;
}

// Ordered recorder over THREE seams: write-class statements (exec), foreign_key_check calls
// (pragma), and top-level transaction exits (transaction wrapper — better-sqlite3's internal
// BEGIN/COMMIT never surface on prepare/exec, measured, so the exit of a depth-0 .immediate()
// invocation IS the observable commit point). Nested .immediate() calls (savepoints) decrement
// the same depth counter, so only the outermost exit records "tx-exit-top". Each seam's
// installation lives in its own installer below; this function only wires them up and restores.
function requireSeam(owner: object, method: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(owner, method);
  if (descriptor === undefined || descriptor.value === undefined) {
    throw new Error(`Database.prototype.${method} not found — cannot install a tracer seam`);
  }
  return descriptor;
}

interface CommitTraceState {
  lastCheckViolations: number;
  /** Live nesting count across plain/immediate/exclusive invocations; 0 means outside any. */
  depth: number;
}

function installWriteClassRecorder(
  execDescriptor: PropertyDescriptor,
  events: CommitOrderingEvent[],
): void {
  const originalExec = execDescriptor.value as typeof Database.prototype.exec;
  Object.defineProperty(Database.prototype, "exec", {
    value: function tracedExec(this: Database.Database, sql: string) {
      if (typeof sql === "string" && !NON_WRITE_PREFIXES.test(sql.trim())) {
        events.push("write");
      }
      return originalExec.call(this, sql);
    },
    writable: true,
    configurable: true,
  });
}

function installForeignKeyCheckRecorder(
  pragmaDescriptor: PropertyDescriptor,
  state: CommitTraceState,
  events: CommitOrderingEvent[],
): void {
  const originalPragma = pragmaDescriptor.value as typeof Database.prototype.pragma;
  Object.defineProperty(Database.prototype, "pragma", {
    value: function tracedPragma(
      this: Database.Database,
      source: string,
      options?: Parameters<typeof originalPragma>[1],
    ) {
      const result = originalPragma.call(this, source, options);
      if (String(source) === "foreign_key_check") {
        events.push("fk-check");
        state.lastCheckViolations = (result as unknown[]).length;
      }
      return result;
    },
    writable: true,
    configurable: true,
  });
}

function installTransactionExitRecorder(
  txDescriptor: PropertyDescriptor,
  state: CommitTraceState,
  events: CommitOrderingEvent[],
): void {
  const originalTransaction = txDescriptor.value as typeof Database.prototype.transaction;
  Object.defineProperty(Database.prototype, "transaction", {
    value: function tracedTransaction(
      this: Database.Database,
      fn: Parameters<typeof originalTransaction>[0],
    ) {
      const real: Database.Transaction = originalTransaction.call(this, fn);
      type PlainInvocation = (this: Database.Database, ...args: unknown[]) => unknown;
      const depthCounted = (invoke: (args: unknown[]) => unknown): PlainInvocation =>
        function depthCountedInvocation(this: Database.Database, ...args: unknown[]) {
          state.depth += 1;
          try {
            return invoke(args);
          } finally {
            state.depth -= 1;
            if (state.depth === 0) {
              events.push("tx-exit-top");
            }
          }
        };
      // The mode variants are attached below, which is what makes this a real Transaction shape.
      const wrapped = depthCounted((args) => real(...args)) as Database.Transaction;
      for (const mode of ["deferred", "immediate", "exclusive"] as const) {
        const modeFn = real[mode];
        if (typeof modeFn !== "function") continue;
        wrapped[mode] = depthCounted((args) => modeFn.apply(real, args));
      }
      return wrapped;
    },
    writable: true,
    configurable: true,
  });
}

function traceCommitOrdering(): CommitOrderingTrace {
  const execDescriptor = requireSeam(Database.prototype, "exec");
  const pragmaDescriptor = requireSeam(Database.prototype, "pragma");
  const txDescriptor = requireSeam(Database.prototype, "transaction");
  const events: CommitOrderingEvent[] = [];
  const state: CommitTraceState = { lastCheckViolations: 0, depth: 0 };
  installWriteClassRecorder(execDescriptor, events);
  installForeignKeyCheckRecorder(pragmaDescriptor, state, events);
  installTransactionExitRecorder(txDescriptor, state, events);
  return {
    events,
    get lastCheckViolations(): number {
      return state.lastCheckViolations;
    },
    stop(): void {
      Object.defineProperty(Database.prototype, "exec", execDescriptor);
      Object.defineProperty(Database.prototype, "pragma", pragmaDescriptor);
      Object.defineProperty(Database.prototype, "transaction", txDescriptor);
    },
  };
}

// Builds a fully-migrated database, then rewinds it to the shape applyV10ToV11 treats as
// rebuild-pending: an assignments table WITHOUT the v11 CHECK domains, version set {10}.
function sculptRebuildPendingDb(dbPath: string): void {
  closeDb(openDb(dbPath));
  const sculptor = new Database(dbPath);
  try {
    sculptor.exec("DROP TABLE chat_build_assignments");
    sculptor.exec(`CREATE TABLE chat_build_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      task TEXT NOT NULL,
      capability TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    sculptor.exec("DELETE FROM _schema_version");
    sculptor.exec("INSERT INTO _schema_version(version) VALUES (10)");
  } finally {
    sculptor.close();
  }
}

it("during a real rebuild inside the tier, foreign_keys=OFF and legacy_alter_table=ON hold, and both are restored AND read back", () => {
  const dbPath = tempDbPath();
  sculptRebuildPendingDb(dbPath);

  const db = new Database(dbPath);
  const observations = observePragmas(db);
  try {
    runGlobalTier(db, KEYS);
  } finally {
    stopObserving(db);
  }

  // The rebuild path REALLY ran: the committed assignments table now carries the v11 domain.
  const shape = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_build_assignments'")
    .get() as { sql: string };
  expect(shape.sql).toContain("'policy-rejected'");
  expect(versionRows(db)).toEqual([14]);

  // THE CHOREOGRAPHY: posture established BEFORE the tier's writes, restored after them, and the
  // restoration verified by readback against the live connection (results captured, not assumed).
  const indexWhere = (sql: string, simple = false) =>
    observations.findIndex((o) => o.sql === sql && o.simple === simple);
  const fkOff = indexWhere("foreign_keys = OFF");
  const legacyOn = indexWhere("legacy_alter_table = ON");
  const legacyOffRestore = indexWhere("legacy_alter_table = OFF");
  const fkOnRestore = indexWhere("foreign_keys = ON");
  expect(fkOff).toBeGreaterThanOrEqual(0);
  expect(legacyOn).toBeGreaterThan(fkOff);
  expect(legacyOffRestore).toBeGreaterThan(legacyOn);
  expect(fkOnRestore).toBeGreaterThan(legacyOffRestore);

  const fkReadback = observations.filter((o) => o.sql === "foreign_keys" && o.simple);
  const legacyReadback = observations.filter((o) => o.sql === "legacy_alter_table" && o.simple);
  expect(fkReadback.length).toBeGreaterThanOrEqual(1);
  expect(legacyReadback.length).toBeGreaterThanOrEqual(1);
  expect(String(fkReadback[fkReadback.length - 1]?.result)).toBe("1"); // FK enforcement back ON
  expect(String(legacyReadback[legacyReadback.length - 1]?.result)).toBe("0"); // legacy OFF

  db.close();
});

// THE ACCEPTANCE (r3b finding 1): the pragma-order pin above cannot tell posture-established-
// outside-BEGIN from the forbidden inside-the-transaction placement, where both pragmas are
// silent no-ops and the rebuild runs with enforcement ON. Two REAL-PATH pins cover what that
// placement corrupts: the live FK regime each statement ran under, and the COMMITTED
// chat_artifacts DDL — which must still reference the table the rebuild created, never the temp
// table the same migration DROPs.
it("REAL PATH: every write-class statement the rebuild-pending tier executes runs with foreign_keys OFF on this very handle", () => {
  const dbPath = tempDbPath();
  sculptRebuildPendingDb(dbPath);

  const { db, samples } = openDbSamplingForeignKeys(dbPath);
  try {
    // Positive control FIRST: the tier really wrote through this seam (the rebuild really ran),
    // or an empty write set below would mean a broken tracer rather than a clean regime.
    const writes = samples.filter((s) => !NON_WRITE_PREFIXES.test(s.sqlHead));
    expect(writes.length).toBeGreaterThan(0);
    const rename = samples.find((s) => /^ALTER TABLE/i.test(s.sqlHead));
    expect(rename?.sqlHead).toContain("chat_build_assignments");
    expect(rename?.sqlHead).toContain("RENAME");

    // THE REGIME: EVERY write-class statement of the whole widened window — schema.sql, v1..v14,
    // the RENAME itself — read enforcement OFF off this handle. Under the forbidden placement the
    // pragmas are no-ops, so the rename records "1" here.
    expect(
      writes.filter((s) => s.foreignKeys !== "0").map((s) => [s.foreignKeys, s.sqlHead]),
    ).toEqual([]);
    expect(rename?.foreignKeys).toBe("0");
  } finally {
    closeDb(db); // captured-and-closed BEFORE assertions can throw (Windows refuses rmSync behind a handle)
  }
});

it("REAL PATH: the committed chat_artifacts FK still names chat_build_assignments, never the dropped temp table", () => {
  const dbPath = tempDbPath();
  sculptRebuildPendingDb(dbPath);

  const { db, samples } = openDbSamplingForeignKeys(dbPath);
  try {
    // Positive control FIRST: the rebuild really ran on this open, or the DDL assertions below
    // would pass vacuously on a database that never touched v10 -> v11.
    expect(samples.some((s) => /^ALTER TABLE/i.test(s.sqlHead))).toBe(true);

    // Textual damage survives COMMIT even though both tables are empty and row-level checks see
    // nothing — so inspect the committed DDL itself.
    const artifact = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_artifacts'")
      .get() as { sql: string };
    expect(artifact.sql).toContain("REFERENCES chat_build_assignments");
    expect(artifact.sql).not.toContain("_chat_build_assignments_v10");
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_chat_build_assignments_v10'").get(),
    ).toBeUndefined();
    expect(versionRows(db)).toEqual([14]);
  } finally {
    closeDb(db);
  }
});

// PIN (r3b finding 2): while the rebuild posture is held the WHOLE global chain runs with FK
// enforcement OFF — and which regime a database gets is state-dependent (a legacy-shaped
// assignments table flips it for the entire tier; a fresh database never enters the posture at
// all). The in-savepoint check inside applyV10ToV11 therefore covers only the first part of that
// window: v11->v12, v12->v13 and v13->v14 execute after it, unchecked. The contract is a
// foreign_key_check as the tier's LAST statement — after every write, BEFORE the outer COMMIT —
// so violations abort the tier no matter which step produced them.
it("PIN (r3b finding 2): on the rebuild path a foreign_key_check runs after the LAST chain write and before the outer tier commits", () => {
  const dbPath = tempDbPath();
  sculptRebuildPendingDb(dbPath);

  const tracer = traceCommitOrdering();
  let db: Db;
  try {
    db = openDb(dbPath);
  } finally {
    tracer.stop();
  }
  try {
    const events = tracer.events;
    // Fixture sanity FIRST: exactly one top-level transaction exited (the single outer global
    // tier), and the chain really wrote through the traced seam.
    expect(events.filter((e) => e === "tx-exit-top")).toEqual(["tx-exit-top"]);
    const writeIndexes: number[] = [];
    const checkIndexes: number[] = [];
    events.forEach((e, index) => {
      if (e === "write") writeIndexes.push(index);
      if (e === "fk-check") checkIndexes.push(index);
    });
    expect(writeIndexes.length).toBeGreaterThan(0);
    expect(checkIndexes.length).toBeGreaterThanOrEqual(2); // the in-savepoint check AND the pre-commit one

    const lastWrite = writeIndexes[writeIndexes.length - 1] ?? -1;
    const lastCheck = checkIndexes[checkIndexes.length - 1] ?? -1;
    // THE CONTRACT: the final check sits AFTER every write-class statement of the widened window,
    // and BEFORE the top-level exit whose return IS the commit.
    expect(lastCheck).toBeGreaterThan(lastWrite);
    expect(lastCheck).toBeLessThan(events.indexOf("tx-exit-top"));
    // And on this healthy path it QUOTES EMPTINESS — openDb succeeding is not the proof; the
    // recorded result of the check itself is.
    expect(tracer.lastCheckViolations).toBe(0);
  } finally {
    closeDb(db);
  }
});

// --- part 2: why legacy_alter_table=ON exists -------------------------------------------

function artifactFkSqlAfterRebuild(withRebuildPosture: boolean): string {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE chat_build_runs (id TEXT PRIMARY KEY)"); // the rebuild's FK parent
    db.exec(`CREATE TABLE chat_build_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      task TEXT NOT NULL,
      capability TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(
      "CREATE TABLE chat_artifacts (id TEXT PRIMARY KEY, assignment_id TEXT REFERENCES chat_build_assignments(id))",
    );
    if (withRebuildPosture) {
      // Mirrors enterRebuildPosture exactly — BOTH pragmas, because each alone is insufficient
      // (better-sqlite3 defaults foreign_keys ON, and fk ON overrides legacy_alter_table).
      db.pragma("foreign_keys = OFF");
      db.pragma("legacy_alter_table = ON");
    }
    db.exec(MIGRATION_V10_TO_V11_REBUILD_ASSIGNMENTS);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_artifacts'").get() as {
      sql: string | null;
    };
    return row.sql ?? "";
  } finally {
    db.close();
  }
}

it("MUTATION CONTROL: without the rebuild posture the RENAME drags the child FK onto the temp table the rebuild then drops", () => {
  // No pragmas at all: better-sqlite3's default foreign_keys=ON is itself a rewriting regime.
  const damaged = artifactFkSqlAfterRebuild(false);
  expect(damaged).toContain("_chat_build_assignments_v10");
  expect(damaged).not.toContain("REFERENCES chat_build_assignments(id)");
});

it("with the posture, the child FK keeps referencing chat_build_assignments by NAME", () => {
  const intact = artifactFkSqlAfterRebuild(true);
  expect(intact).toContain("REFERENCES chat_build_assignments(id)");
  expect(intact).not.toContain("_chat_build_assignments_v10");
});

function versionRows(db: Database.Database): number[] {
  return (
    db.prepare("SELECT version FROM _schema_version ORDER BY version").all() as Array<{
      version: number;
    }>
  ).map((row) => row.version);
}
