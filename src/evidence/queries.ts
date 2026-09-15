/**
 * @file src/evidence/queries.ts
 * @purpose Public barrel: assembles the evidence Queries port from statement, param, and row modules.
 * @exports Queries, createQueries, PersistedFinding, InsertChatSessionRow, InsertChatMessageRow, FindDispatchIdArgs
 * @depends ./db, ./queries-statements, ./queries-params, ./queries-rows, ./types, ../shared/types
 */
import type { ContextItem, ContextRun, Finding, RunId, TaskId } from "../shared/types.js";
import type { Db } from "./db.js";
import { debateQueries } from "./queries-debate.js";
import {
  SEARCH_DEFAULT_LIMIT,
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
import {
  findFindingsByRunId,
  getContextRun,
  listContextItems,
  queryErrors,
  searchFindings,
} from "./queries-rows.js";
import { type PreparedStatements, prepareStatements } from "./queries-statements.js";
import type {
  ErrorRow,
  EventRow,
  FindDispatchIdArgs as FindDispatchIdArgsDef,
  InsertChatMessageRow as InsertChatMessageRowDef,
  InsertChatSessionRow as InsertChatSessionRowDef,
  InsertDispatchArgs,
  InsertErrorArgs,
  InsertEventArgs,
  InsertFindingArgs,
  InsertGateTransitionArgs,
  InsertRunArgs,
  InsertTaskArgs,
  NextSequenceRow,
  PersistedFinding as PersistedFindingDef,
  Queries as QueriesDef,
  QueryErrorsArgs,
  RowIdRow,
  UpdateRunStatusArgs,
  UpdateTaskStatusArgs,
} from "./types.js";

export type Queries = QueriesDef;
export type PersistedFinding = PersistedFindingDef;
export type InsertChatSessionRow = InsertChatSessionRowDef;
export type InsertChatMessageRow = InsertChatMessageRowDef;
export type FindDispatchIdArgs = FindDispatchIdArgsDef;

type InsertFindingTransaction = (args: InsertFindingArgs) => void;
type InsertEventTransaction = (args: InsertEventArgs) => EventRow;

interface DispatchIdRow {
  readonly id: string;
}

export function createQueries(db: Db): Queries {
  const statements = prepareStatements(db);
  const insertFindingTransaction = createInsertFindingTransaction(db, statements);
  const insertEventTransaction = createInsertEventTransaction(db, statements);
  return {
    ...baseQueries(statements, insertFindingTransaction),
    ...observabilityQueries(statements, insertEventTransaction),
    close: (): void => undefined,
  };
}

// M4 REBASE ROUND 2 (review R5-F2) — BEGIN IMMEDIATE, and immediate BY CONSTRUCTION.
//
// These two factories used to `return db.transaction(...)` and let the caller invoke the wrapper.
// That is how `insertEvent` ended up running DEFERRED: its body reads `nextEventSequence` before it
// writes, and SQLite fails a deferred read→write upgrade with SQLITE_BUSY *without invoking the busy
// handler*, because two connections both waiting there could deadlock. Measured on the real seam
// under a held writer lock: it threw in 0.5 ms against a busy_timeout of 5000 ms
// (queries-write-immediate.test.ts holds that number down). Same defect class FL-077 removed from
// the opener path; it survived here because queries.ts was outside the structural pin's old
// three-file scope, which now covers every non-test source in src/evidence.
//
// The shape below is deliberate, not cosmetic. The wrapper is NAMED here and invoked `.immediate`
// here, and what escapes to the caller is a plain arrow. A caller therefore CANNOT invoke it
// deferred — there is no `.deferred` to reach — and the structural pin in
// transaction-immediate-pin.test.ts can see the call site, which it could not when the wrapper
// escaped the file.
function createInsertFindingTransaction(
  db: Db,
  statements: PreparedStatements,
): InsertFindingTransaction {
  const insertFindingTxn = db.transaction((args: InsertFindingArgs): void => {
    const params = toFindingParams(args);
    const result = statements.insertFinding.run(params);
    if (result.changes === 0) {
      return;
    }
    const row = statements.selectFindingRowid.get(params.id) as RowIdRow | undefined;
    if (row !== undefined) {
      statements.insertFindingFts.run([row.rowid, args.finding]);
    }
  });
  return (args: InsertFindingArgs): void => {
    insertFindingTxn.immediate(args);
  };
}

function createInsertEventTransaction(
  db: Db,
  statements: PreparedStatements,
): InsertEventTransaction {
  const insertEventTxn = db.transaction((args: InsertEventArgs): EventRow => {
    const row = statements.nextEventSequence.get(args.runId) as NextSequenceRow;
    statements.insertEvent.run(toEventParams(args, row.sequence));
    return statements.getEventById.get(args.id) as EventRow;
  });
  return (args: InsertEventArgs): EventRow => insertEventTxn.immediate(args);
}

type BaseQueries = Omit<
  Queries,
  | "insertEvent"
  | "insertError"
  | "queryErrors"
  | "queryEventsByRun"
  | "getLatestStateSnapshot"
  | "close"
>;

function baseQueries(
  statements: PreparedStatements,
  insertFindingTransaction: InsertFindingTransaction,
): BaseQueries {
  return {
    ...writeQueries(statements, insertFindingTransaction),
    ...readQueries(statements),
    ...debateQueries(statements),
  };
}

function writeQueries(
  statements: PreparedStatements,
  insertFindingTransaction: InsertFindingTransaction,
): Pick<
  BaseQueries,
  | "insertRun"
  | "updateRunStatus"
  | "insertTask"
  | "insertContextRun"
  | "insertContextItem"
  | "updateTaskStatus"
  | "insertFinding"
  | "insertChatSession"
  | "insertChatMessage"
> {
  return {
    insertRun: (args: InsertRunArgs): void => {
      statements.insertRun.run(args);
    },
    updateRunStatus: (args: UpdateRunStatusArgs): void => {
      statements.updateRunStatus.run(toRunStatusParams(args));
    },
    insertTask: (args: InsertTaskArgs): void => {
      statements.insertTask.run(toTaskParams(args));
    },
    insertContextRun: (run: ContextRun): void => {
      statements.insertContextRun.run(toContextRunParams(run));
    },
    insertContextItem: (item: ContextItem): void => {
      statements.insertContextItem.run(toContextItemParams(item));
    },
    updateTaskStatus: (args: UpdateTaskStatusArgs): void => {
      statements.updateTaskStatus.run(toTaskStatusParams(args));
    },
    insertFinding: (args: InsertFindingArgs): void => insertFindingTransaction(args),
    insertChatSession: (row: InsertChatSessionRow): void => {
      statements.insertChatSession.run(toChatSessionParams(row));
    },
    insertChatMessage: (row: InsertChatMessageRow): void => {
      statements.insertChatMessage.run(toChatMessageParams(row));
    },
  };
}

function readQueries(
  statements: PreparedStatements,
): Pick<
  BaseQueries,
  | "getContextRun"
  | "listContextItems"
  | "findFindingsByRunId"
  | "searchFindings"
  | "insertGateTransition"
  | "insertDispatch"
  | "findDispatchId"
> {
  return {
    getContextRun: (runId: RunId, taskId: TaskId): ContextRun | undefined =>
      getContextRun(statements, runId, taskId),
    listContextItems: (contextRunId: number): ContextItem[] =>
      listContextItems(statements, contextRunId),
    findFindingsByRunId: (runId: RunId): readonly PersistedFinding[] =>
      findFindingsByRunId(statements, runId),
    searchFindings: (query: string, limit?: number): Finding[] =>
      searchFindings(statements, query, limit),
    insertGateTransition: (args: InsertGateTransitionArgs): boolean => {
      return statements.insertGateTransition.run(toGateTransitionParams(args)).changes > 0;
    },
    insertDispatch: (args: InsertDispatchArgs): boolean => {
      return statements.insertDispatch.run(toDispatchParams(args)).changes > 0;
    },
    findDispatchId: (args: FindDispatchIdArgs): string | undefined => {
      const row = statements.findDispatchId.get([args.taskId, args.agent, args.commandHash]) as
        | DispatchIdRow
        | undefined;
      return row?.id;
    },
  };
}

function observabilityQueries(
  statements: PreparedStatements,
  insertEventTransaction: InsertEventTransaction,
): Pick<
  Queries,
  "insertEvent" | "insertError" | "queryErrors" | "queryEventsByRun" | "getLatestStateSnapshot"
> {
  return {
    insertEvent: (args: InsertEventArgs): EventRow => insertEventTransaction(args),
    insertError: (args: InsertErrorArgs): void => {
      statements.insertError.run(toErrorParams(args));
    },
    queryErrors: (args?: QueryErrorsArgs): ErrorRow[] => queryErrors(statements, args),
    queryEventsByRun: (runId: RunId, limit?: number, cursor = 0): EventRow[] => {
      return statements.queryEventsByRun.all([
        runId,
        cursor,
        limit ?? SEARCH_DEFAULT_LIMIT,
      ]) as EventRow[];
    },
    getLatestStateSnapshot: (runId: RunId): EventRow | undefined => {
      return statements.getLatestStateSnapshot.get([runId, "state-snapshot"]) as
        | EventRow
        | undefined;
    },
  };
}
