/**
 * @file src/chat/pty-session.test.ts
 * @purpose RED-first falsifiers for PtySession (W1-T4a; brief-gate G2/G3 + red-team #2/#4/#5):
 *          F1 strict FIFO with no cross-attribution under rapid double-submit (live bug A's
 *          trigger) · F3 completion comes from the READER's marker only — a stream that never
 *          goes quiet still completes, a marker-less turn stalls (flag) and caps with a TYPED
 *          failure, never quiescence-success (live bug B) · F4 in-flight abort kills the child +
 *          rejects typed; the session respawns on the next submit · F4b a QUEUED turn whose
 *          signal aborts is removed and never reaches the child (gate G2's concrete scenario) ·
 *          F5 child exit mid-turn rejects typed, next submit respawns · F7 the codex rate-limit
 *          auto-dismiss fires on the dialog FRAME signature, NOT on output that merely quotes
 *          the phrase (red-team #5). All seams injected: fake pty + scripted reader, fast clocks.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./pty-session
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DIALOG_DISMISS_DEBOUNCE_MS,
  type PtyLike,
  PtySession,
  type SessionTuning,
  type TurnReader,
} from "./pty-session.js";

/* ------------------------------ fakes ------------------------------ */

class FakePty implements PtyLike {
  public written: string[] = [];
  public killed = false;
  public readonly pid = 4242;
  /** E5: real node-pty's onData is an IEvent (node_modules/node-pty/typings/node-pty.d.ts:149,208-209)
   *  — MULTIPLE registered listeners all fire independently. An array (not a single slot) is load-
   *  bearing here: a single-slot fake would silently make a stacking-listener bug untestable. */
  private readonly dataCbs: Array<(d: string) => void> = [];
  private exitCb: (() => void) | undefined;
  /** E5 test hook: how many TIMES onData was called (i.e. how many listeners were registered). */
  public onDataCallCount = 0;

  public write(data: string): void {
    this.written.push(data);
  }
  public kill(): void {
    this.killed = true;
    this.exitCb?.();
  }
  public onData(cb: (d: string) => void): void {
    this.onDataCallCount += 1;
    this.dataCbs.push(cb);
  }
  public onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  /** test hooks */
  public emit(d: string): void {
    for (const cb of this.dataCbs) cb(d);
  }
  public crash(): void {
    this.exitCb?.();
  }
  public prompts(): string[] {
    // bracketed-paste payloads only (submit protocol writes \x1b[200~…\x1b[201~ then \r)
    return this.written
      .filter((w) => w.startsWith("\x1b[200~"))
      .map((w) => w.replace(/\x1b\[20[01]~/g, ""));
  }
}

/** A scripted reader: the test enqueues per-poll results; default = incomplete/empty. */
class ScriptedReader implements TurnReader {
  private script: Array<{ reply: string; complete: boolean }> = [];
  public beginCalls = 0;
  /** Drives ready() — default ready (existing tests skip the gate); F8 toggles it. */
  public isReady = true;

