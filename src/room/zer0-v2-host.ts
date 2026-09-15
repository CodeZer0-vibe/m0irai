/**
 * @file src/room/zer0-v2-host.ts
 * @purpose Run the constrained ACP/zer0.room JSON-RPC protocol over NDJSON stdio.
 * @exports RoomRpcServer, HostCloseTarget, closeHost, buildRoomCatalogSnapshot, parseJsonRpcRequest, JsonRpcWriter
 * @depends ../memory/digest-handoff, ../shared/atomic-write, ./attached-session-lifecycle, ./room-boot-progress, ./room-host, ./room-session-listing
 * @size-justified: Cohesive stdio protocol boundary owns lifecycle and writer serialization.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAgyStatuslineSettings } from "../chat/agy-statusline-config.js";
import { resolveDigestSpawns } from "../memory/digest-handoff.js";
import { writeFileAtomic } from "../shared/atomic-write.js";
import { AttachedSessionLifecycle } from "./attached-session-lifecycle.js";
import { bootProgressNotification } from "./room-boot-progress.js";
import {
  buildRoomCatalogSnapshot,
  readinessEvent,
  roomEventNotification,
} from "./room-host-support.js";
import { AliveRoomHost } from "./room-host.js";
import { isRoomMarked, listRoomSessions } from "./room-session-listing.js";
import {
  ROOM_VERSION,
  initializeResult,
  parseControl,
  parseModeCycle,
  parseModelAgent,
  requireRoomCwd,
  requireSessionId,
  validateInitialize,
  validateSessionCreateParams,
  validateSessionLoadParams,
} from "./zer0-v2-host-params.js";
import {
  RoomRequestScheduler,
  consumeRpcStdin,
  isReadOnlyRpcMethod,
  requestDomainFor,
} from "./zer0-v2-request-scheduler.js";
import {
  type JsonRpcRequest,
  JsonRpcWriter,
  MAX_CACHED_RPC_RESPONSES,
  ResponseReplayCache,
  asError,
  classifyRouteError,
  diagnostic,
  invalidParams,
  invalidRequest,
  jsonRpcError,
  methodNotFound,
  parseJsonRpcRequest,
  parsePermissionResponse,
  requestFingerprint,
  requestKey,
  responseFor,
} from "./zer0-v2-rpc.js";

const ROOM_MARKER = "zer0-v2-room.json";
const ROOM_SESSION_ROW_LIMIT = 128;
export {
  JsonRpcWriter,
  MAX_CACHED_RPC_RESPONSES,
  ResponseReplayCache,
  parseJsonRpcRequest,
  parsePermissionResponse,
} from "./zer0-v2-rpc.js";
export { buildRoomCatalogSnapshot } from "./room-host-support.js";
export { parseModeCycle } from "./zer0-v2-host-params.js";

interface RouteResult {
  readonly result: unknown;
  readonly afterResponse?: () => Promise<void>;
  readonly stop?: boolean;
}

interface ReplayEntry {
  readonly fingerprint: string;
  readonly response: Readonly<Record<string, unknown>>;
}

interface InFlightRequest {
  readonly fingerprint: string;
  readonly task: Promise<ReplayEntry>;
}

export class RoomRpcServer {
  private initialized = false;
  private stopping = false;
  private cacheReservations = 0;
  private readonly responses: ResponseReplayCache<ReplayEntry>;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly scheduler = new RoomRequestScheduler();
  // The ONE owner of the attached room: every attach and every close trigger goes through it.
  private readonly lifecycle: AttachedSessionLifecycle<AliveRoomHost>;

  public constructor(
    private readonly repoRoot: string,
    private readonly writer: JsonRpcWriter,
    private readonly dbPath: string,
    private readonly blobRoot: string,
    responseCapacity: number = MAX_CACHED_RPC_RESPONSES,
  ) {
    this.responses = new ResponseReplayCache<ReplayEntry>(responseCapacity);
    // F10: the close digest is handed to the Rust parent when it says so (ZER0_DIGEST_HANDOFF=1), because a
    // child forked here dies with this process's job object; boot catch-up always forks here.
    const digest = resolveDigestSpawns();
    this.lifecycle = new AttachedSessionLifecycle<AliveRoomHost>({
      repoRoot,
      dbPath,
      spawnDigest: digest.close,
      spawnCatchUpDigest: digest.catchUp,
    });
  }

  public async handleLine(line: string): Promise<void> {
    if (this.stopping || this.writer.failed() !== undefined) return;
    const request = await this.parseLine(line);
    if (request !== undefined) await this.acceptRequest(request);
  }

  private async parseLine(line: string): Promise<JsonRpcRequest | undefined> {
    let request: JsonRpcRequest;
    try {
      request = parseJsonRpcRequest(line);
    } catch (error) {
      await this.writer.write(
        responseFor(null, undefined, jsonRpcError(-32600, asError(error).message)),
      );
      return undefined;
    }
    return request;
  }

  private async acceptRequest(request: JsonRpcRequest): Promise<void> {
    const key = requestKey(request.id);
    const fingerprint = requestFingerprint(request);
    const cached = this.responses.get(key);
    if (cached !== undefined) {
      await this.writeReplay(request, fingerprint, cached);
      return;
    }
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) {
        await this.writeRequestIdConflict(request);
        return;
      }
      this.scheduler.track(
        running.task.then(async (entry) => {
          if (!this.stopping) await this.writer.write(entry.response);
        }),
      );
      return;
    }
    const safeUncached =
      isReadOnlyRpcMethod(request.method) || request.method === "zer0/room/shutdown";
    const cacheResponse = this.responses.canStoreNew(this.cacheReservations);
    if (!cacheResponse && !safeUncached) {
      await this.writer.write(
        responseFor(
          request.id,
          undefined,
          jsonRpcError(
            -32603,
            "request replay capacity reached; room remains available for reads and shutdown",
          ),
        ),
      );
      return;
    }
    if (cacheResponse) this.cacheReservations += 1;
    const domain = this.requestDomain(request);
    const task = this.scheduler.schedule(domain, () =>
      this.executeRequest(request, key, fingerprint, cacheResponse),
    );
    this.inFlight.set(key, { fingerprint, task });
    const cleanup = (): void => {
      if (this.inFlight.get(key)?.task === task) this.inFlight.delete(key);
      if (cacheResponse) this.cacheReservations -= 1;
    };
    void task.then(cleanup, cleanup);
    if (request.method === "zer0/room/shutdown") await task;
  }

  private requestDomain(request: JsonRpcRequest): ReturnType<typeof requestDomainFor> {
    const agent = typeof request.params.agent === "string" ? request.params.agent : "invalid";
    return requestDomainFor(request.method, agent, this.roomAttached());
  }

  private async executeRequest(
    request: JsonRpcRequest,
    key: string,
    fingerprint: string,
    cacheResponse: boolean,
  ): Promise<ReplayEntry> {
    let routed: RouteResult;
    try {
      routed = await this.route(request);
    } catch (error) {
      routed = { result: undefined };
      const entry = {
        fingerprint,
        response: responseFor(request.id, undefined, classifyRouteError(error)),
      };
      if (cacheResponse) this.responses.set(key, entry);
      if (!this.stopping) await this.writer.write(entry.response);
      // A shutdown that FAILED still ends this process. The lifecycle detached the room either way (the
      // digest is away and the close is recorded), so staying up would answer every later room RPC with
      // "a room session must be attached first" and leave the operator's quit hanging on stdin. The error
      // response is already out; only the serving stops.
      if (request.method === "zer0/room/shutdown") this.stopping = true;
      return entry;
    }
    const entry = { fingerprint, response: responseFor(request.id, routed.result) };
    if (cacheResponse) this.responses.set(key, entry);
    if (!this.stopping) await this.writer.write(entry.response);
    await routed.afterResponse?.();
    if (routed.stop) this.stopping = true;
    return entry;
  }

  private async writeReplay(
    request: JsonRpcRequest,
    fingerprint: string,
    cached: ReplayEntry,
  ): Promise<void> {
    if (cached.fingerprint !== fingerprint) return this.writeRequestIdConflict(request);
    await this.writer.write(cached.response);
  }

  private async writeRequestIdConflict(request: JsonRpcRequest): Promise<void> {
    await this.writer.write(
      responseFor(
        request.id,
        undefined,
        jsonRpcError(-32600, "request id was reused with different method or params"),
      ),
    );
  }

  /** Stops serving and closes the attached session; a close the shutdown RPC already ran is absorbed by the
   *  lifecycle (one close, one digest, whichever trigger arrives first). `reason` is recorded durably there. */
  public async shutdown(reason = "host-shutdown"): Promise<void> {
    this.stopping = true;
    await this.lifecycle.detach(reason);
  }

  public isStopping(): boolean {
    return this.stopping;
  }

  public drain(): Promise<void> {
    return this.scheduler.drain().then(() => this.writer.drain());
  }

  public drainWriter(): Promise<void> {
    return this.writer.drain();
  }

  public roomAttached(): boolean {
    return this.lifecycle.attachedRoom() !== undefined;
  }

  private async route(request: JsonRpcRequest): Promise<RouteResult> {
    if (!this.initialized) {
      if (request.method !== "initialize")
        throw invalidRequest("initialize is required before room calls");
      validateInitialize(request.params);
      this.initialized = true;
      return { result: initializeResult() };
    }
    if (request.method === "initialize") throw invalidRequest("initialize was already called");
    if (request.method === "session/list") return { result: await this.list(request.params) };
    if (request.method === "session/new") return this.newSession(request.params);
    if (request.method === "session/load") return this.loadSession(request.params);
    if (!this.roomAttached()) throw invalidRequest("a room session must be attached first");
    return this.routeRoomRequest(request);
  }

  private async list(params: Record<string, unknown>): Promise<unknown> {
    if (params.cwd !== undefined) await requireRoomCwd(params.cwd, this.repoRoot);
    if (params.cursor !== undefined && typeof params.cursor !== "string")
      throw invalidParams("cursor must be a string");
    // This constrained host deliberately does not support continuation tokens. Returning no page for
    // an unknown cursor prevents accidental legacy replay while remaining JSON-RPC-safe.
    if (typeof params.cursor === "string" && params.cursor.length > 0)
      throw invalidParams("session/list cursors are unsupported");
    return {
      sessions: await listRoomSessions({
        repoRoot: this.repoRoot,
        roomVersion: ROOM_VERSION,
        limit: ROOM_SESSION_ROW_LIMIT,
        // One line per damaged room, on the same stream every other host diagnostic uses. The listing
        // itself still succeeds: one torn transcript must not cost the operator the other rooms.
        report: (line) => process.stderr.write(`${line}\n`),
      }),
    };
  }

  private async newSession(params: Record<string, unknown>): Promise<RouteResult> {
    await validateSessionCreateParams(params, this.repoRoot);
    this.requireUnattachedRoom();
    const host = await this.createRoom();
    try {
      await markV2Session(this.repoRoot, host.sessionId());
    } catch (error) {
      await host.shutdown().catch(() => undefined);
      throw error;
    }
    this.lifecycle.attach(host, "session/new");
    return this.sessionAttached(host, { sessionId: host.sessionId() });
  }

  private async loadSession(params: Record<string, unknown>): Promise<RouteResult> {
    await validateSessionLoadParams(params, this.repoRoot);
    this.requireUnattachedRoom();
    const sessionId = params.sessionId as `chat-${string}`;
    if (!(await isV2Session(this.repoRoot, sessionId)))
      throw invalidParams("sessionId is not a Zer0 V2 room");
    const host = await this.createRoom(sessionId);
    this.lifecycle.attach(host, "session/load");
    return this.sessionAttached(host, {});
  }

  private sessionAttached(host: AliveRoomHost, result: unknown): RouteResult {
    return {
      result,
      afterResponse: async () => {
        await this.writer.write(roomEventNotification(readinessEvent(host.sessionId())));
        await host.activateRecovered();
      },
    };
  }

  private async routeRoomRequest(request: JsonRpcRequest): Promise<RouteResult> {
    const host = this.lifecycle.attachedRoom();
    if (host === undefined) throw invalidRequest("a room session must be attached first");
    const sessionId = requireSessionId(request.params);
    if (sessionId !== host.sessionId())
      throw invalidParams("sessionId does not match the attached room");
    switch (request.method) {
      case "zer0/room/catalog":
        return { result: buildRoomCatalogSnapshot(this.repoRoot) };
      // A SIBLING RPC rather than a field on the catalog: the catalog's Rust validator demands exact
      // keys and version 1, so extending it is a breaking edit to a surface three other features read.
      // The handler BODY lives in the readiness service, not here.
      case "zer0/room/agents":
        return { result: host.agentReadiness().snapshot() };
      case "zer0/room/submit":
        return { result: await submitRoomText(host, request) };
      case "zer0/room/control":
        return { result: await acknowledgeControl(host, request) };
      case "zer0/room/mode_cycle":
      case "zer0/room/models":
      case "zer0/room/model_select":
        return this.routeRoomAgentRequest(request, host);
      case "zer0/room/resync": {
        const afterEventSeq = request.params.afterEventSeq;
        if (typeof afterEventSeq !== "string" || !/^(0|[1-9][0-9]*)$/u.test(afterEventSeq))
          throw invalidParams("resync requires decimal afterEventSeq");
        return { result: host.eventsPageAfter(afterEventSeq) };
      }
      case "zer0/room/permission_response": {
        const response = parsePermissionResponse(request.params);
        return { result: { resolved: host.permissionResponse(response) } };
      }
      case "zer0/room/shutdown":
        return this.shutdownRoute();
      default:
        throw methodNotFound(`unknown method ${request.method}`);
    }
  }

  /**
   * ACKNOWLEDGED, then closed. A cross-language contract pinned on both sides, not an optimisation:
   * while the close ran BEFORE the response it spent the launcher's budget for the host's EXIT, and a
   * healthy host was terminated. `acknowledged` means the host HAS the request and is closing; the
   * EXIT is the evidence the close finished, so a close that fails after this point ends the process
   * non-zero instead of answering an error. Measurements and derivation:
   * `rust/crates/zer0-v2-bin/src/host_shutdown.rs`, `SHUTDOWN_RESPONSE_BOUND`.
   */
  private shutdownRoute(): RouteResult {
    return {
      result: { acknowledged: true },
      stop: true,
      afterResponse: () => this.lifecycle.detach("zer0/room/shutdown"),
    };
  }

  private async routeRoomAgentRequest(
    request: JsonRpcRequest,
    host: AliveRoomHost,
  ): Promise<RouteResult> {
    if (request.method === "zer0/room/mode_cycle") {
      const cycle = parseModeCycle(request.params, String(request.id));
      await host.cycleMode(cycle);
      return { result: { acknowledged: true } };
    }
    const agent = parseModelAgent(
      request.params,
      request.method === "zer0/room/models"
        ? ["sessionId", "agent"]
        : ["sessionId", "agent", "modelId"],
    );
    if (request.method === "zer0/room/models") {
      return { result: await host.listModels(agent) };
    }
    const modelId = request.params.modelId;
    if (
      typeof modelId !== "string" ||
      modelId.length === 0 ||
      Buffer.byteLength(modelId, "utf8") > 512
    ) {
      throw invalidParams("model_select requires a bounded modelId");
    }
    return { result: await host.selectModel(agent, modelId) };
  }

  private async createRoom(continueSessionId?: `chat-${string}`): Promise<AliveRoomHost> {
    ensureAgyStatusline();
    return AliveRoomHost.create({
      repoRoot: this.repoRoot,
      dbPath: this.dbPath,
      blobRoot: this.blobRoot,
      ...(continueSessionId === undefined ? {} : { continueSessionId }),
      onEvent: (event) => this.writer.write(roomEventNotification(event)),
      // The reason this host can be slow and still trusted: the terminal is holding `session/new`
      // open while `create` runs, and each stage renews its deadline. Awaited, so the frame is on the
      // wire before the stage it names begins rather than queued behind it.
      onBootProgress: (stage, detail) =>
        this.writer.writeBootProgress(bootProgressNotification(stage, detail)),
    });
  }

  private requireUnattachedRoom(): void {
    if (this.lifecycle.isAttached())
      throw invalidRequest("only one room may be attached to this host process");
  }
}

