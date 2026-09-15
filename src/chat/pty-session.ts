/**
 * @file src/chat/pty-session.ts
 * @purpose A persistent interactive pty session for one agent, reused across turns (W1-T4a). Strict
 *   FIFO submit() chain (one turn in flight); completion = the reader's structured marker ONLY
 *   (never byte-quiescence); a marker-less turn fires a `stalled` meta then caps with a TYPED
 *   failure. Full abort matrix + crash-respawn + codex dialog-frame auto-dismiss. All OS seams are
 *   injected (spawnPty/reader/tuning) so the logic is unit-testable without a real CLI.
 * @exports PtyLike, TurnReader, SessionTuning, PtySessionDeps, TurnMeta, TurnResult, PtySession,
 *   DIALOG_DISMISS_DEBOUNCE_MS, PtyAbortError, PtyTurnCapError, PtyChildExitError, PtyQueueFullError
 * @depends ../adapters/pty/exe-resolver, ./pty-session-errors
 */
import type { PtyAgent } from "../adapters/pty/exe-resolver.js";
import {
  PtyAbortError,
  PtyChildExitError,
  PtyQueueFullError,
  PtyTurnCapError,
} from "./pty-session-errors.js";

/** The minimal pty surface the session drives (node-pty in prod, a fake in tests). */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: () => void): void;
}

/** Per-turn structured-log reader: beginTurn() pins the offset; poll() returns the delta. */
export interface TurnReader {
  beginTurn(): void;
  poll(): { reply: string; complete: boolean };
  /** Optional REPL-readiness probe for the prompt-write gate (BUG-2 boot-race). Absent ⇒ always ready. */
  ready?(): boolean;
}

/** All timing knobs (ms) + the queue bound — injected so tests run on fast clocks. */
export interface SessionTuning {
  readonly bootMs: number;
  /** Max wait (ms) for the REPL to report ready before the prompt is written (BUG-2 boot-race); falls
   *  through + writes after this cap, so it is never a deadlock. */
  readonly readyCapMs: number;
  readonly settleMs: number;
  readonly pollMs: number;
  readonly stallMs: number;
  /** Idle watchdog (ms): abort a turn ONLY after this long with NO new output (a genuinely hung
   *  child). There is no total-duration cap — an actively-producing turn runs unbounded, because a
   *  real agent task can legitimately run for hours. */
  readonly idleCapMs: number;
  readonly killGraceMs: number;
  readonly maxPending: number;
  /** Delay before auto-dismissing codex's rate-limit dialog (prod ~400; tests run it fast). */
  readonly dismissDelayMs: number;
}

/** Injected OS seams + tuning. */
export interface PtySessionDeps {
  spawnPty(agent: PtyAgent): PtyLike;
  /** Builds the per-turn reader; receives the live child pid (claude status-gating needs it). */
  reader(agent: PtyAgent, pid: number): TurnReader;
  tuning: SessionTuning;
}

/** A non-terminal signal the cockpit renders as a lane badge (G3). */
export interface TurnMeta {
  readonly kind: "stalled" | "degraded" | "rate-limited" | "model";
  readonly detail?: string;
}

/** The clean reply of one completed turn. */
export interface TurnResult {
  readonly reply: string;
}

export {
  PtyAbortError,
  PtyChildExitError,
  PtyQueueFullError,
  PtyTurnCapError,
} from "./pty-session-errors.js";

interface QueueItem {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve(r: TurnResult): void;
  reject(e: Error): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Frame signature for codex's rate-limit model-switch dialog (NOT a bare substring — F7). */
const DIALOG_FRAME =
  /Switch to \S+ for lower credit usage|Press enter to confirm or esc to go back/;

/**
 * A dialog frame re-arriving inside this window is the SAME dialog being repainted, not a second one, so
 * only the first gets an Enter. Named and exported rather than inline because F7's falsifier has to
 * out-wait it to prove the prose quote scheduled nothing at all: while a spurious dismiss is still inside
 * this window it SUPPRESSES the real frame's dismiss, which makes one wrong match look like one right
 * match. A test that hard-coded 3_000 would stop out-waiting it the moment this value changed.
 */
export const DIALOG_DISMISS_DEBOUNCE_MS = 3_000;

export class PtySession {
  private readonly agent: PtyAgent;
  private readonly deps: PtySessionDeps;
  private child: PtyLike | undefined;
  private childExited = false;
  /** Wall-clock (ms) by which the current child has finished booting. ensureChild waits out only the
   *  REMAINDER, so the one-time boot cost is paid once from spawn even when warmUp() pre-spawned the child —
   *  a fast first submit never skips it (codex has no readiness probe, so boot is its only prompt gate). */
  private bootDeadline = 0;
  /** Active turn + all queued turns — the cap is measured against this, not queue.length. */
  private outstanding = 0;
  private readonly queue: QueueItem[] = [];
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private metaCb: ((m: TurnMeta) => void) | undefined;

