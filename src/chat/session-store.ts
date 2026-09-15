/**
 * @file src/chat/session-store.ts
 * @purpose Create, load, persist, and resume chat sessions to .council/runs/chat-{id}/.
 * @exports createSession, loadSession, readSession, readSessionUpdatedAt, persistSession, appendMessage, canonicalTranscript, listSessions, listSessionDirs, writePromptFile, appendDispatchLog, SessionDirsOutcome
 * @depends node:crypto, node:fs/promises, node:path, ../memory/project-scope, ../shared/atomic-write, ../shared/config, ../shared/logger, ./evidence, ./lane-transport, ./transcript-order, ./transcript-read, ./types
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectId } from "../memory/project-scope.js";
import { writeFileAtomic } from "../shared/atomic-write.js";
import { loadConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { recordChatSession } from "./evidence.js";
import { carrierRuntime } from "./lane-transport.js";
import {
  type SessionReadOutcome,
  type SessionStampOutcome,
  readTranscript,
  readTranscriptStamp,
} from "./transcript-read.js";
import type { AgentName, ChatMessage, ChatSession } from "./types.js";

const COUNCIL_RUNS_DIR: string = ".council/runs";
const TRANSCRIPT_FILE: string = "transcript.json";
const PROMPTS_DIR: string = "prompts";
const RESPONSES_DIR: string = "responses";
const STDERR_DIR: string = "stderr";
const DISPATCH_LOG_FILE: string = "dispatch-log.jsonl";
const TURN_PAD_WIDTH: number = 4;
const UTF8: BufferEncoding = "utf8";
const JSON_INDENT: number = 2;
const EVIDENCE_PHASE: string = "chat-session-store";

const logger = createLogger();

export interface DispatchLogEntry {
  readonly agent: AgentName;
  readonly turn: number;
  readonly round?: number;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly tokenEstimate: number;
  readonly timestamp: string;
}

export async function createSession(repoRoot: string): Promise<ChatSession> {
  // Uniqueness is carried by the full randomUUID, NOT Date.now() (mirrors mintMessageId): two cockpits that
  // create a session in the SAME millisecond in the SAME repo MUST get distinct ids — else they share one
  // .council/runs/<id> dir (prompts/responses/evidence AND agy's per-session .agy-conversation handle) and
  // cross sessions (codex BLOCK: multi-instance isolation). The epoch prefix keeps ids readable + time-sortable.
  const id = `chat-${Date.now()}-${randomUUID()}` as `chat-${string}`;
  const runDir = path.join(repoRoot, COUNCIL_RUNS_DIR, id);
  await mkdir(path.join(runDir, PROMPTS_DIR), { recursive: true });
  await mkdir(path.join(runDir, RESPONSES_DIR), { recursive: true });
  await mkdir(path.join(runDir, STDERR_DIR), { recursive: true });
  const now = new Date().toISOString();
  const session: ChatSession = {
    id,
    repoRoot,
    runDir,
    createdAt: now,
    updatedAt: now,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
  await persistSession(session);
  return session;
}

/**
 * The throwing view of {@link readTranscript}, whose module owns the transcript file format. Every
 * failure throws, which is what existing callers expect: they treat a thrown `loadSession` as
 * "corrupt/unreadable -> start fresh" (session-resume.ts). A caller that needs to tell those failures
 * apart — and the attach path must, because only one of them means the file is broken — uses
 * {@link readSession} instead.
 */
export async function loadSession(
  sessionId: `chat-${string}`,
  repoRoot: string,
): Promise<ChatSession> {
  const read = await readTranscript(sessionId, repoRoot);
  if (read.outcome.kind === "loaded") return read.outcome.session;
  // The ORIGINAL error, never a rewrapping of it: callers read `.code` for ENOENT and one test pins the
  // id-mismatch wording, so this throws exactly what each step threw before the classifier existed.
  throw read.cause;
}

/** {@link loadSession}'s work without the throw: the verdict, so the caller can answer the right fact. */
export async function readSession(
  sessionId: `chat-${string}`,
  repoRoot: string,
  sharingBudgetMs?: number,
): Promise<SessionReadOutcome> {
  return (await readTranscript(sessionId, repoRoot, sharingBudgetMs)).outcome;
}