/** AGY owns one global statusLine setting. Install it at the production room
 * composition boundary, once per attached host, without making advisory
 * telemetry a startup dependency. */
function ensureAgyStatusline(): void {
  try {
    writeAgyStatuslineSettings();
  } catch (error) {
    diagnostic(
      new Error(
        `agy statusLine config failed; Gemini usage will remain unknown: ${asError(error).message}`,
      ),
    );
  }
}

async function main(): Promise<void> {
  const repoRoot = await realpath(process.cwd());
  const server = new RoomRpcServer(
    repoRoot,
    new JsonRpcWriter(),
    process.env.ZER0_DB_PATH ?? path.join(repoRoot, ".zer0", "evidence.db"),
    process.env.ZER0_BLOB_ROOT ?? path.join(repoRoot, ".zer0", "blobs"),
  );
  // A clean EOF (the operator quit / the client dropped the pipe) or the framing failure that ended the
  // stream — either way the close runs through the same lifecycle, carrying which one it was.
  let reason = "stdin-eof";
  try {
    await consumeRpcStdin(server);
  } catch (error) {
    reason = `stdin-error: ${asError(error).message}`;
    throw error;
  } finally {
    await closeHost(server, reason);
  }
}

/**
 * The close is UNCONDITIONAL. `drain()` re-throws a writer failure (a client that closed stdout but kept
 * stdin open reaches exactly that), and a rejection there used to skip everything after it: no detach, no
 * digest, no close record, room lanes never quiesced. Now a drain failure only renames the reason the close
 * is recorded under; the close always runs, and the failure is re-thrown afterwards so the exit code still
 * reports it.
 *
 * @param server - the room server to close
 * @param reason - why the stdin loop ended, unless draining supplies a louder one
 */
