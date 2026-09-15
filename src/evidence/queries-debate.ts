/**
 * @file src/evidence/queries-debate.ts
 * @purpose Debate persistence query adapters for working sets and active debate leases.
 * @exports debateQueries, ChatWorkingSetDbRow, ActiveDebateDbRow
 * @depends ../shared/types, ./queries-statements, ./types
 */
import { ChatPeerRefsSchema, ChatWorkingSetOutcomeSchema } from "../shared/types.js";
import type { PreparedStatements } from "./queries-statements.js";
import {
  type ListChatWorkingSetsArgs,
  ListChatWorkingSetsArgsSchema,
  type Queries,
} from "./types.js";

export interface ChatWorkingSetDbRow {
  readonly id: string;
  readonly session_id: string;
  readonly turn: number;
  readonly round: number;
  readonly agent: "claude" | "codex" | "gemini";
  readonly context_blob_hash: string;
  readonly peer_refs: string;
  readonly outcome: "ok" | "fail" | "empty" | "timeout" | "cancelled" | "incomplete";
  readonly token_estimate: number | null;
  readonly created_at: string;
}

export interface ActiveDebateDbRow {
  readonly session_id: string;
  readonly turn: number;
  readonly started_at: string;
}

type DebateQueries = Pick<
  Queries,
  | "insertChatWorkingSet"
  | "listChatWorkingSets"
  | "acquireActiveDebate"
  | "getActiveDebate"
  | "releaseActiveDebate"
>;
type InsertChatWorkingSetRow = Parameters<Queries["insertChatWorkingSet"]>[0];
type ChatWorkingSetRow = ReturnType<Queries["listChatWorkingSets"]>[number];
type InsertActiveDebateRow = Parameters<Queries["acquireActiveDebate"]>[0];
type ActiveDebateRow = NonNullable<ReturnType<Queries["getActiveDebate"]>>;

export function debateQueries(statements: PreparedStatements): DebateQueries {
  return {
    insertChatWorkingSet: (row: InsertChatWorkingSetRow): void => {
      statements.insertChatWorkingSet.run(toChatWorkingSetParams(row));
    },
    listChatWorkingSets: (args: ListChatWorkingSetsArgs): readonly ChatWorkingSetRow[] => {
      const parsedArgs = ListChatWorkingSetsArgsSchema.parse(args);
      const rows = statements.listChatWorkingSets.all([
        parsedArgs.sessionId,
        parsedArgs.turn,
        parsedArgs.round,
      ]) as ChatWorkingSetDbRow[];
      return rows.map(toChatWorkingSetRow);
    },
    acquireActiveDebate: (row: InsertActiveDebateRow): boolean => {
      return statements.insertActiveDebate.run(row).changes > 0;
    },
    getActiveDebate: (sessionId: string): ActiveDebateRow | undefined => {
      const row = statements.getActiveDebate.get(sessionId) as ActiveDebateDbRow | undefined;
      return row === undefined ? undefined : toActiveDebateRow(row);
    },
    releaseActiveDebate: (sessionId: string): boolean => {
      return statements.deleteActiveDebate.run(sessionId).changes > 0;
    },
  };
}

function toChatWorkingSetParams(
  row: InsertChatWorkingSetRow,
): Record<string, string | number | null> {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turn: row.turn,
    round: row.round,
    agent: row.agent,
    contextBlobHash: row.contextBlobHash,
    peerRefs: JSON.stringify(ChatPeerRefsSchema.parse(row.peerRefs)),
    outcome: ChatWorkingSetOutcomeSchema.parse(row.outcome),
    tokenEstimate: row.tokenEstimate,
    createdAt: row.createdAt,
  };
}

function toChatWorkingSetRow(row: ChatWorkingSetDbRow): ChatWorkingSetRow {
  const peerRefs: unknown = JSON.parse(row.peer_refs);
  return {
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    round: row.round,
    agent: row.agent,
    contextBlobHash: row.context_blob_hash,
    peerRefs: ChatPeerRefsSchema.parse(peerRefs),
    outcome: ChatWorkingSetOutcomeSchema.parse(row.outcome),
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  };
}

function toActiveDebateRow(row: ActiveDebateDbRow): ActiveDebateRow {
  return {
    sessionId: row.session_id,
    turn: row.turn,
    startedAt: row.started_at,
  };
}