/** When a room was last saved, read without parsing the whole transcript where the header allows it. */
export async function readSessionUpdatedAt(
  sessionId: `chat-${string}`,
  repoRoot: string,
  sharingBudgetMs?: number,
): Promise<SessionStampOutcome> {
  return readTranscriptStamp(sessionId, repoRoot, sharingBudgetMs);
}

/**
 * The transcript is REPLACED, never rewritten in place: the destination is only ever the target of a
 * rename, so a crash, a full disk or a refused replace all leave the previous file byte-identical and
 * loadable. It used to be one `writeFile`, which truncates first — a room killed mid-write came back
 * as a partial JSON document and vanished from `session/list` with nothing on stderr.
 *
 * Saves of one room are also serialized here rather than at each caller, so the order the room ACCEPTED
 * turns in is the order they reach the disk. An atomic rename settles who wins a race, not who should.
 */
export async function persistSession(session: ChatSession): Promise<void> {
  const transcriptPath = path.join(session.runDir, TRANSCRIPT_FILE);
  await serializedByTranscript(transcriptPath, async () => {
    try {
      await writeFileAtomic(transcriptPath, JSON.stringify(session, null, JSON_INDENT));
    } catch (error) {
      throw new Error(
        `could not save the room transcript ${transcriptPath}: ${describeFailure(error)} This turn is still in the room journal (room-events.jsonl) and the evidence ledger, so reopening the room restores it.`,
        { cause: error },
      );
    }
    // Inside the same queue, so the metadata row cannot record an older turn than the transcript does.
    // These remain TWO stores, not one transaction: a transcript that lands while this row fails leaves
    // the row stale until the next save, and boot recovery rebuilds from the ledger either way.
    await persistSessionEvidence(session);
  });
}

interface TranscriptWriteQueue {
  tail: Promise<void>;
  depth: number;
}

// One queue per transcript path, created on demand and dropped as soon as the last writer leaves, so a
// repo with thousands of rooms never accumulates an entry per room it has finished writing.
const transcriptWrites = new Map<string, TranscriptWriteQueue>();