  public constructor(agent: PtyAgent, deps: PtySessionDeps) {
    this.agent = agent;
    this.deps = deps;
  }

  /** Subscribe to non-terminal turn signals (stalled/degraded/rate-limited/model). */
  public onMeta(cb: (m: TurnMeta) => void): void {
    this.metaCb = cb;
  }

  /**
   * Pre-spawn the child now and pay the one-time boot cost ahead of the first turn, so the first submit()
   * reuses the warm child instead of paying the ~bootMs cold start (QoL: a faster first answer). Spawning a
   * CLI is NOT a model turn, so this spends no quota. Idempotent (ensureChild's guard) and a no-op once
   * disposed. Best-effort: the caller fires-and-forgets and swallows rejection; a failed warm leaves the
   * child unset, so the first real submit simply spawns normally.
   */
  public async warmUp(): Promise<void> {
    if (this.disposed) return;
    await this.ensureChild();
  }

  /**
   * Enqueue a turn. An already-aborted signal rejects immediately (no enqueue); overflow past
   * one active + maxPending queued rejects typed; otherwise turns run in strict FIFO order.
   */
  public submit(prompt: string, signal: AbortSignal): Promise<TurnResult> {
    if (signal.aborted) return Promise.reject(new PtyAbortError("signal already aborted"));
    // Bound by OUTSTANDING (the active turn + everything queued), not queue.length — once the
    // active item is shifted out, queue.length undercounts by one, so a 4th queued turn would slip
    // past `> maxPending` (codex re-review P1 #2). maxPending queued behind one active = maxPending+1.
    if (this.outstanding >= this.deps.tuning.maxPending + 1) {
      return Promise.reject(
        new PtyQueueFullError(`queue full (max ${this.deps.tuning.maxPending})`),
      );
    }
    this.outstanding += 1;
    return new Promise<TurnResult>((resolve, reject) => {
      const item: QueueItem = {
        prompt,
        signal,
        resolve,
        reject,
        onAbort: () => this.onQueuedAbort(item),
      };
      signal.addEventListener("abort", item.onAbort, { once: true });
      this.queue.push(item);
      // Chain on the tail promise → strict FIFO; never floats (assigned back to this.tail).
      this.tail = this.tail.then(() => this.processNext());
    });
  }

  /** Removes a still-QUEUED item on abort so it never reaches the child (G2). */
  private onQueuedAbort(item: QueueItem): void {
    const idx = this.queue.indexOf(item);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.outstanding -= 1;
      item.reject(new PtyAbortError("aborted while queued"));
    }
  }

  /** Processes the head item (or no-ops if it was removed by abort). Never rejects the tail. */
  private async processNext(): Promise<void> {
    const item = this.queue.shift();
    if (item === undefined) return; // removed by abort — its outstanding-- happened in onQueuedAbort
    item.signal.removeEventListener("abort", item.onAbort);
    try {
      if (item.signal.aborted) {
        item.reject(new PtyAbortError("aborted while queued"));
        return;
      }
      item.resolve(await this.runTurn(item.prompt, item.signal));
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.outstanding -= 1;
    }
  }

  private async runTurn(prompt: string, signal: AbortSignal): Promise<TurnResult> {
    const child = await this.ensureChild();
    const reader = this.deps.reader(this.agent, child.pid);
    reader.beginTurn();

    await this.awaitReady(reader, signal);
    child.write(`\x1b[200~${prompt}\x1b[201~`);
    await sleep(this.deps.tuning.settleMs);
    child.write("\r");
    return this.awaitCompletion(reader, signal);
  }

  /** BUG-2 (boot-race): hold the prompt until the reader reports the REPL is listening (claude: pid
   *  status idle/waiting). A cold start slower than bootMs would otherwise drop the prompt → the 15-min
   *  idle-cap. Capped at readyCapMs — a reader with no probe (codex) or a very slow boot falls
   *  through and writes anyway: never worse than the old fixed wait, never a deadlock. */
  private async awaitReady(reader: TurnReader, signal: AbortSignal): Promise<void> {
    const probe = reader.ready?.bind(reader);
    if (probe === undefined) return;
    const deadline = Date.now() + this.deps.tuning.readyCapMs;
    while (!probe()) {
      if (signal.aborted) {
        this.killChild();
        throw new PtyAbortError("aborted before prompt");
      }
      if (this.childExited) {
        // The child died during the readiness wait (boot crash) — fail fast, never write to a dead pty.
        this.killChild();
        throw new PtyChildExitError("child exited mid-turn");
      }
      if (Date.now() >= deadline) return;
      await sleep(this.deps.tuning.pollMs);
    }
  }

