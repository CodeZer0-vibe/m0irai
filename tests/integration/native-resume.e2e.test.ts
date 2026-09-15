/**
 * @file tests/integration/native-resume.e2e.test.ts
 * @purpose Live MT7 ACP resume receipts: bridge death -> session/resume -> sentinel recall for both ACP lanes,
 *   plus a gated Claude mid-turn kill probe for Q-4. Skipped unless ZER0_REAL_CLI=1.
 * @exports (test suite - no runtime exports)
 * @depends node:child_process, node:process, node:stream, vitest, @agentclientprotocol/sdk, src/adapters/acp/acp-permission, src/adapters/acp/acp-servers, src/adapters/acp/acp-turn-session
 */
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterAll, expect, it } from "vitest";
import { autoApproveDecider } from "../../src/adapters/acp/acp-permission.js";
import type { AcpAgent } from "../../src/adapters/acp/acp-servers.js";
import {
  acpSessionMetadata,
  createAcpClient,
  spawnServer,
} from "../../src/adapters/acp/acp-turn-session.js";

const RUN_REAL_CLI = process.env.ZER0_REAL_CLI === "1";
const PROTOCOL_VERSION = 1;
const LIVE_TIMEOUT_MS = 300_000;
const CWD = process.cwd();
const RECEIPT_FILE = path.join(CWD, ".council", "receipts", "mt7-native-resume.log");

// Receipts are ARTIFACTS, not console lines: runner stdout plumbing dropped them on the first live run.
function recordReceipt(line: string): void {
  console.log(line);
  mkdirSync(path.dirname(RECEIPT_FILE), { recursive: true });
  appendFileSync(RECEIPT_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
}

// This suite kills bridges ON PURPOSE; the ACP SDK then rejects a void-discarded internal promise with
// "ACP connection closed" below its (otherwise fully .catch-guarded) jsonrpc layer — the webstream cancel
// path. Filed as an SDK defect (findings 2026-07-10; patch-package candidate). The absorber is scoped to
// EXACTLY that error; anything else is re-thrown so the run still fails loudly.
const absorbedTeardownRejections: string[] = [];
if (RUN_REAL_CLI) {
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message === "ACP connection closed") {
      absorbedTeardownRejections.push(reason.message);
      return;
    }
    throw reason;
  });
  afterAll(() => {
    recordReceipt(`MT7_TEARDOWN absorbed_acp_closed=${absorbedTeardownRejections.length}`);
  });
}

interface LiveBridge {
  readonly child: ChildProcess;
  initialize(): Promise<void>;
  newSession(): Promise<string>;
  resumeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<LivePromptResult>;
  kill(): Promise<void>;
}

interface LivePromptResult {
  readonly reply: string;
  readonly stopReason: string;
  readonly updates: readonly unknown[];
}