async function serializedByTranscript(
  transcriptPath: string,
  write: () => Promise<void>,
): Promise<void> {
  if (transcriptPath.length === 0) throw new Error("a session must know its transcript path");
  const queue = transcriptWrites.get(transcriptPath) ?? { tail: Promise.resolve(), depth: 0 };
  transcriptWrites.set(transcriptPath, queue);
  queue.depth += 1;
  const running = queue.tail.then(write);
  queue.tail = running.catch(() => undefined);
  try {
    await running;
  } finally {
    queue.depth -= 1;
    if (queue.depth === 0) transcriptWrites.delete(transcriptPath);
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function appendMessage(session: ChatSession, message: ChatMessage): ChatSession {
  const lastAgent = isAgentName(message.agent) ? message.agent : session.lastAgent;
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    lastAgent,
    messages: [...session.messages, message],
  };
}

// The ask-order view lives in the LEAF module transcript-order.ts (types-only imports) so prompt-builder
// can consume it without the evidence → prompt-builder → session-store → evidence cycle. Re-exported here
// for the existing consumers (headless-prompt, handoff).
export { canonicalTranscript } from "./transcript-order.js";

/** The room directories on disk, or the reason the runs directory could not be enumerated. */
export type SessionDirsOutcome =
  | { readonly kind: "listed"; readonly sessionIds: readonly `chat-${string}`[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * A runs directory that does not exist yet is genuinely EMPTY — that is a fresh repo, not a fault. Any
 * other failure (a permission denial, an I/O error, a file sitting where the directory belongs) is
 * REPORTED, because answering "you have no rooms" to an operator who has three hundred is the same
 * class of lie as hiding a damaged one.
 */
export async function listSessionDirs(repoRoot: string): Promise<SessionDirsOutcome> {
  const runsDir = path.join(repoRoot, COUNCIL_RUNS_DIR);
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    return {
      kind: "listed",
      sessionIds: entries
        .filter((e) => e.isDirectory() && e.name.startsWith("chat-"))
        // The `startsWith("chat-")` filter above guarantees the brand; assert it HERE (the one justified
        // place) so callers can feed these IDs straight into `loadSession(sessionId: \`chat-${string}\`)`.
        .map((e) => e.name as `chat-${string}`)
        .sort()
        .reverse(),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "listed", sessionIds: [] };
    return { kind: "unreadable", reason: `${runsDir}: ${describeFailure(error)}` };
  }
}

/**
 * The tolerant view, unchanged: any failure reads as "no rooms". Kept for the digest catch-up scan,
 * whose whole job is best-effort background work that must never take the boot down with it. Anything
 * the operator will SEE the result of uses `listSessionDirs` and reports the failure instead.
 */
export async function listSessions(repoRoot: string): Promise<readonly `chat-${string}`[]> {
  const outcome = await listSessionDirs(repoRoot);
  return outcome.kind === "listed" ? outcome.sessionIds : [];
}

export async function writePromptFile(
  session: ChatSession,
  turn: number,
  agent: AgentName,
  content: string,
  round?: number,
): Promise<string> {
  const filePath = path.join(session.runDir, PROMPTS_DIR, turnFileName(turn, agent, "md", round));
  await writeFile(filePath, content, UTF8);
  return filePath;
}

export async function appendDispatchLog(
  session: ChatSession,
  entry: DispatchLogEntry,
): Promise<void> {
  const logPath = path.join(session.runDir, DISPATCH_LOG_FILE);
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, UTF8);
}

function turnFileName(turn: number, agent: AgentName, ext: string, round?: number): string {
  const pad = String(turn).padStart(TURN_PAD_WIDTH, "0");
  if (round !== undefined) {
    return `turn-${pad}-r${String(round)}-${agent}.${ext}`;
  }
  return `turn-${pad}-${agent}.${ext}`;
}

function isAgentName(value: string): value is AgentName {
  return value === "claude" || value === "codex" || value === "gemini";
}

// W4-R3a C2: the run's OWN store, never a fresh ambient re-derivation. A bare `loadConfig()` here resolved
// DEFAULT_DB_PATH (".zer0/evidence.db", config.ts:17) against whatever cwd the PROCESS happens to hold at
// save time — so a session whose caller had correctly opened an isolated db still had its session rows
// written somewhere else entirely. Measured, not hypothetical: that is how 14,434 junk chat_sessions rows
// (109 per `npm test`) reached the operator's dogfood DB from fixtures whose own db paths were isolated.
// The carrier runtime is the run's persistence owner and already holds the path the cockpit booted with;
// loadConfig stays the honest answer ONLY where there is no owner (memory off / non-carrier), unchanged.
function sessionEvidenceDbPath(): string {
  return carrierRuntime()?.dbPath ?? loadConfig().dbPath;
}

async function persistSessionEvidence(session: ChatSession): Promise<void> {
  try {
    const projectId = await resolveSessionProjectId(session.repoRoot);
    await recordChatSession({
      dbPath: sessionEvidenceDbPath(),
      sessionId: session.id,
      runId: `run-${session.id}`,
      repoRoot: session.repoRoot,
      runDir: session.runDir,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      defaultAgent: session.defaultAgent,
      lastAgent: session.lastAgent,
      summaryText: session.summary.text,
      summaryThroughTurn: session.summary.throughTurn,
      ...(projectId !== undefined ? { projectId } : {}),
    });
  } catch (error) {
    logger.warn({ phase: EVIDENCE_PHASE }, "chat session evidence write failed", {
      reason: error instanceof Error ? error.message : String(error),
      session: session.id,
    });
  }
}

// C1 (llm#3): resolve FRESH every persist — the former repoRoot-keyed cache was never invalidated, so an
// origin change mid-session (the remote fingerprint is part of the projectId hash) returned a STALE id.
// Keying by the full scope tuple is circular (computing the key requires the full resolve), so the correct
// fix is to always resolve. resolveProjectId (~3 git reads) is on the post-turn persist path — off the render
// thread, alongside recordChatSession's own async DB write — never the operator's critical path.
async function resolveSessionProjectId(repoRoot: string): Promise<string | undefined> {
  const scope = await resolveProjectId(repoRoot);
  return scope.kind === "scoped" ? scope.projectId : undefined;
}
