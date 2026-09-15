/**
 * @file src/chat/types.ts
 * @purpose Chat module domain types and Zod persistence schemas.
 * @exports ChatMessageRole, ChatAgent, ChatDispatchRef, ChatMessage, ChatSession, ChatRoute, DispatchMode, DispatchResult, CommandDispatchResult, AgentRunResult, ChatWorkingSetOutcome, ChatLaunchedPeerRef, ChatUnlaunchedPeerRef, ChatPeerRef, ChatMessageSchema, ChatSessionSchema, WORKING_SET_OUTCOMES, ChatWorkingSetOutcomeSchema, ChatLaunchedPeerRefSchema, ChatUnlaunchedPeerRefSchema, ChatPeerRefSchema, ChatPeerRefsSchema
 * @depends zod, ../shared/types
 */
import { z } from "zod";
import type {
  AgentName as SharedAgentName,
  ChatLaunchedPeerRef as SharedChatLaunchedPeerRef,
  ChatPeerRef as SharedChatPeerRef,
  ChatUnlaunchedPeerRef as SharedChatUnlaunchedPeerRef,
  ChatWorkingSetOutcome as SharedChatWorkingSetOutcome,
} from "../shared/types.js";

export {
  ChatLaunchedPeerRefSchema,
  ChatPeerRefSchema,
  ChatPeerRefsSchema,
  ChatUnlaunchedPeerRefSchema,
  ChatWorkingSetOutcomeSchema,
  WORKING_SET_OUTCOMES,
} from "../shared/types.js";
export type AgentName = SharedAgentName;
export type ChatLaunchedPeerRef = SharedChatLaunchedPeerRef;
export type ChatPeerRef = SharedChatPeerRef;
export type ChatUnlaunchedPeerRef = SharedChatUnlaunchedPeerRef;
export type ChatWorkingSetOutcome = SharedChatWorkingSetOutcome;

export type ChatMessageRole = "user" | "agent" | "system" | "error";
export type ChatAgent = AgentName | "all" | "system" | "user";
export type DispatchMode = "text-only" | "tools" | "pipeline";
export type ChatIntent =
  | "audit"
  | "build"
  | "create"
  | "fix"
  | "general"
  | "opinion"
  | "plan"
  | "research"
  | "review";

/**
 * High-level routing mode chosen for a plain message by the smart-router classifier.
 * `single`/`all`/`debate` are read-only; `build` is write-capable; `research` may be
 * read-only or write-capable depending on whether the request can mutate the workspace.
 */
export type ChatMode = "single" | "all" | "debate" | "research" | "build";

/**
 * Deterministic classification of a plain message: which mode to run, and a human-readable
 * reason (rendered before dispatch — INV-6). VESTIGE SWEEP S8 (2026-07-17): the former
 * write-confirm flag is DELETED — operator ruling (2) killed the y/n confirm-card apparatus (S5);
 * dispatch is unconditional for write-capable classifications.
 */
export interface ClassifiedIntent {
  readonly mode: ChatMode;
  readonly reason: string;
}

export interface ChatDispatchRef {
  readonly promptBlobHash: string;
  readonly outputBlobHash: string;
  readonly stderrPath: string;
  readonly durationMs: number;
  readonly exitCode: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly turn: number;
  readonly role: ChatMessageRole;
  readonly agent: ChatAgent;
  readonly text: string;
  readonly createdAt: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly tokenEstimate: number;
  readonly dispatchRef?: ChatDispatchRef | undefined;
  /** U2e-c #8 (INV-EF7): on a USER-role message, the agents this turn fanned out to (from ChatRoute.agents).
   *  On resume, a dispatched agent with no persisted reply is an `interrupted` lane. Zod-optional ⇒ old
   *  transcripts (no field) parse + render exactly as today. */
  readonly dispatchedAgents?: readonly AgentName[] | undefined;
  readonly roomProvenance?:
    | Readonly<{
        readonly origin: "operator" | "agent-hop";
        readonly replyTo?: string | undefined;
        readonly rootTurnId: string;
        readonly hopId?: string | undefined;
        readonly hopIndex: number;
        readonly hopBudget: number;
        readonly fromAgent?: AgentName | undefined;
        readonly toAgent?: AgentName | undefined;
      }>
    | undefined;
}

