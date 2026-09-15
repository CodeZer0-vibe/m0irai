/**
 * @file src/chat/pty-transcripts.ts
 * @purpose claude's pty session status: read its busy/idle/waiting status + sessionId from the
 *   ~/.claude/sessions/<pid>.json file claude writes. The session-bound, offset-tracked turn readers for
 *   claude/codex live in pty-binding.ts; the legacy whole-file readers (readCodexTurn/readGeminiTurn) were
 *   removed with the gemini-cli retirement — gemini runs through the agy lane, not a PTY session.
 * @exports readPidStatus
 * @depends node:fs, node:os, node:path
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface PidStatus {
  sessionId?: string;
  status?: string;
}

/** claude writes its own busy/idle/waiting status + sessionId to ~/.claude/sessions/<pid>.json. */
export function readPidStatus(pid: number): PidStatus | null {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8"),
    ) as PidStatus;
  } catch {
    return null;
  }
}
