/**
 * @file src/chat/pty-session-errors.ts
 * @purpose Typed terminal-failure errors for a pty turn (W1-T4a). Each names a distinct outcome the
 *   caller maps to a failed dispatch — a turn NEVER returns an empty success. Split from pty-session.ts
 *   for the line/export budget; re-exported there so import sites are unchanged.
 * @exports PtyAbortError, PtyTurnCapError, PtyChildExitError, PtyQueueFullError
 * @depends (none)
 */
export class PtyAbortError extends Error {
  public override readonly name = "PtyAbortError";
}
export class PtyTurnCapError extends Error {
  public override readonly name = "PtyTurnCapError";
}
export class PtyChildExitError extends Error {
  public override readonly name = "PtyChildExitError";
}
export class PtyQueueFullError extends Error {
  public override readonly name = "PtyQueueFullError";
}
