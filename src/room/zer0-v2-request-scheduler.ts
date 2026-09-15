/**
 * @file src/room/zer0-v2-request-scheduler.ts
 * @purpose Owns V2 JSON-RPC ingress framing and request-domain ordering without blocking the room on provider pickers.
 * @exports RoomRequestScheduler, consumeRpcStdin, requestDomainFor, isReadOnlyRpcMethod, RequestDomain, RpcLineServer
 * @depends ./room-protocol, ./zer0-v2-rpc
 */
import { decodeWireFrame } from "./room-protocol.js";
import { asError } from "./zer0-v2-rpc.js";

export type RequestDomain =
  | Readonly<{ kind: "mutation" }>
  | Readonly<{ kind: "read" }>
  | Readonly<{ kind: "model-read"; agent: string }>
  | Readonly<{ kind: "model-mutation"; agent: string }>;

export interface RpcLineServer {
  handleLine(line: string): Promise<void>;
  isStopping(): boolean;
}

export function isReadOnlyRpcMethod(method: string): boolean {
  return [
    "session/list",
    "zer0/room/agents",
    "zer0/room/catalog",
    "zer0/room/models",
    "zer0/room/resync",
  ].includes(method);
}

export function requestDomainFor(
  method: string,
  agent: string,
  roomAttached: boolean,
): RequestDomain {
  if (!roomAttached) return { kind: "mutation" };
  if (method === "session/list" || method === "zer0/room/agents") return { kind: "read" };
  if (method === "zer0/room/models") return { kind: "model-read", agent };
  if (method === "zer0/room/model_select") return { kind: "model-mutation", agent };
  return { kind: "mutation" };
}

/** Serializes room mutations while allowing slow discovery reads to remain off the critical path. */
export class RoomRequestScheduler {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly modelTails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<unknown>>();

  /**
   * ⚠ A `read` STARTS IMMEDIATELY, and this line is the whole of that change.
   *
   * Before it, `start` was `priorMutation` for every domain there is — so classifying a method as
   * `read` only stopped it EXTENDING the mutation tail (:55-57), never stopped it WAITING on one.
   * Avoiding extension is not bypassing, and `session/list` had been paying that cost all along
   * against a class whose own purpose says otherwise: "allowing slow discovery reads to remain off the
   * critical path".
   *
   * Nothing else moves. A `read` still does not set `mutationTail`, still registers in `active`
   * through `track`, and still participates in `drain` exactly as before — so a shutdown still sees
   * every in-flight request. That last part is why the rejected alternative (bypass the scheduler for
   * the readiness RPC) is worse: a second admission path is a request the drain cannot see.
   */
  public schedule<T>(domain: RequestDomain, work: () => Promise<T>): Promise<T> {
    const priorMutation = domain.kind === "read" ? Promise.resolve() : this.mutationTail;
    const priorModel = "agent" in domain ? this.modelTails.get(domain.agent) : undefined;
    const start =
      priorModel === undefined ? priorMutation : Promise.all([priorMutation, priorModel]);
    const task = start.then(work);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    if (domain.kind === "mutation" || domain.kind === "model-mutation") {
      this.mutationTail = settled;
    }
    if ("agent" in domain) this.modelTails.set(domain.agent, settled);
    this.track(task);
    return task;
  }

  public track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task);
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    );
    return task;
  }

  public async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active]);
  }
}

/** Consume strict LF-framed JSON-RPC while request execution is coordinated by the server. */
export async function consumeRpcStdin(
  server: RpcLineServer,
  stdin: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    const result = await consumeFrames(server, pending);
    pending = Buffer.from(result.pending);
    if (result.stopped) return;
  }
  if (pending.length > 0) throw new Error("JSON-RPC stdin closed with an unterminated frame");
}

async function consumeFrames(
  server: RpcLineServer,
  source: Buffer,
): Promise<{ readonly pending: Buffer; readonly stopped: boolean }> {
  let pending = source;
  for (;;) {
    const end = pending.indexOf(0x0a);
    if (end < 0) {
      if (pending.length > 1_048_575) throw new Error("JSON-RPC frame exceeds 1 MiB including LF");
      return { pending, stopped: false };
    }
    const raw = pending.subarray(0, end + 1);
    pending = pending.subarray(end + 1);
    await consumeFrame(server, raw);
    if (server.isStopping()) return { pending, stopped: true };
  }
}

async function consumeFrame(server: RpcLineServer, raw: Buffer): Promise<void> {
  try {
    decodeWireFrame(raw);
  } catch (error) {
    if (asError(error).message === "wire frame is not strict UTF-8") throw error;
    await server.handleLine("{");
    return;
  }
  await server.handleLine(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, -1)));
}
