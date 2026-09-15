/**
 * @file src/shared/abortable-delay.ts
 * @purpose A sleep a caller can cut short, for bounded polls that must stop the instant their room does.
 * @exports abortableDelay
 * @depends (none)
 *
 * Extracted from statusline-payload.ts's readClaudeStatusUsageWhenFresh, which is the prior art the
 * codex rollout poll was told to copy exactly. A bare setTimeout leaves a post-turn read sleeping
 * through a shutdown it has already been told about — the difference between a room that closes and a
 * room that closes after one more interval.
 */

/** Resolves after `ms`, or immediately when `signal` aborts. Clears its timer and detaches its listener
 *  on either path, so a poll that runs for a whole turn leaves nothing behind. */
export function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