export interface HostCloseTarget {
  isStopping(): boolean;
  drain(): Promise<void>;
  shutdown(reason: string): Promise<void>;
  drainWriter(): Promise<void>;
}

export async function closeHost(server: HostCloseTarget, reason: string): Promise<void> {
  let failure: Error | undefined;
  let closeReason = reason;
  if (!server.isStopping()) {
    try {
      await server.drain();
    } catch (error) {
      failure = asError(error);
      closeReason = `drain-error: ${failure.message}`;
    }
  }
  await server.shutdown(closeReason);
  try {
    await server.drainWriter();
  } catch (error) {
    failure ??= asError(error);
  }
  if (failure !== undefined) throw failure;
}

/** Start the production stdio host from a compiled sidecar launcher. */
export function runZer0V2Host(): void {
  void main().catch(reportMainError);
}

/**
 * The marker is REPLACED, never rewritten in place, like every other room file. It is small enough that
 * a torn write looked impossible, but the listing reads it for every room and a marker it cannot parse
 * used to make that room vanish from the picker in silence — so the file that decides whether a room
 * exists at all gets the same guarantee as the transcript.
 */
async function markV2Session(repoRoot: string, sessionId: string): Promise<void> {
  await writeFileAtomic(
    path.join(repoRoot, ".council", "runs", sessionId, ROOM_MARKER),
    JSON.stringify({ version: ROOM_VERSION }),
  );
}

// The marker read now has two callers — this one and the listing's own first stage — so it lives with
// the listing. `markV2Session` above stays here, beside the session/new path that writes it.
async function isV2Session(repoRoot: string, sessionId: string): Promise<boolean> {
  return isRoomMarked(repoRoot, sessionId, ROOM_VERSION);
}

function reportMainError(error: unknown): void {
  diagnostic(error);
  process.exitCode = 4;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runZer0V2Host();

/** Split out of routeRoomRequest so that switch stays under the 50-line function clamp when slice A
 *  adds its `zer0/room/agents` case. Bodies unchanged. */
async function submitRoomText(
  host: AliveRoomHost,
  request: JsonRpcRequest,
): Promise<Readonly<Record<string, unknown>>> {
  const text = request.params.text;
  if (typeof text !== "string") throw invalidParams("submit text must be a string");
  return { ...(await host.submit({ requestId: String(request.id), text })) };
}

async function acknowledgeControl(
  host: AliveRoomHost,
  request: JsonRpcRequest,
): Promise<Readonly<Record<string, unknown>>> {
  const control = parseControl(request.params, String(request.id));
  await host.control(control);
  return { acknowledged: true, command: control.command, scope: control.scope ?? "latest" };
}
