/**
 * @file src/adapters/acp/acp-turn.ts
 * @purpose Run ONE agent turn over ACP and return it adapter-shaped (AgentResultWithUsage). Opens a turn session,
 *   prompts (streaming chunks to onChunk), maps stopReason → exitCode (end_turn = 0), carries the turn's context
 *   usage (used/size) out on the result, and ALWAYS closes the session. The turn is CANCELLABLE: the caller's
 *   AbortSignal (operator stop) rejects it immediately, and an idle cap rejects a hung handshake/prompt (no
 *   streamed activity for idleMs) — both close the child. The session opener is injectable for tests. The reply
 *   is RAW agent text — the cockpit escapes it (INV-13).
 * @exports AcpTurnInput, dispatchAcpTurn
 * @depends ../../shared/turn-usage, ./acp-servers, ./acp-turn-session
 */
import type { AgentResultWithUsage } from "../../shared/turn-usage.js";
import type { PermissionDecider } from "./acp-permission.js";
import type { AcpAgent } from "./acp-servers.js";
import { type TurnSession, openTurnSession } from "./acp-turn-session.js";

const END_TURN = "end_turn";
const SUCCESS = 0;
const FAILURE = 1;
// No streamed activity for this long → the turn is presumed hung and rejected (matches the pty idle cap). The
// operator's AbortSignal handles intentional cancellation immediately; this is only the unattended-hang net.
const DEFAULT_IDLE_MS = 900_000;

/** One ACP turn request: agent, working dir (lane worktree), prompt, + optional sink / abort signal / idle cap. */
export interface AcpTurnInput {
  readonly agent: AcpAgent;
  readonly cwd: string;
  readonly promptText: string;
  readonly onChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
  readonly idleMs?: number;
  readonly decide?: PermissionDecider;
  readonly requiredModeId?: string;
}

/**
 * Races `start` against the abort signal + an IDLE cap. `start` receives `onActivity` (call after the handshake
 * and per streamed chunk) which re-arms the idle timer; if it is not called for idleMs the turn is presumed hung.
 * `onCancel` fires on abort/timeout so the caller closes the session — even one that materializes after the race.
 */
function runWithIdleAbort<T>(
  start: (onActivity: () => void) => Promise<T>,
  signal: AbortSignal | undefined,
  idleMs: number,
  onCancel: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    // Function declarations (hoisted) so cleanup can reference onAbort without a TDZ. fail() clears the timer +
    // listener ITSELF: on abort/timeout the hung `start` never settles, so its `.finally` would never run.
    function onAbort(): void {
      fail(new Error("aborted: ACP turn cancelled"));
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function fail(error: Error): void {
      cleanup();
      onCancel();
      reject(error);
    }
    function arm(): void {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error(`timed out: no ACP activity for ${idleMs}ms`)),
        idleMs,
      );
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    arm();
    start(arm)
      .then(resolve, reject)
      .finally(() => {
        cleanup();
      });
  });
}

/**
 * FL-150 ROUND 2 (review P1-B) — A CANCELLED TURN STOPS HERE INSTEAD OF PROMPTING THE SESSION IT JUST CLOSED.
 *
 * The line this replaces was `if (cancelled) session.close();` with NO `return`. An abort landing during the
 * documented ~2-3s handshake (`acp-turn-session.ts:29-31`) rejected the OUTER promise via `runWithIdleAbort`,
 * closed the late session — and then fell straight through to `session.prompt()` on it anyway. Reviewer's probe,
 * on the shipped `dispatchAcpTurn` with its own `open` seam: `"prompts": ["the prompt the operator cancelled"]`.
 *
 * THIS IS THE OPERATOR'S DEFECT ON THE OTHER PATH. It is not the carrier: `room-host.ts` grants only
 * operator-origin lanes and `usesCarrier` requires a grant, so EVERY agent-to-agent hop (`room-engine.ts`,
 * `origin: "agent"`) comes through here, as does every turn with either memory flag off. FL-150's carrier work
 * did nothing for it, which is why "the operator's defect is closed" was not yet a true sentence.
 *
 * Whether those bytes reached a live agent depended on whether `child.kill()` had already torn stdio down — a
 * race, UNVERIFIED without a real child. Composing and sending a prompt for a turn the operator stopped is the
 * defect either way; that it MIGHT have lost its own race is not a guard.
 *
 * Throwing (rather than returning a value) is what the surrounding machinery expects: `runWithIdleAbort` has
 * already rejected the outer promise via `fail()`, so this rejection is swallowed by the settled promise and the
 * caller keeps the original "aborted: ACP turn cancelled". The `finally` below still closes the session.
 */
function throwIfTurnCancelled(
  session: TurnSession,
  cancelled: boolean,
  signal: AbortSignal | undefined,
): void {
  if (!cancelled && signal?.aborted !== true) return;
  session.close();
  throw new Error("aborted: ACP turn cancelled - no prompt was composed or sent");
}

/**
 * Runs one ACP turn → an AgentResultWithUsage. CANCELLABLE: the abort signal / idle cap reject a hung turn and
 * close the child (the finally + onCancel cover a session that opens after the race lost). Always closes the
 * session. The turn's LATEST context usage (used/size), if the adapter reported it, rides out on `usage`.
 *
 * @param input - agent + prompt (+ optional onChunk sink, abort signal, idle cap)
 * @param open - the session opener (defaults to the real session; a fake in tests)
 * @returns stopReason end_turn → exitCode 0, the reply text → stdout, + optional turn `usage`
 */
export async function dispatchAcpTurn(
  input: AcpTurnInput,
  open: (agent: AcpAgent, cwd: string, decide?: PermissionDecider) => Promise<TurnSession> = (
    agent,
    cwd,
    decide,
  ) => openTurnSession(agent, cwd, undefined, undefined, decide),
): Promise<AgentResultWithUsage> {
  let session: TurnSession | undefined;
  let cancelled = false;
  try {
    return await runWithIdleAbort(
      async (onActivity) => {
        session = await open(input.agent, input.cwd, input.decide);
        // Lost the race during the handshake → close the late session (no leak) and STOP. See above.
        throwIfTurnCancelled(session, cancelled, input.signal);
        onActivity(); // handshake done — re-arm the idle cap for the prompt phase
        if (input.requiredModeId !== undefined) {
          await session.requireMode(input.requiredModeId);
          onActivity();
        }
        // Asked again immediately before the send: `requireMode` above is an awaited round trip to the
        // bridge, so a cancel can land inside it — the same "no await between the check and the wire"
        // rule the carrier path holds at `lane-carrier.ts`'s throwIfCancelledBeforeSend.
        throwIfTurnCancelled(session, cancelled, input.signal);
        const { reply, stopReason, usage } = await session.prompt(input.promptText, (chunk) => {
          onActivity();
          input.onChunk?.(chunk);
        });
        // Carry the turn's context usage out on the result (claude ACP); OMITTED when none was reported.
        return {
          exitCode: stopReason === END_TURN ? SUCCESS : FAILURE,
          stdout: reply,
          ...(usage !== undefined ? { usage } : {}),
        };
      },
      input.signal,
      input.idleMs ?? DEFAULT_IDLE_MS,
      () => {
        cancelled = true;
        session?.close();
      },
    );
  } finally {
    session?.close();
  }
}
