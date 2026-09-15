/**
 * @file src/room/room-host-process.ts
 * @purpose Start and supervise the real room stdio host for integration tests.
 * @exports ManagedRoomHost, spawnRoomHost, RoomHostFrame, RoomHostExit, SpawnRoomHostOptions
 * @depends node:child_process, node:path, node:url, ./room-boot-progress, ./room-protocol
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BOOT_PROGRESS_METHOD, validateBootProgressFrame } from "./room-boot-progress.js";
import { MAX_FRAME_BYTES, decodeWireFrame, validateJsonRpcServerFrame } from "./room-protocol.js";
const MAX_BUFFERED_FRAME_BYTES = 4 * MAX_FRAME_BYTES;
const MAX_STDERR_BYTES = 64 * 1024;
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const ROOM_HOST_ENTRY = path.join(REPO_ROOT, "src", "room", "zer0-v2-host.ts");
const TSX_LOADER = pathToFileURL(
  path.join(REPO_ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;

export type RoomHostFrame = Readonly<Record<string, unknown>>;

export interface RoomHostExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnRoomHostOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface StoredFrame {
  readonly bytes: number;
  readonly frame: RoomHostFrame;
}

interface FrameWaiter {
  readonly predicate: (frame: RoomHostFrame) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (frame: RoomHostFrame) => void;
  readonly timer: NodeJS.Timeout;
}

/** Test-local process boundary for the real zer0-v2 stdio host. */
export class ManagedRoomHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reaped: Promise<RoomHostExit>;
  private readonly resolveReaped: (exit: RoomHostExit) => void;
  private readonly storedFrames: StoredFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private stderr = Buffer.alloc(0);
  private stdoutChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private bufferedFrameBytes = 0;
  private readonly bootProgressFrames: RoomHostFrame[] = [];
  private exited: RoomHostExit | undefined;
  private failure: Error | undefined;

  public constructor(options: SpawnRoomHostOptions = {}) {
    let resolveReaped!: (exit: RoomHostExit) => void;
    this.reaped = new Promise<RoomHostExit>((resolve) => {
      resolveReaped = resolve;
    });
    this.resolveReaped = resolveReaped;
    this.child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, ROOM_HOST_ENTRY, ...(options.args ?? [])],
      {
        cwd: options.cwd ?? REPO_ROOT,
        env: childEnvironment(options.env),
        shell: false,
        stdio: "pipe",
      },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.acceptStdout(Buffer.from(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => this.appendStderr(Buffer.from(chunk)));
    this.child.on("error", (error) =>
      this.fail(new Error(`room host failed to spawn: ${error.message}`)),
    );
    this.child.on("close", (code, signal) => this.onClose({ code, signal }));
  }

  public frames(): readonly RoomHostFrame[] {
    return this.storedFrames.map((stored) => stored.frame);
  }

  /** The startup stage reports this host emitted, in arrival order. Separate from {@link frames} —
   *  see `acceptBootProgress`. Surfaced rather than dropped so the traffic is assertable. */
  public bootProgress(): readonly RoomHostFrame[] {
    return [...this.bootProgressFrames];
  }

  public stderrDiagnostics(): string {
    return this.stderr.toString("utf8");
  }

  public async send(frame: Readonly<Record<string, unknown>>): Promise<void> {
    this.throwIfFailed();
    if (this.exited !== undefined) throw this.exitError();
    await this.sendRaw(JSON.stringify(frame));
  }

  /** Test-only raw NDJSON ingress for malformed and oversized protocol falsifiers. */
  public async sendRaw(line: string): Promise<void> {
    await this.sendBytes(Buffer.from(`${line}\n`, "utf8"));
  }

  /** Test-only byte ingress for strict UTF-8 and EOF framing falsifiers. */
  public async sendBytes(bytes: Uint8Array): Promise<void> {
    this.throwIfFailed();
    if (this.exited !== undefined) throw this.exitError();
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(bytes, (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  public waitFor(
    predicate: (frame: RoomHostFrame) => boolean,
    timeoutMs: number,
  ): Promise<RoomHostFrame> {
    try {
      this.throwIfFailed();
      const found = this.findFrame(predicate);
      if (found !== undefined) return Promise.resolve(found);
      if (this.exited !== undefined) return Promise.reject(this.exitError());
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise<RoomHostFrame>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.rejectWaiter(waiter, this.timeoutError("waiting for room host frame", timeoutMs)),
        timeoutMs,
      );
      const waiter: FrameWaiter = { predicate, reject, resolve, timer };
      const found = this.findFrame(predicate);
      if (found !== undefined) this.resolveWaiter(waiter, found);
      else if (this.failure !== undefined) this.rejectWaiter(waiter, this.failure);
      else if (this.exited !== undefined) this.rejectWaiter(waiter, this.exitError());
      else this.waiters.push(waiter);
    });
  }

  public async closeStdinAndWait(timeoutMs: number): Promise<RoomHostExit> {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) await this.endStdin();
    const exit = await this.waitForReap(timeoutMs, "waiting for room host EOF shutdown");
    this.throwIfFailed();
    return exit;
  }

  public async forceKillAndReap(timeoutMs: number): Promise<RoomHostExit> {
    if (this.exited === undefined) this.child.kill("SIGKILL");
    return this.waitForReap(timeoutMs, "waiting for killed room host");
  }

  public async dispose(): Promise<void> {
    if (this.exited !== undefined) return;
    try {
      await this.closeStdinAndWait(2_000);
    } catch {
      await this.forceKillAndReap(2_000);
    }
  }

  private acceptStdout(chunk: Buffer): void {
    let remaining = chunk;
    while (remaining.length > 0) {
      const newline = remaining.indexOf(0x0a);
      if (newline === -1) {
        this.appendStdout(remaining);
        return;
      }
      this.appendStdout(remaining.subarray(0, newline));
      this.parseStdoutLine();
      remaining = remaining.subarray(newline + 1);
    }
  }

  private appendStdout(chunk: Buffer): void {
    if (this.failure !== undefined) return;
    if (this.stdoutBytes + chunk.length > MAX_FRAME_BYTES) {
      this.fail(new Error("room host stdout frame exceeds 1 MiB"));
      return;
    }
    this.stdoutChunks.push(chunk);
    this.stdoutBytes += chunk.length;
  }

  private parseStdoutLine(): void {
    if (this.failure !== undefined) return;
    const raw = Buffer.concat(this.stdoutChunks, this.stdoutBytes);
    this.stdoutChunks = [];
    this.stdoutBytes = 0;
    let parsed: unknown;
    try {
      parsed = decodeWireFrame(Buffer.concat([raw, Buffer.from("\n")]));
    } catch (error) {
      this.fail(new Error(`room host emitted non-JSON stdout: ${asError(error).message}`));
      return;
    }
    if (this.acceptBootProgress(parsed)) return;
    try {
      validateJsonRpcServerFrame(parsed);
    } catch (error) {
      this.fail(new Error(`room host emitted non-JSON stdout: ${asError(error).message}`));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail(new Error("room host emitted a non-object JSON stdout frame"));
      return;
    }
    this.addFrame(parsed as RoomHostFrame, raw.length);
  }

  /**
   * Takes one frame if it is startup progress, mirroring the Rust terminal's own stdout reader.
   *
   * Classified BEFORE the room-frame validator and for the same reason that reader has:
   * `validateJsonRpcServerFrame` accepts exactly one notification method by design, and it is not
   * being widened for transient startup traffic. Progress is kept in its OWN collection rather than
   * mixed into `frames()`, so every existing frame-sequence assertion still sees the stream it always
   * saw — a stage report is not a room frame and must never be counted as one.
   *
   * A frame that claims the method and fails the shape FAILS the host rather than being ignored: this
   * harness exists to catch the host emitting things it should not.
   */
  private acceptBootProgress(parsed: unknown): boolean {
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).method !== BOOT_PROGRESS_METHOD
    )
      return false;
    try {
      validateBootProgressFrame(parsed);
    } catch (error) {
      this.fail(new Error(`room host emitted invalid boot progress: ${asError(error).message}`));
      return true;
    }
    this.bootProgressFrames.push(parsed as RoomHostFrame);
    return true;
  }

  private addFrame(frame: RoomHostFrame, bytes: number): void {
    this.storedFrames.push({ bytes, frame });
    this.bufferedFrameBytes += bytes;
    while (this.bufferedFrameBytes > MAX_BUFFERED_FRAME_BYTES && this.storedFrames.length > 1) {
      const discarded = this.storedFrames.shift();
      if (discarded !== undefined) this.bufferedFrameBytes -= discarded.bytes;
    }
    for (const waiter of this.waiters.splice(0)) {
      try {
        if (waiter.predicate(frame)) this.resolveWaiter(waiter, frame);
        else this.waiters.push(waiter);
      } catch (error) {
        this.rejectWaiter(waiter, asError(error));
      }
    }
  }

  private appendStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderr, chunk]);
    this.stderr =
      combined.length <= MAX_STDERR_BYTES
        ? combined
        : combined.subarray(combined.length - MAX_STDERR_BYTES);
  }

  private endStdin(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.child.stdin.off("error", onError);
        reject(error);
      };
      this.child.stdin.once("error", onError);
      this.child.stdin.end(() => {
        this.child.stdin.off("error", onError);
        resolve();
      });
    });
  }

  private onClose(exit: RoomHostExit): void {
    this.exited = exit;
    if (this.stdoutBytes > 0 && this.failure === undefined)
      this.fail(new Error("room host closed with an unterminated stdout frame"));
    this.resolveReaped(exit);
    const error = this.failure ?? this.exitError();
    for (const waiter of this.waiters.splice(0)) this.rejectWaiter(waiter, error);
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) this.rejectWaiter(waiter, error);
  }

  private findFrame(predicate: (frame: RoomHostFrame) => boolean): RoomHostFrame | undefined {
    return this.storedFrames.map((stored) => stored.frame).find(predicate);
  }

  private resolveWaiter(waiter: FrameWaiter, frame: RoomHostFrame): void {
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private rejectWaiter(waiter: FrameWaiter, error: Error): void {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private async waitForReap(timeoutMs: number, action: string): Promise<RoomHostExit> {
    return withTimeout(this.reaped, timeoutMs, () => this.timeoutError(action, timeoutMs));
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private exitError(): Error {
    const exit = this.exited;
    return new Error(
      `room host exited before the expected frame (${exit === undefined ? "unknown" : `code=${String(exit.code)} signal=${String(exit.signal)}`}); stderr: ${this.stderrDiagnostics()}`,
    );
  }

  private timeoutError(action: string, timeoutMs: number): Error {
    return new Error(
      `${action} timed out after ${String(timeoutMs)}ms; stderr: ${this.stderrDiagnostics()}`,
    );
  }
}

export function spawnRoomHost(options: SpawnRoomHostOptions = {}): ManagedRoomHost {
  return new ManagedRoomHost(options);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function childEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    TSX_TSCONFIG_PATH: path.join(REPO_ROOT, "tsconfig.json"),
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[key];
  }
  return environment;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