it.skipIf(!RUN_REAL_CLI)(
  "ACP lanes recall a sentinel after bridge death and session/resume",
  async () => {
    for (const agent of ["claude", "codex"] as const) {
      const receipt = await bridgeDeathReceipt(agent);
      recordReceipt(receipt);
      expect(receipt).toContain(`lane=${agent}`);
      expect(receipt).toContain("recall=PASS");
    }
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!RUN_REAL_CLI)(
  "Q-4 receipt: Claude resume after a mid-turn bridge kill",
  async () => {
    const receipt = await claudeMidTurnReceipt();
    recordReceipt(receipt);
    expect(receipt).toContain("lane=claude");
    expect(receipt).toContain("q4_midturn=");
  },
  LIVE_TIMEOUT_MS,
);

async function bridgeDeathReceipt(agent: AcpAgent): Promise<string> {
  const sentinel = `MT7_${agent}_${Date.now()}`;
  const first = await openBridge(agent);
  await first.initialize();
  const sessionId = await first.newSession();
  const seed = await first.prompt(
    sessionId,
    `Remember this sentinel exactly: ${sentinel}. Reply STORED.`,
  );
  await first.kill();
  const second = await openBridge(agent);
  await second.initialize();
  await second.resumeSession(sessionId);
  const recall = await second.prompt(sessionId, "What exact sentinel did I ask you to remember?");
  await second.kill();
  const passed = recall.reply.includes(sentinel) ? "PASS" : "FAIL";
  return `MT7_LIVE lane=${agent} session=${sessionId} seedStop=${seed.stopReason} recall=${passed} recallStop=${recall.stopReason}`;
}

async function claudeMidTurnReceipt(): Promise<string> {
  const bridge = await openBridge("claude");
  await bridge.initialize();
  const sessionId = await bridge.newSession();
  await bridge.prompt(sessionId, "Remember Q4 sentinel MT7_Q4_SENTINEL. Reply STORED.");
  const pending = bridge.prompt(
    sessionId,
    "Start with MT7_Q4_STREAMING_STARTED, then write a long numbered list from 1 to 200 slowly.",
  );
  await delay(2_000);
  await bridge.kill();
  const killed = await settlePrompt(pending);
  const resumed = await openBridge("claude");
  await resumed.initialize();
  await resumed.resumeSession(sessionId);
  const recall = await resumed.prompt(sessionId, "Do you remember MT7_Q4_SENTINEL? Answer yes/no.");
  await resumed.kill();
  return `MT7_Q4 lane=claude session=${sessionId} q4_midturn=${killed} resumeStop=${recall.stopReason} recall=${clean(receiptText(recall.reply))}`;
}

async function openBridge(agent: AcpAgent): Promise<LiveBridge> {
  // THE PRODUCTION SPAWN, not a test-local sibling: the first cut of this file hand-rolled the spawn and
  // dropped Claude's production session metadata and reloaded filesystem hooks for the full 300s cap. The
  // receipt's whole value is proving the path production actually runs.
  const child = spawnServer(agent);
  let reply = "";
  let updates: unknown[] = [];
  const conn = connect(
    child,
    (chunk) => {
      reply += chunk;
    },
    (update) => updates.push(update),
  );
  return {
    child,
    initialize: async () => {
      await withStepTimeout(
        conn.initialize({ clientCapabilities: {}, protocolVersion: PROTOCOL_VERSION }),
        `${agent} initialize`,
      );
    },
    kill: () => killChild(child),
    newSession: () =>
      withStepTimeout(
        conn.newSession({ cwd: CWD, mcpServers: [], ...acpSessionMetadata(agent) }),
        `${agent} newSession`,
      ).then(sessionIdOf),
    prompt: async (sessionId, text) => {
      reply = "";
      updates = [];
      const result = await conn.prompt({ prompt: [{ text, type: "text" }], sessionId });
      return { reply, stopReason: String(result.stopReason), updates };
    },
    resumeSession: async (sessionId) => {
      await withStepTimeout(
        conn.resumeSession({ cwd: CWD, sessionId, ...acpSessionMetadata(agent) }),
        `${agent} resumeSession`,
      );
    },
  };
}

const HANDSHAKE_STEP_TIMEOUT_MS = 30_000;

// A wedged handshake must FAIL FAST NAMING ITS STEP — the first live run burned 600 silent seconds
// because every await sat under one opaque test-level cap. Prompts stay uncapped (model latency).
function withStepTimeout<T>(work: Promise<T>, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`live-bridge step timed out after 30s: ${step}`)),
      HANDSHAKE_STEP_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function connect(
  child: ChildProcess,
  onChunk: (chunk: string) => void,
  onUpdate: (update: unknown) => void,
): ClientSideConnection {
  if (child.stdin === null || child.stdout === null) throw new Error("missing bridge stdio");
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  return new ClientSideConnection(
    () =>
      createAcpClient({
        decide: autoApproveDecider,
        onSessionUpdate: onUpdate,
        onUpdate: onChunk,
        onUsage: () => undefined,
      }),
    stream,
  );
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000);
  });
}

async function settlePrompt(pending: Promise<LivePromptResult>): Promise<string> {
  try {
    const result = await pending;
    return `stop:${result.stopReason}`;
  } catch (error) {
    return `error:${clean(error instanceof Error ? error.message : String(error))}`;
  }
}

function sessionIdOf(response: unknown): string {
  if (typeof response === "object" && response !== null && "sessionId" in response) {
    const id = (response as { sessionId: unknown }).sessionId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  throw new Error("ACP session response returned no sessionId");
}

function receiptText(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}

function clean(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 220);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
