/**
 * @file src/chat/transcript-read.ts
 * @purpose Read one room transcript and say exactly which of four things is wrong with it, holding the bytes it judged.
 * @exports TranscriptFailure, SessionReadOutcome, SessionStampOutcome, ClassifiedTranscript, readTranscript, readTranscriptStamp, TRANSCRIPT_FILE, COUNCIL_RUNS_DIR
 * @depends node:fs/promises, node:path, ../shared/atomic-write, ./types
 */
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { retryOnSharingViolation } from "../shared/atomic-write.js";
import type { ChatSession } from "./types.js";
import { ChatSessionSchema } from "./types.js";

export const COUNCIL_RUNS_DIR: string = ".council/runs";
export const TRANSCRIPT_FILE: string = "transcript.json";

/**
 * How much of a transcript the stamp probe reads to answer "when was this room last touched".
 * `JSON.stringify(session, null, 2)` puts `updatedAt` fifth among the top-level members: measured at
 * byte 328 for a room whose repoRoot and runDir are both full Windows temp paths, so this is ~25x the
 * observed need. A transcript whose header does not reconstruct falls back to a whole-file read.
 */
const STAMP_PREFIX_BYTES = 8_192;

/**
 * How much of a schema failure reaches the operator. Zod's own message is a JSON dump of every failing
 * path — 545 characters for one missing member, and unbounded in the size of the transcript, since it
 * echoes received values. An operator-facing sentence needs the shape of the problem, not the dump.
 */
const SCHEMA_REASON_MAX_CHARS = 200;

/** Clips by CODE POINT, so a message carrying operator text is never cut through a character. */
function clipReason(reason: string): string {
  const points = Array.from(reason);
  return points.length <= SCHEMA_REASON_MAX_CHARS
    ? reason
    : `${points.slice(0, SCHEMA_REASON_MAX_CHARS).join("")}… (${String(points.length)} characters in full)`;
}

/**
 * The four ways reading one transcript can fail, kept apart because the right answer to each differs.
 * `absent` — the file is not there. `unreadable` — the bytes could not be obtained, so NOTHING is known
 * about the content and nothing may be done to the file; `code` carries the errno so a caller can tell a
 * retried sharing violation from a permanent failure. `damaged` — the bytes were obtained and are not a
 * readable transcript, and they travel WITH the verdict so a caller quarantines what was judged rather
 * than whatever the path holds later. `incompatible` — the bytes parse but are not this room's history.
 */
export type TranscriptFailure =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string; readonly code: string | undefined }
  | { readonly kind: "damaged"; readonly reason: string; readonly bytes: Uint8Array }
  | { readonly kind: "incompatible"; readonly reason: string };

export type SessionReadOutcome =
  | { readonly kind: "loaded"; readonly session: ChatSession }
  | TranscriptFailure;

/**
 * When a room was last saved. `session` is present only when the stamp cost a whole-file read anyway,
 * so the caller can use that load instead of paying for a second one.
 */
export type SessionStampOutcome =
  | {
      readonly kind: "stamped";
      readonly updatedAt: string;
      readonly session: ChatSession | undefined;
    }
  | TranscriptFailure;

/** The verdict plus the error each step actually threw, so `loadSession` can rethrow the original. */
export interface ClassifiedTranscript {
  readonly outcome: SessionReadOutcome;
  readonly cause: unknown;
}

export function transcriptPathFor(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, COUNCIL_RUNS_DIR, sessionId, TRANSCRIPT_FILE);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the transcript as BYTES and decodes them strictly.
 *
 * Reading it as a UTF-8 string instead lets Node substitute U+FFFD for every invalid byte, so a file
 * holding a stray 0xFF parsed, loaded, and was rewritten without its original content — the operator's
 * history quietly replaced by replacement characters. Node documents the strict alternative on
 * `new TextDecoder`: "fatal <boolean> true if decoding failures are fatal", and on `textDecoder.fatal`:
 * "The value will be true if decoding errors result in a TypeError being thrown."
 * https://nodejs.org/api/util.html#class-utiltextdecoder
 */
export async function readTranscript(
  sessionId: `chat-${string}`,
  repoRoot: string,
  sharingBudgetMs?: number,
): Promise<ClassifiedTranscript> {
  const runDir = path.join(repoRoot, COUNCIL_RUNS_DIR, sessionId);
  const transcriptPath = path.join(runDir, TRANSCRIPT_FILE);
  let bytes: Buffer;
  try {
    bytes = await retryOnSharingViolation(() => readFile(transcriptPath), sharingBudgetMs);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { outcome: { kind: "absent" }, cause: error };
    return {
      outcome: { kind: "unreadable", reason: describe(error), code: errorCode(error) },
      cause: error,
    };
  }
  return classifyBytes(bytes, { sessionId, repoRoot, runDir, transcriptPath });
}

