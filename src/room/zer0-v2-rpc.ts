/**
 * @file src/room/zer0-v2-rpc.ts
 * @purpose Owns bounded JSON-RPC replay, serialized output, parsing, and tagged protocol errors.
 * @exports ResponseReplayCache, JsonRpcWriter, RPC parsers, requestFingerprint, response/error helpers
 * @depends node:crypto, ./room-boot-progress, ./room-protocol
 */
import { createHash } from "node:crypto";
import { validateBootProgressFrame } from "./room-boot-progress.js";
import {
  type JsonRpcId,
  decodeWireFrame,
  encodeWireFrame,
  parseJsonRpcRequestFrame,
  validPermissionId,
  validateJsonRpcServerFrame,
} from "./room-protocol.js";

export const MAX_CACHED_RPC_RESPONSES = 65_536;
export type JsonRpcRequest = ReturnType<typeof parseJsonRpcRequestFrame>;

interface WritableStdout {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
  once(event: "drain", listener: () => void): this;
  off(event: "drain", listener: () => void): this;
}

export class ResponseReplayCache<T> {
  private readonly values = new Map<string, T>();

  public constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("response replay cache capacity must be a positive safe integer");
  }

  public get(key: string): T | undefined {
    return this.values.get(key);
  }

  public canStoreNew(reserved = 0): boolean {
    return this.values.size + reserved < this.capacity;
  }

  public set(key: string, value: T): void {
    if (!this.values.has(key) && !this.canStoreNew())
      throw new Error("response replay cache capacity reached");
    this.values.set(key, value);
  }

  public size(): number {
    return this.values.size;
  }
}

/** One drain-aware, serialized owner of protocol stdout. */
export class JsonRpcWriter {
  private writes: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  public constructor(private readonly stdout: WritableStdout = process.stdout) {}

  public write(frame: unknown): Promise<void> {
    return this.enqueue(frame, validateJsonRpcServerFrame);
  }

  /**
   * Writes one `zer0/room/boot_progress` notification through the SAME serialized queue as every other
   * frame, so a stage report can never split a response, but through its OWN validator.
   *
   * The separate validator is the point, not an oversight. `validateJsonRpcServerFrame` is the DURABLE
   * room frame's contract — it accepts exactly one notification method and the conformance corpus is
   * built on it. Boot progress is transient traffic between a terminal and the host it started, and
   * widening the durable validator to admit it would make every future room-frame proof negotiate with
   * a startup concern. See `room-boot-progress.ts`'s header for the full distinction.
   */
  public writeBootProgress(frame: unknown): Promise<void> {
    return this.enqueue(frame, validateBootProgressFrame);
  }

  private enqueue(frame: unknown, validate: (value: unknown) => void): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    let encoded: string;
    try {
      validate(frame);
      encoded = encodeWireFrame(frame);
      validate(decodeWireFrame(Buffer.from(encoded, "utf8")));
    } catch (error) {
      return Promise.reject(error);
    }
    const write = this.writes.then(() => this.writeOne(encoded));
    this.writes = write.catch((error: unknown) => {
      this.failure ??= asError(error);
    });
    return write;
  }

  public async drain(): Promise<void> {
    await this.writes;
    if (this.failure !== undefined) throw this.failure;
  }

  public failed(): Error | undefined {
    return this.failure;
  }

  private writeOne(chunk: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let drained = false;
      let callbackDone = false;
      let callbackError: Error | null | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled || !callbackDone) return;
        if (callbackError !== undefined && callbackError !== null) {
          this.stdout.off("drain", onDrain);
          settled = true;
          reject(callbackError);
          return;
        }
        if (!drained) return;
        this.stdout.off("drain", onDrain);
        settled = true;
        resolve();
      };
      const onDrain = (): void => {
        drained = true;
        finish();
      };
      const accepted = this.stdout.write(chunk, (error) => {
        callbackDone = true;
        callbackError = error;
        finish();
      });
      if (accepted) drained = true;
      else this.stdout.once("drain", onDrain);
      finish();
    });
  }
}

export function parseJsonRpcRequest(line: string): JsonRpcRequest {
  try {
    return parseJsonRpcRequestFrame(Buffer.from(`${line}\n`, "utf8"));
  } catch (error) {
    throw invalidRequest(asError(error).message);
  }
}

export function parsePermissionResponse(params: Record<string, unknown>): {
  readonly askId: string;
} & (Readonly<{ optionId: string }> | Readonly<{ decision: "deny" }>) {
  const { askId, optionId, decision } = params;
  if (!validPermissionId(askId)) throw invalidParams("invalid permission response");
  const hasOptionId = Object.hasOwn(params, "optionId");
  const hasDecision = Object.hasOwn(params, "decision");
  if (hasOptionId === hasDecision) throw invalidParams("invalid permission response");
  if (
    hasOptionId &&
    validPermissionId(optionId) &&
    hasOnlyPermissionResponseKeys(params, ["sessionId", "askId", "optionId"])
  )
    return { askId, optionId };
  if (
    hasDecision &&
    decision === "deny" &&
    hasOnlyPermissionResponseKeys(params, ["sessionId", "askId", "decision"])
  )
    return { askId, decision: "deny" };
  throw invalidParams("invalid permission response");
}

function hasOnlyPermissionResponseKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(params).every((key) => allowed.includes(key));
}

export interface JsonRpcError {
  readonly code: -32600 | -32601 | -32602 | -32603;
  readonly message: string;
}
interface TaggedError extends Error {
  readonly jsonRpcCode: JsonRpcError["code"];
}

export function jsonRpcError(code: JsonRpcError["code"], message: string): JsonRpcError {
  return { code, message };
}
function taggedError(code: JsonRpcError["code"], message: string): TaggedError {
  return Object.assign(new Error(message), { jsonRpcCode: code });
}
export function invalidRequest(message: string): TaggedError {
  return taggedError(-32600, message);
}
export function methodNotFound(message: string): TaggedError {
  return taggedError(-32601, message);
}
export function invalidParams(message: string): TaggedError {
  return taggedError(-32602, message);
}
/**
 * A server-side failure whose DETAIL the caller still needs. An untagged throw reaches the client as a
 * bare "internal error" with the cause only on stderr — right for a bug, wrong for a room the operator
 * asked for and the host could not read: they need the room and the reason in the reply itself.
 */
export function internalError(message: string): TaggedError {
  return taggedError(-32603, message);
}
export function classifyRouteError(error: unknown): JsonRpcError {
  if (isTaggedError(error)) return jsonRpcError(error.jsonRpcCode, error.message);
  diagnostic(error);
  return jsonRpcError(-32603, "internal error");
}
function isTaggedError(error: unknown): error is TaggedError {
  return error instanceof Error && "jsonRpcCode" in error && typeof error.jsonRpcCode === "number";
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
export function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}
export function requestFingerprint(request: JsonRpcRequest): string {
  return createHash("sha256")
    .update(request.method)
    .update("\0")
    .update(canonicalJson(request.params))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
export function diagnostic(error: unknown): void {
  process.stderr.write(`${asError(error).stack ?? asError(error).message}\n`);
}
export function responseFor(
  id: JsonRpcId | null,
  result?: unknown,
  error?: JsonRpcError,
): Readonly<Record<string, unknown>> {
  return error === undefined ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error };
}