  public push(reply: string, complete: boolean): void {
    this.script.push({ reply, complete });
  }
  public beginTurn(): void {
    this.beginCalls += 1;
  }
  public poll(): { reply: string; complete: boolean } {
    return this.script.shift() ?? { reply: "", complete: false };
  }
  public ready(): boolean {
    return this.isReady;
  }
}

const TUNING: SessionTuning = {
  bootMs: 5,
  readyCapMs: 1_000,
  settleMs: 1,
  pollMs: 5,
  stallMs: 40,
  idleCapMs: 300,
  killGraceMs: 5,
  maxPending: 3,
  dismissDelayMs: 5,
};

let pty: FakePty;
let reader: ScriptedReader;
let spawnCount: number;

function makeSession(tuning: SessionTuning = TUNING): PtySession {
  spawnCount = 0;
  reader = new ScriptedReader();
  return new PtySession("codex", {
    spawnPty: () => {
      spawnCount += 1;
      pty = new FakePty();
      return pty;
    },
    reader: () => reader,
    tuning,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// Fake timers leaking out of one test would silently stall every later one, so the reset is a hook and
// not a line at the end of the test that installs them (F7).
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------ F1 FIFO ------------------------------ */

it("F1: two rapid submits run strictly in order with no cross-attribution", async () => {
  const s = makeSession();
  reader.push("answer-one", true);
  const p1 = s.submit("prompt-one", new AbortController().signal);
  const p2 = s.submit("prompt-two", new AbortController().signal);
  const r1 = await p1;
  reader.push("answer-two", true);
  const r2 = await p2;

  expect(r1.reply).toBe("answer-one");
  expect(r2.reply).toBe("answer-two"); // FALSIFYING: shared-state readers serve answer-one twice
  expect(pty.prompts()).toEqual(["prompt-one", "prompt-two"]); // never interleaved mid-turn
  await s.dispose();
});

/* ------------------------- F3 marker-only completion ------------------------- */

it("F3a: a never-quiet stream still completes the moment the MARKER lands", async () => {
  const s = makeSession();
  const noisy = setInterval(() => pty?.emit("spinner-frame"), 2); // spinner repaint (live bug B)
  reader.push("clean reply", true);
  const r = await s.submit("go", new AbortController().signal);
  clearInterval(noisy);
  expect(r.reply).toBe("clean reply");
  await s.dispose();
});

it("F3b: marker never arrives → stalled flag is reported, then the cap yields a TYPED failure (never empty success)", async () => {
  const s = makeSession();
  const seen: string[] = [];
  s.onMeta((m) => seen.push(m.kind));
  await expect(s.submit("go", new AbortController().signal)).rejects.toMatchObject({
    name: "PtyTurnCapError",
  });
  expect(seen).toContain("stalled"); // surfaced before the cap (G3 badge feed)
  await s.dispose();
});

/* ------------------------------ F4 abort matrix ------------------------------ */

it("F4: aborting the IN-FLIGHT turn kills the child and rejects typed; next submit respawns", async () => {
  const s = makeSession();
  const ac = new AbortController();
  const p = s.submit("long-running", ac.signal);
  await new Promise((r) => setTimeout(r, 20)); // let it spawn + submit
  ac.abort();
  await expect(p).rejects.toMatchObject({ name: "PtyAbortError" });
  expect(pty.killed).toBe(true);

  reader.push("fresh answer", true);
  const r = await s.submit("after-respawn", new AbortController().signal);
  expect(r.reply).toBe("fresh answer");
  expect(spawnCount).toBe(2); // FALSIFYING: a session that never respawns hangs here
  await s.dispose();
});

it("F4b: a QUEUED (not in-flight) turn whose signal aborts is removed and NEVER reaches the child", async () => {
  const s = makeSession();
  const acB = new AbortController();
  const pA = s.submit("turn-A", new AbortController().signal);
  const pB = s.submit("turn-B", acB.signal); // queued behind A
  const pBrejects = expect(pB).rejects.toMatchObject({ name: "PtyAbortError" }); // handler BEFORE abort
  acB.abort(); // gate G2's scenario: abort B while A is running
  reader.push("a-done", true);
  await pA;
  await pBrejects;
  await new Promise((r) => setTimeout(r, 30));
  expect(pty.prompts()).toEqual(["turn-A"]); // FALSIFYING: B running after abort = the gate's bug
  await s.dispose();
});

it("F4c: an ALREADY-aborted signal rejects immediately without enqueueing", async () => {
  const s = makeSession();
  const ac = new AbortController();
  ac.abort();
  await expect(s.submit("never", ac.signal)).rejects.toMatchObject({ name: "PtyAbortError" });
  expect(spawnCount).toBe(0); // never even spawned
  await s.dispose();
});

it("F4d: queue overflow past maxPending rejects typed (bounded, visible)", async () => {
  const s = makeSession();
  const live = new AbortController().signal;
  const swallow = (): void => undefined;
  // Fill one active slot + maxPending(3) queued = 4 accepted; these reject on dispose (intended).
  s.submit("in-flight", live).catch(swallow);
  s.submit("q1", live).catch(swallow);
  s.submit("q2", live).catch(swallow);
  s.submit("q3", live).catch(swallow);
  await expect(s.submit("q4-overflow", live)).rejects.toMatchObject({
    name: "PtyQueueFullError",
  });
  await s.dispose();
});

it("F4e: the cap counts the ACTIVE turn even after it is shifted out of the queue (codex re-review P1 #2)", async () => {
  const s = makeSession();
  const live = new AbortController().signal;
  const swallow = (): void => undefined;
  // Let the first submit START (drain shifts it out of the queue into the running slot).
  s.submit("active", live).catch(swallow);
  await new Promise((r) => setTimeout(r, 20));
  // Now queue.length === 0 but one turn is in-flight. maxPending(3) more may queue…
  s.submit("q1", live).catch(swallow);
  s.submit("q2", live).catch(swallow);
  s.submit("q3", live).catch(swallow);
  // …and the 4th queued must STILL reject — counting active+queued, not queue.length.
  // FALSIFYING: a queue.length-based cap accepts this (active was shifted, length was only 3).
  await expect(s.submit("q4-overflow", live)).rejects.toMatchObject({ name: "PtyQueueFullError" });
  await s.dispose();
});

/* ------------------------------ F5 crash recovery ------------------------------ */

it("F5: child exit mid-turn rejects typed; the next submit respawns cleanly", async () => {
  const s = makeSession();
  const p = s.submit("doomed", new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  pty.crash();
  await expect(p).rejects.toMatchObject({ name: "PtyChildExitError" });

  reader.push("recovered", true);
  const r = await s.submit("retry", new AbortController().signal);
  expect(r.reply).toBe("recovered");
  expect(spawnCount).toBe(2);
  await s.dispose();
});

it("F5b: a child that dies WHILE IDLE is not reused — next submit respawns (codex P0 #3)", async () => {
  const s = makeSession();
  reader.push("turn one", true);
  const r1 = await s.submit("first", new AbortController().signal);
  expect(r1.reply).toBe("turn one");
  expect(spawnCount).toBe(1);

  // The CLI exits between turns (rate-limit logout / idle crash) — no turn is in flight.
  pty.crash();

  reader.push("turn two", true);
  const r2 = await s.submit("second", new AbortController().signal);
  expect(r2.reply).toBe("turn two");
  // FALSIFYING: per-turn-only exit tracking reuses the dead child here (spawnCount stays 1 → hang).
  expect(spawnCount).toBe(2);
  await s.dispose();
});

/* ------------------------ F7 dialog FRAME signature ------------------------ */

// The writes one submit() makes before any dialog exists: the bracketed-paste payload, then "\r" after
// settleMs (pty-session.ts:198-200). Sampling `written.length` between the two and then attributing the
// second to a later emit is exactly how this test used to fail.
const PROMPT_WRITES = 2;
/**
 * F7 runs on a CONTROLLED clock, and that is a correctness decision rather than a speed one: its subject
 * is ORDERING (a dismiss follows the dialog frame and nothing else), and every wall-clock version of it
 * was a race it could only win by luck. Measured in-process on this box 2026-09-12, 30 sequential
 * samples of this exact session shape:
 *
 *   submit -> both prompt writes done   min 7 ms   median 31 ms   max 36 ms   (the old sample was at 20)
 *   dialog frame -> dismiss "\r" written   min 21 ms   median 31 ms   max 112 ms   (the old wait was 40)
 *
 * Both fixed waits sat INSIDE the range of the quantity they had to exceed, so neither was a bound: the
 * 20 ms sample read a half-written prompt and blamed the turn's own "\r" on the prose quote below —
 * "expected 2 to be 1", twice in the L1 lane's targeted runs (`l1-fix-r2.md`) — and the 40 ms wait sat
 * below the slowest dismiss actually observed. Widening them would only have moved the luck.
 *
 * The negative half is what a clock buys that a wider window cannot. A spurious dismiss travels the same
 * setTimeout(dismissDelayMs) path as a real one, so no wall-clock window proves one did not happen; it
 * only fails to have seen it yet. Here the clock is advanced past DIALOG_DISMISS_DEBOUNCE_MS, which
 * proves two things at once: nothing was scheduled by the quote, and the debounce has expired, so the
 * frame's own dismiss below cannot be a spurious one being suppressed (the shape that makes a wrong match
 * look like a right one). Virtual time costs nothing, so the widest honest window is free.
 */
const F7_QUOTE_WINDOW_MS = DIALOG_DISMISS_DEBOUNCE_MS + TUNING.dismissDelayMs;
const F7_VIRTUAL_SPAN_MS =
  TUNING.bootMs + TUNING.settleMs + F7_QUOTE_WINDOW_MS + TUNING.dismissDelayMs + TUNING.pollMs;
// The idle cap is an unrelated production bound that would otherwise decide this test: vitest's fake
// timers move Date too, so advancing past the debounce makes the turn look silent for longer than
// TUNING.idleCapMs and it gets killed as hung mid-assertion. F3b still pins the real 300 ms cap; F7 is
// not about the cap, so it gets one derived from its own advancement instead of inheriting it.
const F7_TUNING: SessionTuning = { ...TUNING, idleCapMs: 2 * F7_VIRTUAL_SPAN_MS };

it("F7: output that merely QUOTES 'press enter to confirm' does NOT trigger auto-dismiss; the dialog FRAME does", async () => {
  vi.useFakeTimers();
  const s = makeSession(F7_TUNING);
  const p = s.submit("turn", new AbortController().signal);

  // Deterministic, not hopeful: this is exactly the timer chain runTurn awaits before its second write.
  await vi.advanceTimersByTimeAsync(TUNING.bootMs + TUNING.settleMs);
  expect(pty.written.length).toBe(PROMPT_WRITES);
  const before = pty.written.length;

  pty.emit('The doc says "Press enter to confirm" is shown on rate limits.'); // prose quote
  await vi.advanceTimersByTimeAsync(F7_QUOTE_WINDOW_MS);
  expect(pty.written.length).toBe(before); // FALSIFYING: substring matcher injects a spurious \r

  pty.emit(
    "› 1. Switch to gpt-5.4-mini\n  2. Keep current model\n  Press enter to confirm or esc to go back",
  );
  await vi.advanceTimersByTimeAsync(TUNING.dismissDelayMs);
  expect(pty.written.slice(before)).toContain("\r");

  reader.push("done", true);
  await vi.advanceTimersByTimeAsync(TUNING.pollMs);
  await p;
  vi.useRealTimers(); // dispose() awaits killGraceMs on the real clock
  await s.dispose();
});

/* --------------------- E5 dialog-dismiss listener leak --------------------- */

// E5 (FIX WAVE Round A, 2026-07-18 = llm#2): wireDialogDismiss was called every runTurn(), and
// PtyLike.onData has no unsubscribe — each call stacked ANOTHER listener on the reused child, each
// with its own stale `dismissedAt` closure. Real node-pty fires every registered listener per data
// chunk (confirmed at node_modules/node-pty/typings/node-pty.d.ts), so N turns meant N independent
// debounce windows — one dialog frame could schedule N duplicate Enter presses into the live CLI.
it("E5: the dialog-dismiss listener is installed ONCE per spawned child, not once per turn", async () => {
  const s = makeSession();

  const p1 = s.submit("one", new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  reader.push("first", true);
  await p1;

  const p2 = s.submit("two", new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  reader.push("second", true);
  await p2;

  // FALSIFYING: the old per-turn wire-up would make this 2 (or more, across more turns) — the SAME
  // child was reused for both turns (no respawn), so onData must have been called exactly once.
  expect(pty.onDataCallCount).toBe(1);

  await s.dispose();
});

/* --------------------- F5c stale childExited (BUG-1) --------------------- */

it("F5c: a replaced child's LATE exit must not poison the live turn (BUG-1 stale childExited)", async () => {
  const spawned: FakePty[] = [];
  reader = new ScriptedReader();
  const s = new PtySession("codex", {
    spawnPty: () => {
      const p = new FakePty();
      spawned.push(p);
      return p;
    },
    reader: () => reader,
    tuning: TUNING,
  });
  // Turn 1 never completes → idle-cap kills child1 (spawned[0]).
  await expect(s.submit("one", new AbortController().signal)).rejects.toMatchObject({
    name: "PtyTurnCapError",
  });
  expect(spawned).toHaveLength(1);
  const child1 = spawned[0];
  if (child1 === undefined) throw new Error("child1 expected");

  // Turn 2: a fresh child answers — even though child1's onExit fires LATE during it (async in prod).
  reader.push("answer-two", true);
  const p2 = s.submit("two", new AbortController().signal);
  while (spawned.length < 2) await new Promise((r) => setTimeout(r, 1)); // child2 up; childExited reset
  child1.crash(); // child1's late async exit — must NOT poison child2's live turn
  // FALSIFYING: unguarded `this.childExited = true` poisons the flag → p2 rejects PtyChildExitError.
  await expect(p2).resolves.toEqual({ reply: "answer-two" });
  await s.dispose();
});

/* ------------------------ Fwarm: warm-up pre-spawn (QoL) ------------------------ */

it("Fwarm-a: warmUp() pre-spawns the child and the first submit REUSES it (no cold-start respawn)", async () => {
  const s = makeSession();
  await s.warmUp();
  expect(spawnCount).toBe(1); // child is up BEFORE any turn — the cold start was paid at warm-up
  reader.push("answer", true);
  const r = await s.submit("first", new AbortController().signal);
  expect(r.reply).toBe("answer");
  // FALSIFYING: a warm-up that fails to persist the child (or a submit that ignores it) spawns a 2nd child.
  expect(spawnCount).toBe(1);
  await s.dispose();
});

it("Fwarm-b: warmUp() is idempotent — a second call does not spawn a second child", async () => {
  const s = makeSession();
  await s.warmUp();
  await s.warmUp();
  expect(spawnCount).toBe(1);
  await s.dispose();
});

it("Fwarm-c: warmUp() after dispose() is a no-op — it never resurrects a torn-down session", async () => {
  const s = makeSession();
  await s.dispose();
  await s.warmUp();
  expect(spawnCount).toBe(0); // FALSIFYING: an unguarded warmUp spawns a child on a disposed session
  await s.dispose();
});

it("Fwarm-d: a submit racing in right after warmUp still WAITS the remaining boot before writing the prompt (boot is paid once from spawn, never skipped by the 2nd caller — codex has no readiness probe)", async () => {
  spawnCount = 0;
  reader = new ScriptedReader(); // ready() defaults true → the BOOT wait is the only thing gating the prompt
  const BOOT = 60;
  const s = new PtySession("codex", {
    spawnPty: () => {
      spawnCount += 1;
      pty = new FakePty();
      return pty;
    },
    reader: () => reader,
    tuning: { ...TUNING, bootMs: BOOT },
  });
  reader.push("ok", true);
  void s.warmUp(); // fire-and-forget: spawns now, boot deadline = now + BOOT
  const p = s.submit("q", new AbortController().signal); // races in immediately, before boot completes
  await new Promise((r) => setTimeout(r, 20)); // 20ms < BOOT(60)
  // FALSIFYING: the old `if (this.child) return` early-exit skipped the boot wait → prompt written at ~0ms,
  // dropped onto a not-yet-listening codex REPL → idle-cap hang.
  expect(pty.prompts()).toEqual([]);
  await expect(p).resolves.toEqual({ reply: "ok" }); // after the remaining boot, the turn completes
  expect(pty.prompts()).toEqual(["q"]);
  expect(spawnCount).toBe(1); // one child, shared by warm-up + the turn
  await s.dispose();
});

/* ----------------- F8 readiness gate before prompt (BUG-2) ----------------- */

it("F8: the prompt is withheld until the reader reports REPL readiness (BUG-2 boot-race)", async () => {
  const s = makeSession();
  reader.isReady = false; // REPL still booting in the fresh cwd — not yet listening
  reader.push("hi", true);
  const p = s.submit("prompt", new AbortController().signal);
  await new Promise((r) => setTimeout(r, 40)); // > bootMs+settle, < readyCapMs
  // FALSIFYING: without the readiness gate the prompt is written immediately (~bootMs) and is dropped.
  expect(pty.prompts()).toEqual([]);
  reader.isReady = true; // REPL ready → gate releases the prompt
  await expect(p).resolves.toEqual({ reply: "hi" });
  expect(pty.prompts()).toEqual(["prompt"]);
  await s.dispose();
});

it("F8b: a child that dies DURING the readiness wait fails fast without writing the prompt (codex P1)", async () => {
  const s = makeSession();
  reader.isReady = false; // REPL never reaches ready
  const p = s.submit("prompt", new AbortController().signal);
  await new Promise((r) => setTimeout(r, 10)); // turn is parked in the readiness wait
  pty.crash(); // the current child dies before readiness
  await expect(p).rejects.toMatchObject({ name: "PtyChildExitError" });
  // FALSIFYING: without the childExited check, awaitReady waits readyCapMs then writes to the dead child.
  expect(pty.prompts()).toEqual([]);
  await s.dispose();
});