interface TranscriptAt {
  readonly sessionId: `chat-${string}`;
  readonly repoRoot: string;
  readonly runDir: string;
  readonly transcriptPath: string;
}

function classifyBytes(bytes: Buffer, at: TranscriptAt): ClassifiedTranscript {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return {
      outcome: {
        kind: "damaged",
        reason: `${at.transcriptPath} is not valid UTF-8: ${describe(error)}`,
        bytes,
      },
      cause: error,
    };
  }
  return classifyText(text, bytes, at);
}

function classifyText(text: string, bytes: Buffer, at: TranscriptAt): ClassifiedTranscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      outcome: {
        kind: "damaged",
        reason: `${at.transcriptPath} is not a JSON document: ${describe(error)}`,
        bytes,
      },
      cause: error,
    };
  }
  const validated = ChatSessionSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      outcome: {
        kind: "incompatible",
        reason: `${at.transcriptPath} parses as JSON but does not have the shape of a room transcript (${clipReason(validated.error.message)}). The file is untouched — open this room with the build that wrote it, or move that file aside yourself to start a fresh room here`,
      },
      cause: validated.error,
    };
  }
  if (validated.data.id !== at.sessionId) {
    const error = new Error(
      `session id mismatch: transcript at ${at.transcriptPath} claims "${validated.data.id}", expected "${at.sessionId}"`,
    );
    return { outcome: { kind: "incompatible", reason: error.message }, cause: error };
  }
  return {
    outcome: {
      kind: "loaded",
      session: { ...validated.data, repoRoot: at.repoRoot, runDir: at.runDir },
    },
    cause: undefined,
  };
}

/**
 * Answers "when was this room last touched" from a bounded prefix instead of a whole parse, which is
 * what lets a listing order every room but load only the page it returns.
 *
 * The prefix is NOT trusted on a pattern match. The candidate line is cut out, the header before it is
 * closed into a complete JSON object, and that object goes through `JSON.parse` and an id check — so a
 * stamp is used only when the bytes really are this room's top-level header. A regex alone read
 * indentation as nesting: a schema-valid transcript carrying a nested `updatedAt` at two-space depth
 * handed the listing a 1900 timestamp and dropped the newest room off the page (codex cross-check,
 * NESTED_STAMP_INPUT). Anything that does not reconstruct falls back to the whole-file read, which is
 * slower and always right.
 */
export async function readTranscriptStamp(
  sessionId: `chat-${string}`,
  repoRoot: string,
  sharingBudgetMs?: number,
): Promise<SessionStampOutcome> {
  const transcriptPath = transcriptPathFor(repoRoot, sessionId);
  let prefix: string | undefined;
  try {
    prefix = await retryOnSharingViolation(() => readPrefix(transcriptPath), sharingBudgetMs);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: describe(error), code: errorCode(error) };
  }
  const stamped = prefix === undefined ? undefined : stampFromHeader(prefix, sessionId);
  if (stamped !== undefined) return { kind: "stamped", updatedAt: stamped, session: undefined };
  const full = await readTranscript(sessionId, repoRoot, sharingBudgetMs);
  if (full.outcome.kind !== "loaded") return full.outcome;
  return {
    kind: "stamped",
    updatedAt: full.outcome.session.updatedAt,
    session: full.outcome.session,
  };
}

/** Reads the first bytes and decodes them in STREAMING mode, so a cut multi-byte character is not an error. */
async function readPrefix(transcriptPath: string): Promise<string | undefined> {
  const handle = await open(transcriptPath, "r");
  try {
    const buffer = Buffer.alloc(STAMP_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, STAMP_PREFIX_BYTES, 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead), {
      stream: true,
    });
  } catch {
    // A genuinely invalid byte inside the prefix is damage, and the whole-file read below names it.
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const TOP_LEVEL_UPDATED_AT = /^ {2}"updatedAt": ("(?:[^"\\]|\\.)*")[ \t]*,?[ \t]*$/mu;

function stampFromHeader(prefix: string, sessionId: string): string | undefined {
  const match = TOP_LEVEL_UPDATED_AT.exec(prefix);
  const quoted = match?.[1];
  if (match === null || quoted === undefined) return undefined;
  // Everything before the candidate line, plus that line, closed into a whole object. If the candidate
  // was nested, the braces do not balance and this parse fails — which is the point.
  const header = `${prefix.slice(0, match.index)}  "updatedAt": ${quoted}\n}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.id !== sessionId) return undefined;
  const updatedAt = parsed.updatedAt;
  return typeof updatedAt === "string" && updatedAt.length > 0 ? updatedAt : undefined;
}
