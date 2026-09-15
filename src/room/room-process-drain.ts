/**
 * @file src/room/room-process-drain.ts
 * @purpose One shutdown drain for every process the room host may own: the ACP lane transports
 *   (closeAllLaneTransports — returns unconfirmed descendant PIDs) AND the persistent PTY sessions
 *   (disposeAllPtySessions — the ZER0_ACP=0 path). The PTY drain used to run only in the Ink CLI's exit path;
 *   the room host never called it, so a PTY child could outlive a room shutdown. Both drains run concurrently
 *   and independently: a PTY-drain failure never hides transport orphans and vice versa. (m0irai plan v5 3.2 —
 *   the drain the CLI cut forces; the full process registry is M2.)
 * @exports ProcessDrainResult, drainProcessOwnedTransports
 * @depends ../chat/lane-transport, ../chat/pty-session-registry, ./room-host-support
 */
import { closeAllLaneTransports } from "../chat/lane-transport.js";
import { disposeAllPtySessions } from "../chat/pty-session-registry.js";
import { asError } from "./room-host-support.js";

export interface ProcessDrainResult {
  /** Descendant agent PIDs the ACP transports could not confirm exited. */
  readonly orphans: readonly number[];
  /** First failure from either drain, if any (the other drain still ran). */
  readonly failure?: Error;
}

/** Runs both drains to completion; never throws. */
export async function drainProcessOwnedTransports(): Promise<ProcessDrainResult> {
  const [transports, pty] = await Promise.all([
    closeAllLaneTransports().then(
      (orphans) => ({ orphans, failure: undefined as Error | undefined }),
      (error: unknown) => ({ orphans: [] as readonly number[], failure: asError(error) }),
    ),
    disposeAllPtySessions().then(
      () => undefined,
      (error: unknown) => asError(error),
    ),
  ]);
  const failure = transports.failure ?? pty;
  return failure === undefined
    ? { orphans: transports.orphans }
    : { orphans: transports.orphans, failure };
}
