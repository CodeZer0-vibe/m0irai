/**
 * @file src/chat/pty-binding-reader.ts
 * @purpose The production TurnReader for PtySession: bridges pty-binding (session-bound, offset +
 *   rotation/truncation-aware reads) to the TurnReader seam. beginTurn() fast-forwards past existing
 *   content; poll() re-resolves (rotation) + returns the since-turn delta — turn-2 never re-serves
 *   turn-1. claude is status-gated (busy→idle) before a reply counts; codex uses its task_complete marker.
 * @exports ReaderContext, BindingReader
 * @depends ./pty-binding, ./pty-transcripts, ./pty-session, ../adapters/pty/exe-resolver
 */
import type { PtyAgent } from "../adapters/pty/exe-resolver.js";
import { type SessionBinding, readTurnDelta, resolveBinding } from "./pty-binding.js";
import type { TurnReader } from "./pty-session.js";
import { readPidStatus } from "./pty-transcripts.js";

/** Context the registry hands each reader: which session log family to bind + the live child pid. */
export interface ReaderContext {
  readonly cwd: string;
  readonly spawnMs: number;
  readonly pid: number;
}

export class BindingReader implements TurnReader {
  private readonly agent: PtyAgent;
  private readonly ctx: ReaderContext;
  private binding: SessionBinding;
  private sawBusy = false;

  public constructor(agent: PtyAgent, ctx: ReaderContext) {
    this.agent = agent;
    this.ctx = ctx;
    this.binding = this.resolve();
  }

  private resolve(prev?: SessionBinding): SessionBinding {
    return resolveBinding(
      this.agent,
      { cwd: this.ctx.cwd, spawnMs: this.ctx.spawnMs, pid: this.ctx.pid },
      prev,
    );
  }

  /** Snapshot the turn's start: re-resolve (rotation-aware) and FAST-FORWARD the offset to the
   *  current end, so this turn reads only content the agent appends from here on. */
  public beginTurn(): void {
    const fresh = this.resolve(this.binding);
    // Consume everything already present → offset moves to EOF without returning it.
    this.binding = readTurnDelta(fresh).binding;
    this.sawBusy = false;
  }

  public poll(): { reply: string; complete: boolean } {
    this.binding = this.resolve(this.binding);
    const delta = readTurnDelta(this.binding);
    this.binding = delta.binding;
    if (this.agent !== "claude") {
      return { reply: delta.reply, complete: delta.complete };
    }
    // claude: gate completion on the pid status busy→idle transition.
    const status = readPidStatus(this.ctx.pid)?.status;
    if (status === "busy") this.sawBusy = true;
    const idle = status === "idle" || status === "waiting";
    return { reply: delta.reply, complete: this.sawBusy && idle && delta.reply.length > 0 };
  }

  /** REPL-readiness for the prompt-write gate (BUG-2): claude is ready when its pid status reports
   *  idle/waiting (session up + listening); other agents have no status signal → always ready. */
  public ready(): boolean {
    if (this.agent !== "claude") return true;
    const status = readPidStatus(this.ctx.pid)?.status;
    return status === "idle" || status === "waiting";
  }
}
