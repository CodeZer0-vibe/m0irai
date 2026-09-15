/**
 * @file src/shared/types/chat.ts
 * @purpose Chat working-set peer references and outcomes with runtime Zod schemas guarded against interface drift.
 * @exports ChatWorkingSetOutcome, ChatLaunchedPeerRef, ChatUnlaunchedPeerRef, ChatPeerRef, WORKING_SET_OUTCOMES, ChatWorkingSetOutcomeSchema, ChatLaunchedPeerRefSchema, ChatUnlaunchedPeerRefSchema, ChatPeerRefSchema, ChatPeerRefsSchema
 * @depends zod, ./branded.js, ./schema-guard.js
 */
import { z } from "zod";
import { AgentNameSchema } from "./branded.js";
import type { AgentName } from "./branded.js";
import type { AssertTrue, SchemaMatches } from "./schema-guard.js";

export const WORKING_SET_OUTCOMES: readonly [
  "ok",
  "fail",
  "empty",
  "timeout",
  "cancelled",
  "incomplete",
] = ["ok", "fail", "empty", "timeout", "cancelled", "incomplete"];

export type ChatWorkingSetOutcome = (typeof WORKING_SET_OUTCOMES)[number];
export interface ChatLaunchedPeerRef {
  readonly agent: AgentName;
  readonly status: ChatWorkingSetOutcome;
  readonly dispatch_id: string;
  readonly attempt_id?: undefined;
  readonly output_blob_hash?: string | undefined;
  readonly error_summary_blob_hash?: string | undefined;
}

export interface ChatUnlaunchedPeerRef {
  readonly agent: AgentName;
  readonly status: ChatWorkingSetOutcome;
  readonly dispatch_id?: undefined;
  readonly attempt_id: string;
  readonly output_blob_hash?: string | undefined;
  readonly error_summary_blob_hash?: string | undefined;
}

export type ChatPeerRef = ChatLaunchedPeerRef | ChatUnlaunchedPeerRef;

export const ChatWorkingSetOutcomeSchema: z.ZodType<ChatWorkingSetOutcome> =
  z.enum(WORKING_SET_OUTCOMES);

export const ChatLaunchedPeerRefSchema: z.ZodType<ChatLaunchedPeerRef> = z
  .object({
    agent: AgentNameSchema,
    status: ChatWorkingSetOutcomeSchema,
    dispatch_id: z.string().min(1),
    attempt_id: z.never().optional(),
    output_blob_hash: z.string().min(1).optional(),
    error_summary_blob_hash: z.string().min(1).optional(),
  })
  .strict();

export const ChatUnlaunchedPeerRefSchema: z.ZodType<ChatUnlaunchedPeerRef> = z
  .object({
    agent: AgentNameSchema,
    status: ChatWorkingSetOutcomeSchema,
    dispatch_id: z.never().optional(),
    attempt_id: z.string().min(1),
    output_blob_hash: z.string().min(1).optional(),
    error_summary_blob_hash: z.string().min(1).optional(),
  })
  .strict();

export const ChatPeerRefSchema: z.ZodType<ChatPeerRef> = z.union([
  ChatLaunchedPeerRefSchema,
  ChatUnlaunchedPeerRefSchema,
]);
export const ChatPeerRefsSchema: z.ZodType<readonly ChatPeerRef[]> = z.array(ChatPeerRefSchema);

/**
 * Compile-time guards forcing TypeScript to evaluate schema-versus-interface drift for each chat peer type.
 * Void-referenced (no runtime semantics); typecheck FAILS if a schema and its interface diverge.
 */
const _CHAT_SCHEMA_GUARDS: readonly [
  AssertTrue<SchemaMatches<typeof ChatWorkingSetOutcomeSchema, ChatWorkingSetOutcome>>,
  AssertTrue<SchemaMatches<typeof ChatLaunchedPeerRefSchema, ChatLaunchedPeerRef>>,
  AssertTrue<SchemaMatches<typeof ChatUnlaunchedPeerRefSchema, ChatUnlaunchedPeerRef>>,
  AssertTrue<SchemaMatches<typeof ChatPeerRefSchema, ChatPeerRef>>,
] = [true, true, true, true];
void _CHAT_SCHEMA_GUARDS;