  /** Polls the reader to the structured marker; throws TYPED on abort/exit/idle-cap (never empty ok).
   *  NO total-duration cap — an actively-producing turn runs unbounded (hours are valid); only a child
   *  that goes fully silent for idleCapMs is killed as hung. Child death is tracked session-level
   *  (ensureChild's onExit), so idle death is caught too. */
  private async awaitCompletion(reader: TurnReader, signal: AbortSignal): Promise<TurnResult> {
    const t = this.deps.tuning;
    let lastLen = 0;
    let lastProgress = Date.now();
    let stalledFired = false;
    for (;;) {
      if (signal.aborted) {
        this.killChild();
        throw new PtyAbortError("aborted in flight");
      }
      if (this.childExited) {
        this.killChild();
        throw new PtyChildExitError("child exited mid-turn");
      }
      const { reply, complete } = reader.poll();
      if (complete && reply) return { reply };
      const now = Date.now();
      // Progress = the cumulative reply GREW since the last poll (not merely non-empty) — that is what
      // resets the idle clock, so an actively-streaming turn never trips the watchdog.
      if (reply.length > lastLen) {
        lastLen = reply.length;
        lastProgress = now;
      }
      const idleMs = now - lastProgress;
      if (!stalledFired && idleMs >= t.stallMs) {
        stalledFired = true;
        this.metaCb?.({ kind: "stalled" });
      }
      if (idleMs >= t.idleCapMs) {
        this.killChild();
        throw new PtyTurnCapError(`no output for ${t.idleCapMs}ms — agent appears hung`);
      }
      await sleep(t.pollMs);
    }
  }

  /** codex only: auto-dismiss the rate-limit dialog on its FRAME signature (not a bare substring).
   *  E5 (FIX WAVE Round A, 2026-07-18 = llm#2): called ONCE per spawned child (ensureChild), never
   *  per turn — PtyLike.onData has no unsubscribe, so a per-turn call on a REUSED child would stack
   *  another independent listener (its own stale `dismissedAt` closure) on every turn. A dialog can
   *  appear at any point in a child's life, not only "during the currently active turn," so binding
   *  this to the child's own spawn lifecycle is the correct home for it, not a workaround. */
  private wireDialogDismiss(child: PtyLike): void {
    let dismissedAt = 0;
    child.onData((d) => {
      if (
        this.agent !== "codex" ||
        !DIALOG_FRAME.test(d) ||
        Date.now() - dismissedAt <= DIALOG_DISMISS_DEBOUNCE_MS
      ) {
        return;
      }
      dismissedAt = Date.now();
      setTimeout(() => {
        try {
          child.write("\r");
        } catch {
          /* gone */
        }
      }, this.deps.tuning.dismissDelayMs);
    });
  }

  private async ensureChild(): Promise<PtyLike> {
    let child = this.child;
    if (child === undefined) {
      child = this.deps.spawnPty(this.agent);
      this.child = child;
      this.childExited = false;
      // Boot cost is paid ONCE, measured from spawn (not per ensureChild call): warmUp() may pre-spawn the
      // child, so a fast first submit waits out only the REMAINING boot below — it must never skip it.
      this.bootDeadline = Date.now() + this.deps.tuning.bootMs;
      const spawned = child;
      // Session-level exit tracking: a child that dies WHILE IDLE clears itself, so the next submit
      // respawns instead of reusing a dead pty (the per-turn ref missed idle death — codex P0 #3).
      spawned.onExit(() => {
        // A stale (already-replaced or killed) child's async exit must not poison the live turn — BUG-1.
        if (this.child !== spawned) return;
        this.childExited = true;
        this.child = undefined;
      });
      // E5: wired exactly once per spawn, here — never in runTurn (see wireDialogDismiss's own doc).
      this.wireDialogDismiss(spawned);
    }
    // Wait out whatever boot time remains (full bootMs for a fresh spawn; the remainder, or zero, when the
    // child was already warmed). A child reused across turns is long past its deadline → no wait.
    const remaining = this.bootDeadline - Date.now();
    if (remaining > 0) await sleep(remaining);
    return child;
  }

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  }

  /** Kills the child and rejects every still-queued turn (idempotent). */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue.splice(0)) {
      item.signal.removeEventListener("abort", item.onAbort);
      this.outstanding -= 1;
      item.reject(new PtyAbortError("session disposed"));
    }
    this.killChild();
    await sleep(this.deps.tuning.killGraceMs);
  }
}
