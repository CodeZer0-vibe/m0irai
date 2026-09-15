/**
 * @file src/chat/lane-hold-mode.ts
 * @purpose Decide and apply the native mode ONE freshly opened or resumed ACP lane session ends up in.
 * @exports applyRestoredMode, adoptOrApplyResumedMode
 * @depends ../adapters/acp/acp-lane-session, ../adapters/acp/acp-servers, ./lane-carrier,
 *   ./native-mode-store
 *
 * Lifted out of lane-hold.ts unchanged (FL-146), because that file sat exactly on the 600-line hard
 * ceiling and a ratchet is answered by extraction, never by a raised limit. This is a real seam, not a
 * line-count dodge: nothing here touches the hold, the supersession epoch, or the close ladder — it is
 * "given a live connection and a session id, what mode is this session actually in, and did the
 * operator's own choice survive?" The two functions differ on exactly one question — whose value wins
 * when the session's current mode and the operator's persisted choice disagree — and each carries its
 * own header explaining why, on the operator's own trace evidence.
 */
import type { LaneConnection } from "../adapters/acp/acp-lane-session.js";
import type { AcpAgent } from "../adapters/acp/acp-servers.js";
import type { LaneModeApplyOutcome } from "./lane-carrier.js";
import { bootNativeModeState } from "./native-mode-store.js";

/**
 * B1/B2 (MAX review fix round 1): applies the persisted native mode to a FRESHLY CREATED connection
 * before start()'s own promise resolves to ITS caller — "ACTIVE only after that application path."
 * (Precision correction, confirming-pass NIT: the internal `held` variable is assigned a moment
 * earlier inside createFreshSession, before this runs — but nothing outside this module can read
 * `held` or call send/setMode on it until start() itself returns, so the caller-visible guarantee
 * holds regardless of that internal ordering; lane-carrier.ts's openActiveSession always `await`s
 * start() before touching its result.) Reads the SAME on-disk file Shift+Tab writes
 * (native-mode-store.ts): a cycle pressed before any session existed (setLaneMode's "noSession"
 * outcome) and a mode restored across a kill+relaunch are the SAME case here — "there is a persisted
 * intent; apply it to THIS session." A read/apply failure never blocks the session from opening — it
 * is returned for the caller to surface, never silently dropped.
 * W4-R FIX-1 B3-widened: CREATE-path ONLY now — a brand-new session's bridge-assigned default mode is
 * not the operator's own established state the way a RESUMED session's real current mode is, so
 * pushing the persisted preference immediately remains correct here. resumeHeld below now calls the
 * SEPARATE adoptOrApplyResumedMode instead of this function — see its own header for why resume needs
 * different semantics (adopt ground truth, never silently override it).
 */
export async function applyRestoredMode(
  conn: LaneConnection,
  sessionId: string,
  agent: AcpAgent,
  repoRoot: string,
): Promise<LaneModeApplyOutcome> {
  const { state } = bootNativeModeState(repoRoot);
  const modeId = state[agent].modeId;
  try {
    await conn.setMode(sessionId, modeId);
    return { outcome: "applied", modeId, origin: "confirmed" };
  } catch (cause) {
    return { outcome: "failed", modeId, reason: errorMessage(cause) };
  }
}

/**
 * W4-R2f RA-2 — THE OPERATOR'S CHOICE OUTRANKS THE SESSION'S MEMORY, and this REVERSES W4-R FIX-1
 * B3-widened's precedence deliberately, on the operator's own evidence.
 *
 * THEIR TRACE, 2026-07-31 (TeamWork/.zer0/debug/chat-1785511159817-.../trace.ndjson:6):
 *     {"kind":"mode.session","agent":"claude","turn":0,"outcome":"applied","modeId":"default",
 *      "availableModeIds":["auto","default","acceptEdits","plan","dontAsk","bypassPermissions"]}
 * A resume applied `default` to a lane whose live catalog advertises `auto` — the mode they had
 * picked. Worse, the old code then PERSISTED the vendor's value over theirs (the removed write
 * below), so the next boot re-offered `default` as if they had chosen it. Their setting did not
 * survive a restart, twice over.
 *
 * B3-widened's concern was real and is answered rather than dismissed. It closed a case where the
 * PANEL claimed a mode the session was not in — a display lie. The answer is not to let the session
 * win; it is to stop lying by MAKING IT TRUE: when the operator's persisted choice differs from the
 * session's current mode, this pushes it with a genuine live setMode call and reports
 * origin:"confirmed" only if the bridge accepts. Nothing is ever displayed that the session has not
 * agreed to. B3-widened's own "never display what you did not push" invariant is kept exactly; only
 * the question of WHOSE value gets pushed has changed hands, to the person who chose one.
 *
 * The session's currentModeId is adopted in exactly two cases, both honest: there is no operator
 * choice to honour (no persisted file — a fresh project), or the bridge REFUSED theirs (the refusal
 * rides back on `rejected`, never swallowed). Absent currentModeId (an older/non-advertising bridge)
 * falls back to applyRestoredMode's own push — there is nothing to adopt instead.
 *
 * NOTHING IS WRITTEN TO DISK HERE ANY MORE. `.zer0/native-mode.json` is the OPERATOR's file, written
 * only by their own Shift+Tab (use-native-mode-handlers.ts). A vendor value appearing in it behind
 * their back is what destroyed the evidence of their real choice in the trace above; and a single
 * session's refusal is not them changing their mind, so a rejected mode stays on disk and gets its
 * next chance at the next boot.
 */
export async function adoptOrApplyResumedMode(
  conn: LaneConnection,
  sessionId: string,
  agent: AcpAgent,
  repoRoot: string,
  currentModeId: string | undefined,
): Promise<LaneModeApplyOutcome> {
  if (currentModeId === undefined) {
    return applyRestoredMode(conn, sessionId, agent, repoRoot);
  }
  const { state, persisted } = bootNativeModeState(repoRoot);
  const chosen = state[agent].modeId;
  if (!persisted || chosen === currentModeId) {
    // Nothing of the operator's to honour, or the session is already on it: the session's own value
    // IS the truth, adopted with no live call (it is already its real state).
    return { outcome: "applied", modeId: currentModeId, origin: "adopted" };
  }
  try {
    await conn.setMode(sessionId, chosen);
    return { outcome: "applied", modeId: chosen, origin: "confirmed" };
  } catch (cause) {
    // Refused. The lane really is on currentModeId, so THAT is what gets displayed — with the reason
    // their choice did not take, carried out rather than swallowed.
    return {
      outcome: "applied",
      modeId: currentModeId,
      origin: "adopted",
      rejected: errorMessage(cause),
    };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
