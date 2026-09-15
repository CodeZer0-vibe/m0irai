/**
 * @file src/room/attached-session-lifecycle.ts
 * @purpose ONE attach, ONE detach for the single room session a host process owns. Both `session/new` and
 *   `session/load` attach through `attach`, which freezes the identity ({sessionId, projectId, dbPath,
 *   repoRoot}) the room itself resolved. Every close trigger (`zer0/room/shutdown`, stdin EOF, a consume or
 *   transport failure, the owner dropping the process) routes through `detach`, which shuts the room down
 *   FIRST (the transcript on disk is authoritative before anything reads it) and only then schedules the
 *   detached memory digest. Concurrent triggers share ONE promise: one close, one digest, per session.
 * @exports AttachOrigin, AttachedSession, AttachableRoom, AttachedSessionLifecycleOptions, AttachedSessionLifecycle
 * @depends node:fs/promises, node:path, ../memory/digest-runner, ../memory/memory-flags, ./zer0-v2-rpc
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type BootCatchUpRequest,
  type DigestSpawn,
  bootCatchUp,
  spawnDetachedDigest,
} from "../memory/digest-runner.js";
import { memoryEnabled } from "../memory/memory-flags.js";
import { asError, diagnostic } from "./zer0-v2-rpc.js";

/** Which room RPC attached the session. Only a NEW session triggers boot catch-up (see attach). */
export type AttachOrigin = "session/new" | "session/load";

/** The frozen identity of the attached session — everything the detached digest child needs, resolved once. */
export interface AttachedSession {
  readonly sessionId: `chat-${string}`;
  readonly projectId: string;
  readonly dbPath: string;
  readonly repoRoot: string;
}

/** The part of AliveRoomHost this lifecycle owns. Narrow on purpose: the tests attach a plain double. */
export interface AttachableRoom {
  sessionId(): string;
  projectId(): string;
  shutdown(): Promise<void>;
}

/** Construction seams. The two spawn seams are injected by tests so a real child is never forked. */
export interface AttachedSessionLifecycleOptions {
  readonly repoRoot: string;
  readonly dbPath: string;
  /** The seam the CLOSE digest goes through; its returned word is what the close record reports. */
  readonly spawnDigest?: DigestSpawn;
  /**
   * The seam boot catch-up children go through. Separate from spawnDigest because the two have different
   * survival problems, not because this class knows which mode it is in: a catch-up child runs WHILE the
   * host runs and is spawned in process, while the close child outlives the host and may have to be handed
   * to a parent outside its job object (F10). Defaults to spawnDigest, so a test that injects one seam keeps
   * observing both paths through it.
   */
  readonly spawnCatchUpDigest?: DigestSpawn;
  readonly catchUp?: (request: BootCatchUpRequest, spawnFn?: DigestSpawn) => Promise<number>;
  readonly onBackgroundFailure?: (error: unknown) => void;
}

/** One durable line per close, appended under the project .zer0 journal folder (see recordClose). */
const CLOSE_LOG_DIR = "journal";
const CLOSE_LOG_FILE = "room-close.log";

export class AttachedSessionLifecycle<R extends AttachableRoom = AttachableRoom> {
  private session: AttachedSession | undefined;
  private room: R | undefined;
  private closing: Promise<void> | undefined;

  public constructor(private readonly options: AttachedSessionLifecycleOptions) {}

  /**
   * Binds the one room this process serves. Called from BOTH `session/new` and `session/load` immediately
   * after the room exists, so the close path can never see a room whose identity was never frozen.
   *
   * @param room - the freshly created room; its projectId() is the canonical identity, never re-resolved
   * @param origin - `session/new` also schedules boot catch-up for the OTHER on-disk sessions
   * @throws when a session is already attached or already closing (a programming error: the room host
   *   refuses a second session/new over the wire before this is ever reached)
   */
  public attach(room: R, origin: AttachOrigin): void {
    if (this.room !== undefined || this.closing !== undefined)
      throw new Error("attached session lifecycle already owns a room for this host process");
    const sessionId = room.sessionId();
    const projectId = room.projectId();
    if (!sessionId.startsWith("chat-"))
      throw new Error(`attached room reported a non-chat session id: ${sessionId}`);
    if (projectId.length === 0)
      throw new Error(`attached room ${sessionId} reported an empty project id`);
    this.session = {
      sessionId: sessionId as `chat-${string}`,
      projectId,
      dbPath: this.options.dbPath,
      repoRoot: this.options.repoRoot,
    };
    this.room = room;
    if (origin === "session/new") this.scheduleBootCatchUp(this.session);
  }

