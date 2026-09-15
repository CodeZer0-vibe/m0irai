/**
 * @file src/adapters/acp/acp-session.ts
 * @purpose The one-shot ACP handshake: spawn the agent's ACP server as a JSON-RPC-stdio child, run
 *   initialize → newSession, return the newSession response (which carries the model list), and ALWAYS kill
 *   the child. Bounded by a timeout so a wedged adapter never hangs the picker. spawn + connection are
 *   injectable seams (AcpSessionDeps); the seam is a homegrown loose interface so the sdk's exact request/
 *   response types stay inside realDeps and a unit test can fake it with no subprocess + no sdk types.
 * @exports AcpSession, AcpSessionDeps, openAcpNewSession
 * @depends node:child_process, node:process, node:stream, @agentclientprotocol/sdk, ./acp-servers, ../../shared/hermetic
 */
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { type Client, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { assertNotHermetic } from "../../shared/hermetic.js";
import type { AcpServerSpec } from "./acp-servers.js";
import { acpSessionMetadata } from "./acp-turn-session.js";

/** The ACP `newSession` response — untrusted shape; {@link extractAcpModels} parses it. */
export type AcpSession = unknown;

const HANDSHAKE_TIMEOUT_MS = 30_000; // a wedged adapter must never hang the /model fetch
const PROTOCOL_VERSION = 1;

/** The child-process surface the handshake needs: kill it (orchestrator) + its stdio pipes (connect). */
type AcpChild = Pick<ChildProcess, "kill" | "stdin" | "stdout">;

/** A homegrown connection seam (loose types) so tests fake it without the sdk's exact request/response types. */
interface AcpConnection {
  initialize(): Promise<unknown>;
  newSession(): Promise<AcpSession>;
}

/** The seams: how to spawn the server + wrap it in a connection. Overridden in tests; real impls below. */
export interface AcpSessionDeps {
  readonly spawnServer: (spec: AcpServerSpec) => AcpChild;
  readonly connect: (child: AcpChild, agent: AcpServerSpec["agent"]) => AcpConnection;
}

// Host (client) side of ACP. Only requestPermission + sessionUpdate are required; stub them so setup never
// wedges — we only read newSession's model list, so any permission ask is auto-cancelled.
function hostHandler(): Client {
  return {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
  };
}

const realDeps: AcpSessionDeps = {
  spawnServer: (spec) => {
    assertNotHermetic("acp-session.spawnServer");
    return spawn(process.execPath, [spec.entry], {
      env: spec.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
  },
  connect: (child, agent) => {
    if (child.stdin === null || child.stdout === null) {
      throw new Error("ACP child process has no stdio pipes");
    }
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const conn = new ClientSideConnection(hostHandler, stream);
    return {
      initialize: () =>
        conn.initialize({ clientCapabilities: {}, protocolVersion: PROTOCOL_VERSION }),
      newSession: () =>
        conn.newSession({
          cwd: process.cwd(),
          mcpServers: [],
          ...acpSessionMetadata(agent),
        }),
    };
  },
};

/**
 * Spawns the agent's ACP server, runs the handshake, and returns the `newSession` response. ALWAYS kills the
 * child (finally). Each step is bounded by {@link HANDSHAKE_TIMEOUT_MS}; a timeout rejects (caller fails soft).
 *
 * @param spec - which agent's ACP server to spawn + the (subscription-first) child env
 * @param deps - spawn/connect seams (defaults to the real subprocess + sdk connection)
 * @returns the newSession response (parsed by extractAcpModels)
 */
export async function openAcpNewSession(
  spec: AcpServerSpec,
  deps: AcpSessionDeps = realDeps,
): Promise<AcpSession> {
  const child = deps.spawnServer(spec);
  try {
    const conn = deps.connect(child, spec.agent);
    await withTimeout(conn.initialize());
    return await withTimeout(conn.newSession());
  } finally {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("ACP handshake timeout")), HANDSHAKE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}