export interface ChatSession {
  readonly id: `chat-${string}`;
  readonly repoRoot: string;
  readonly runDir: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultAgent: AgentName;
  readonly lastAgent: AgentName | null;
  readonly summary: { readonly text: string; readonly throughTurn: number };
  readonly messages: readonly ChatMessage[];
}

export interface ChatRoute {
  readonly kind: "agent" | "all" | "slash" | "local";
  readonly agents: readonly AgentName[];
  readonly intent: ChatIntent;
  readonly dispatchMode: DispatchMode;
  readonly codexSandbox: "read-only" | "workspace-write";
  readonly geminiMode: "review";
  readonly slashCommand?: string;
}

export interface DispatchResult {
  readonly agent: AgentName;
  readonly mode: DispatchMode;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
  /** Full child stderr on failure — carried for forensics; bubble/stream use `output` (a summary). */
  readonly rawStderr?: string;
  readonly diffStat?: string;
  readonly filesChanged?: readonly string[];
}

export interface CommandDispatchResult {
  readonly agent: AgentName;
  readonly runResult: AgentRunResult;
  readonly promptContent: string;
  readonly outputContent: string;
  readonly stderrContent: string;
  readonly diffStat?: string;
  readonly filesChanged?: readonly string[];
}

export interface AgentRunResult {
  readonly agent: AgentName;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputPath: string;
}

const AGENT_NAMES = ["claude", "codex", "gemini"] as const;
const CHAT_AGENTS = [...AGENT_NAMES, "all", "system", "user"] as const;
const MESSAGE_ROLES = ["user", "agent", "system", "error"] as const;
const MESSAGE_STATUSES = ["completed", "failed", "cancelled"] as const;

const ChatDispatchRefSchema = z.object({
  promptBlobHash: z.string().min(1),
  outputBlobHash: z.string().min(1),
  stderrPath: z.string().min(1),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int(),
});

const CHAT_SESSION_ID_PATTERN: RegExp = /^chat-/;

export const ChatMessageSchema: z.ZodType<ChatMessage> = z.object({
  id: z.string().min(1),
  turn: z.number().int().nonnegative(),
  role: z.enum(MESSAGE_ROLES),
  agent: z.enum(CHAT_AGENTS),
  text: z.string(),
  createdAt: z.string().min(1),
  status: z.enum(MESSAGE_STATUSES),
  tokenEstimate: z.number().int().nonnegative(),
  dispatchRef: ChatDispatchRefSchema.optional(),
  dispatchedAgents: z.array(z.enum(AGENT_NAMES)).optional(), // U2e-c #8 (INV-EF7); optional ⇒ old rows parse
  roomProvenance: z
    .object({
      origin: z.enum(["operator", "agent-hop"]),
      replyTo: z.string().optional(),
      rootTurnId: z.string().min(1),
      hopId: z.string().optional(),
      hopIndex: z.number().int().nonnegative(),
      hopBudget: z.number().int().nonnegative(),
      fromAgent: z.enum(AGENT_NAMES).optional(),
      toAgent: z.enum(AGENT_NAMES).optional(),
    })
    .optional(),
});

export const ChatSessionSchema: z.ZodType<ChatSession> = z.object({
  id: z.custom<`chat-${string}`>(
    (v: unknown): v is `chat-${string}` => typeof v === "string" && CHAT_SESSION_ID_PATTERN.test(v),
    "ChatSession id must start with chat-",
  ),
  repoRoot: z.string().min(1),
  runDir: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  defaultAgent: z.enum(AGENT_NAMES),
  lastAgent: z.enum(AGENT_NAMES).nullable(),
  summary: z.object({
    text: z.string(),
    throughTurn: z.number().int().nonnegative(),
  }),
  messages: z.array(ChatMessageSchema),
});