  /** The attached room, or undefined when none is bound (the host routes room RPCs off this). */
  public attachedRoom(): R | undefined {
    return this.room;
  }

  /** Whether this process has already spent its one attach — still true once the close has begun. */
  public isAttached(): boolean {
    return this.room !== undefined || this.closing !== undefined;
  }

  /** The frozen identity of the attached session, for assertions and the close record. */
  public attachedSession(): AttachedSession | undefined {
    return this.session;
  }

  /**
   * Closes the attached session exactly once. Concurrent triggers share ONE promise; a call after the close
   * settled returns that same settled promise (no second room shutdown, no second digest). With nothing
   * attached this resolves immediately.
   *
   * Order is load-bearing: the room shuts down FIRST (every transcript write is awaited inside it, so the
   * file the digest child reads is complete), THEN the digest is scheduled, THEN the caller may exit. A
   * forced-drain failure does NOT cancel the digest — a hung lane must not cost the session its memory — but
   * it is still re-thrown once the digest is away, so the caller reports it exactly as before.
   *
   * @param reason - why the close was triggered; recorded durably (see recordClose)
   */
  public detach(reason: string): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const room = this.room;
    const session = this.session;
    if (room === undefined || session === undefined) return Promise.resolve();
    const closing = this.runDetach(room, session, reason);
    this.closing = closing;
    // The shared promise is handled HERE so a rejection never surfaces as an unhandled rejection when a
    // later trigger no longer awaits it; every caller of detach() still receives the same rejection.
    closing.catch(() => undefined);
    return closing;
  }

  private async runDetach(room: R, session: AttachedSession, reason: string): Promise<void> {
    let failure: Error | undefined;
    try {
      await room.shutdown();
    } catch (error) {
      failure = asError(error);
    }
    const digest = this.scheduleDigest(session);
    this.room = undefined;
    await this.recordClose(session, reason, digest, failure);
    if (failure !== undefined) throw failure;
  }

  /** Fires the ONE detached digest for this session. Returns what the parent can honestly claim it did —
   *  the seam's own word (forked here, or handed to the process outside this job), never this class's guess. */
  private scheduleDigest(session: AttachedSession): string {
    if (!memoryEnabled()) return "skipped(memory-off)";
    try {
      return spawnDetachedDigest(
        {
          sessionId: session.sessionId,
          repoRoot: session.repoRoot,
          dbPath: session.dbPath,
          projectId: session.projectId,
        },
        this.options.spawnDigest,
      );
    } catch (error) {
      // A missing compiled entry is already recorded durably by the spawn seam itself; anything else
      // reaching here must not turn a close into a crash, so it is reported and the close continues.
      this.report(error);
      return `failed(${asError(error).message})`;
    }
  }

  /**
   * Boot catch-up (session/new only), EXCLUDING the session just attached: that one is digested on close,
   * and a crash before the close is recovered by the next boot. Fire-and-forget — the request path is never
   * gated on it; a failure is reported, never swallowed.
   */
  private scheduleBootCatchUp(session: AttachedSession): void {
    if (!memoryEnabled()) return;
    const run = this.options.catchUp ?? bootCatchUp;
    void run(
      {
        repoRoot: session.repoRoot,
        dbPath: session.dbPath,
        projectId: session.projectId,
        exclude: session.sessionId,
      },
      this.options.spawnCatchUpDigest ?? this.options.spawnDigest,
    ).catch((error: unknown) => this.report(error));
  }

  /**
   * The close reason durable home: one appended line in `<repoRoot>/.zer0/journal/room-close.log` naming the
   * session, the trigger, what happened to the digest, and any drain failure. Best-effort by design — a
   * close must never fail because a log line could not be written.
   */
  private async recordClose(
    session: AttachedSession,
    reason: string,
    digest: string,
    failure: Error | undefined,
  ): Promise<void> {
    const directory = path.join(session.repoRoot, ".zer0", CLOSE_LOG_DIR);
    const drain = failure === undefined ? "ok" : failure.message.replace(/\s+/gu, " ");
    const line = `${new Date().toISOString()} session=${session.sessionId} reason=${reason} digest=${digest} drain=${drain}\n`;
    try {
      await mkdir(directory, { recursive: true });
      await appendFile(path.join(directory, CLOSE_LOG_FILE), line, "utf8");
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    (this.options.onBackgroundFailure ?? diagnostic)(error);
  }
}
