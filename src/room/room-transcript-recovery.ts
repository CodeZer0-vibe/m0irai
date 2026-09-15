/**
 * @file src/room/room-transcript-recovery.ts
 * @purpose Open a room for attach: load it, or quarantine a damaged transcript and hand back a shell the ledger can refill.
 * @exports RoomTranscriptOpenInput, openRoomTranscript, quarantinePathFor
 * @depends node:crypto, node:fs/promises, node:path, ../chat/session-store, ../chat/types, ./zer0-v2-rpc
 */
import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSession, readSessionUpdatedAt } from "../chat/session-store.js";
import type { ChatSession } from "../chat/types.js";
import { internalError } from "./zer0-v2-rpc.js";

const COUNCIL_RUNS_DIR = "runs";
const COUNCIL_DIR = ".council";
const TRANSCRIPT_FILE = "transcript.json";

export interface RoomTranscriptOpenInput {
  readonly sessionId: `chat-${string}`;
  readonly repoRoot: string;
  /** Called once when a damaged transcript is quarantined. The caller writes it where operators look. */
  readonly report: (line: string) => void;
}

/** The compiler's proof that every verdict is spelled out above; unreachable at run time. */
function assertNever(value: never): never {
  throw new Error(`unhandled transcript verdict: ${JSON.stringify(value)}`);
}

function runDirFor(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, COUNCIL_DIR, COUNCIL_RUNS_DIR, sessionId);
}

/** Where a damaged transcript's bytes are kept. Unique per attempt, so a quarantine never overwrites one. */
export function quarantinePathFor(runDir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return path.join(runDir, `transcript.damaged-${stamp}-${randomUUID().slice(0, 8)}.json`);
}

/**
 * The attach-time read. Exactly ONE failure gets the rebuild: a transcript whose bytes were obtained and
 * are not a JSON document. Its bytes are copied aside first, and only then does the room open on an empty
 * shell for the caller's ledger reconciliation to refill and re-persist.
 *
 * The quarantine is the precondition, not a courtesy. Recovery rebuilds from the evidence ledger, and a
 * room whose ledger rows are missing (memory disabled, a different database) would recover to NOTHING and
 * then overwrite the damaged file on the next save. Copying first means the worst case is a room that
 * reopens empty with its old bytes on disk and named, never a room destroyed by its own repair.
 *
 * Every OTHER failure refuses the attach and leaves the file alone, because a rebuild is only right when
 * the file is actually broken. Bytes that could not be read say nothing about their content; bytes that
 * parse but do not match this room are intact history. Presenting either as an empty conversation is
 * worse for an operator than saying the room will not open and why (review round 1, SL-1 and SL-2).
 */
export async function openRoomTranscript(input: RoomTranscriptOpenInput): Promise<ChatSession> {
  const read = await readSession(input.sessionId, input.repoRoot);
  const runDir = runDirFor(input.repoRoot, input.sessionId);
  const transcriptPath = path.join(runDir, TRANSCRIPT_FILE);
  // An exhaustive switch, because the fall-through here is the DESTRUCTIVE branch. With if/else the
  // compiler let a future fifth verdict slide into quarantine-and-rebuild in silence; now it cannot
  // reach this function at all without being spelled out.
  switch (read.kind) {
    case "loaded":
      return read.session;
    case "absent":
      throw internalError(
        `room ${input.sessionId} has no transcript at ${transcriptPath}, so there is nothing to reopen`,
      );
    case "unreadable":
      throw internalError(
        `room ${input.sessionId} could not be opened: its transcript at ${transcriptPath} could not be read (${read.reason}). The file was left untouched — close whatever is holding it and reopen the room`,
      );
    case "incompatible":
      throw internalError(
        `room ${input.sessionId} could not be opened: ${read.reason}. The file was left untouched — this is intact history that does not match this room, not a damaged transcript`,
      );
    case "damaged":
      break;
    default:
      return assertNever(read);
  }
  const quarantine = await quarantineTranscript(input, runDir, read);
  // Every clause here is already true when it is printed. The previous wording announced that the room
  // "was rebuilt from the evidence ledger" BEFORE the rebuild ran — and the rebuild happens later, in
  // the host's reconciliation, where it can restore nothing (no ledger rows) or fail outright. A notice
  // that reaches the operator ahead of its own subject can only be a guess.
  input.report(
    `zer0: room ${input.sessionId} could not be read (${read.reason}); its bytes were copied to ${quarantine} before anything else was done. The room is reopening now and any history the evidence ledger still holds will be restored into it; if the ledger holds none, the room may reopen empty and that copy is where your history is`,
  );
  return shellSession(input, runDir, await recoveredStamp(input));
}

/**
 * Copies aside THE BYTES THAT WERE JUDGED, never a fresh read of the path.
 *
 * Re-reading opened a window between the read that classified the file and the read that copied it: a
 * healthy same-room transcript that landed in between was quarantined and then overwritten with an
 * empty room (codex cross-check, HOST_healthy-race). The verdict carries its own evidence now, so the
 * copy and the judgement cannot disagree.
 */
async function quarantineTranscript(
  input: RoomTranscriptOpenInput,
  runDir: string,
  read: { readonly reason: string; readonly bytes: Uint8Array },
): Promise<string> {
  const quarantine = quarantinePathFor(runDir);
  try {
    await writeFile(quarantine, read.bytes, { flag: "wx" });
  } catch (error) {
    // Nothing was moved and nothing was replaced, so refusing loses nothing: the damaged transcript is
    // still exactly where it was, and opening the room now would put a shell in front of it.
    throw internalError(
      `room ${input.sessionId} could not be read (${read.reason}) and its bytes could not be copied to ${quarantine} (${error instanceof Error ? error.message : String(error)}), so the transcript was left untouched`,
    );
  }
  return quarantine;
}

/**
 * The damaged file usually still carries its own `updatedAt` in the prefix, so the rebuilt room keeps its
 * place in the room list instead of jumping to the top. Falls back to the file's own last-modified time,
 * then to now — in that order, because each is a weaker answer to the same question.
 */
async function recoveredStamp(input: RoomTranscriptOpenInput): Promise<string> {
  const stamp = await readSessionUpdatedAt(input.sessionId, input.repoRoot);
  if (stamp.kind === "stamped") return stamp.updatedAt;
  const modified = await stat(
    path.join(runDirFor(input.repoRoot, input.sessionId), TRANSCRIPT_FILE),
  ).catch(() => undefined);
  return (modified?.mtime ?? new Date()).toISOString();
}

function shellSession(
  input: RoomTranscriptOpenInput,
  runDir: string,
  updatedAt: string,
): ChatSession {
  return {
    id: input.sessionId,
    repoRoot: input.repoRoot,
    runDir,
    createdAt: updatedAt,
    updatedAt,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [],
  };
}
