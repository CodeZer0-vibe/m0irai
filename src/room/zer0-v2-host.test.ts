import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  type HostCloseTarget,
  JsonRpcWriter,
  ResponseReplayCache,
  RoomRpcServer,
  buildRoomCatalogSnapshot,
  closeHost,
  parseJsonRpcRequest,
  parsePermissionResponse,
} from "./zer0-v2-host.js";

const OVERSIZED_REQUEST = "{".repeat(1024 * 1024 + 1);

it("falsifier: response replay memory is bounded without evicting accepted IDs", () => {
  const cache = new ResponseReplayCache<number>(2);
  cache.set("one", 1);
  cache.set("two", 2);
  expect(cache.size()).toBe(2);
  expect(cache.get("one")).toBe(1);
  expect(cache.canStoreNew()).toBe(false);
  expect(() => cache.set("three", 3)).toThrow("capacity reached");
  cache.set("one", 10);
  expect(cache.get("one")).toBe(10);
  expect(cache.size()).toBe(2);
});

it("coalesces duplicate in-flight IDs and rejects a conflicting fingerprint", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-rpc-inflight-"));
  const { frames, writer } = recordingWriter();
  const server = new RoomRpcServer(root, writer, path.join(root, "evidence.db"), root, 8);
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: "same",
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  try {
    const first = server.handleLine(initialize);
    const duplicate = server.handleLine(initialize);
    const conflict = server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "same", method: "session/list", params: {} }),
    );
    await Promise.all([first, duplicate, conflict]);
    await server.drain();

    const same = frames.filter((frame) => frame.id === "same");
    expect(same.filter((frame) => Object.hasOwn(frame, "result"))).toHaveLength(2);
    expect(same.filter((frame) => record(frame.error).code === -32600)).toHaveLength(1);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps reads and shutdown available when the replay cache is saturated", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-rpc-capacity-"));
  const { frames, writer } = recordingWriter();
  const server = new RoomRpcServer(root, writer, path.join(root, "evidence.db"), root, 1);
  try {
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    );
    await server.drain();
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "list-1", method: "session/list", params: {} }),
    );
    await server.drain();
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "new", method: "session/new", params: {} }),
    );
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "list-2", method: "session/list", params: {} }),
    );
    await server.drain();

    expect(frames.find((frame) => frame.id === "list-1")).toHaveProperty("result");
    expect(frames.find((frame) => frame.id === "new")?.error).toMatchObject({ code: -32603 });
    expect(frames.find((frame) => frame.id === "list-2")).toHaveProperty("result");
    expect(server.isStopping()).toBe(false);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

it("falsifier: a shutdown that FAILS still ends the process instead of serving a closed room", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-rpc-shutdown-fail-"));
  const { frames, writer } = recordingWriter();
  const server = new RoomRpcServer(root, writer, path.join(root, "evidence.db"), root, 8);
  try {
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    );
    await server.drain();
    // Any shutdown that fails takes this path; routing without an attached room is the deterministic way
    // to reach it. What matters is that the FAILURE branch stops serving, not which failure it was.
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "bye", method: "zer0/room/shutdown", params: {} }),
    );
    await server.drain();

    // The client is told, exactly as before …
    expect(record(frames.find((frame) => frame.id === "bye")?.error).message).toContain(
      "a room session must be attached first",
    );
    // … and the process is finished. Without this, the host stayed up answering every later room RPC with
    // "must be attached first" while the operator's quit hung waiting for stdin to close.
    expect(server.isStopping()).toBe(true);
    const before = frames.length;
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "after", method: "session/list", params: {} }),
    );
    expect(frames).toHaveLength(before);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A close target that records the order of what the process boundary asked of it. */
function closeTarget(
  overrides: Partial<Record<"drain" | "drainWriter", () => Promise<void>>> = {},
  stopping = false,
): { calls: string[]; reasons: string[]; target: HostCloseTarget } {
  const calls: string[] = [];
  const reasons: string[] = [];
  return {
    calls,
    reasons,
    target: {
      isStopping: () => stopping,
      drain: async () => {
        calls.push("drain");
        await overrides.drain?.();
      },
      shutdown: async (reason: string) => {
        calls.push("shutdown");
        reasons.push(reason);
      },
      drainWriter: async () => {
        calls.push("drainWriter");
        await overrides.drainWriter?.();
      },
    },
  };
}

it("falsifier: a drain that rejects still closes the room, under a reason that names the drain failure", async () => {
  const { calls, reasons, target } = closeTarget({
    drain: () => Promise.reject(new Error("stdout write failed: EPIPE")),
  });

  // The rejection still reaches the caller — the exit code must keep reporting it …
  await expect(closeHost(target, "stdin-eof")).rejects.toThrow("stdout write failed: EPIPE");
  // … but only AFTER the close ran. Before this, the throw skipped shutdown entirely: no detach, no
  // digest, no close record, and the room's lanes were never quiesced.
  expect(calls).toEqual(["drain", "shutdown", "drainWriter"]);
  expect(reasons).toEqual(["drain-error: stdout write failed: EPIPE"]);
});

it("falsifier: a clean close carries the stdin reason, and a stopping server is not drained twice", async () => {
  const clean = closeTarget();
  await expect(closeHost(clean.target, "stdin-eof")).resolves.toBeUndefined();
  expect({ calls: clean.calls, reasons: clean.reasons }).toEqual({
    calls: ["drain", "shutdown", "drainWriter"],
    reasons: ["stdin-eof"],
  });

  // After an explicit shutdown the scheduler is already stopping; draining it again is not this path's job.
  const stopping = closeTarget({}, true);
  await closeHost(stopping.target, "zer0/room/shutdown");
  expect(stopping.calls).toEqual(["shutdown", "drainWriter"]);
});

it("falsifier: a writer that fails on the final flush is reported, and never hides an earlier failure", async () => {
  const late = closeTarget({ drainWriter: () => Promise.reject(new Error("final flush failed")) });
  await expect(closeHost(late.target, "stdin-eof")).rejects.toThrow("final flush failed");
  expect(late.calls).toEqual(["drain", "shutdown", "drainWriter"]);

  const both = closeTarget({
    drain: () => Promise.reject(new Error("first failure")),
    drainWriter: () => Promise.reject(new Error("second failure")),
  });
  await expect(closeHost(both.target, "stdin-eof")).rejects.toThrow("first failure");
});

function recordingWriter(): {
  readonly frames: Record<string, unknown>[];
  readonly writer: JsonRpcWriter;
} {
  const frames: Record<string, unknown>[] = [];
  const stdout = {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      frames.push(JSON.parse(chunk) as Record<string, unknown>);
      callback();
      return true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  return { frames, writer: new JsonRpcWriter(stdout) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

it("falsifier: room catalog is bounded, provider-owned, and terminal-safe", () => {
  const snapshot = buildRoomCatalogSnapshot(process.cwd()) as {
    version: number;
    agents: Record<string, Record<string, unknown>[]>;
  };
  expect(snapshot.version).toBe(1);
  expect(Object.keys(snapshot.agents)).toEqual(["claude", "codex", "gemini"]);
  for (const rows of Object.values(snapshot.agents)) {
    expect(rows.length).toBeLessThanOrEqual(64);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["description", "kind", "name", "trusted"]);
      expect(String(row.name)).toMatch(/^[a-z0-9][a-z0-9:._-]{0,48}$/u);
      expect(Buffer.byteLength(String(row.description), "utf8")).toBeLessThanOrEqual(240);
      expect(String(row.description)).not.toMatch(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
      );
      expect(row.trusted).toBe(row.kind === "builtin");
    }
  }
});

it("falsifier: the V2 catalog never advertises unsupported Gemini skills", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zer0-room-catalog-"));
  try {
    const skillDir = path.join(root, ".agents", "skills", "review-contract");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Review contract\n", "utf8");
    const snapshot = buildRoomCatalogSnapshot(root) as {
      agents: Record<string, { kind: string; name: string }[]>;
    };
    expect(snapshot.agents.codex).toContainEqual(
      expect.objectContaining({ kind: "skill", name: "review-contract" }),
    );
    expect(snapshot.agents.gemini).not.toContainEqual(
      expect.objectContaining({ kind: "skill", name: "review-contract" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("falsifier: JSON-RPC accepts string and numeric IDs but rejects the legacy room envelope", () => {
  expect(parseJsonRpcRequest('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}').id).toBe(
    7,
  );
  expect(
    parseJsonRpcRequest('{"jsonrpc":"2.0","id":"request-1","method":"initialize","params":{}}').id,
  ).toBe("request-1");
  expectLegacyEnvelopeRejected();
  expectOversizeRejected();
});

function expectLegacyEnvelopeRejected(): void {
  expect(() =>
    parseJsonRpcRequest('{"protocol":"zer0.room","version":1,"id":"x","method":"x","params":{}}'),
  ).toThrow("invalid JSON-RPC request");
}

function expectOversizeRejected(): void {
  expect(() => parseJsonRpcRequest(OVERSIZED_REQUEST)).toThrow("1 MiB");
}

it("falsifier: permission response is a strict option-or-deny discriminator", () => {
  expect(parsePermissionResponse({ askId: "ask-1", optionId: "  opaque-reject\t" })).toEqual({
    askId: "ask-1",
    optionId: "  opaque-reject\t",
  });
  expect(parsePermissionResponse({ askId: "ask-2", decision: "deny" })).toEqual({
    askId: "ask-2",
    decision: "deny",
  });
  expect(
    parsePermissionResponse({ sessionId: "room-1", askId: "ask-2a", decision: "deny" }),
  ).toEqual({ askId: "ask-2a", decision: "deny" });
  for (const params of [
    { askId: "ask-3" },
    { askId: "ask-4", optionId: "" },
    { askId: "ask-5", decision: "approve" },
    { askId: "ask-6", optionId: "offered", decision: "deny" },
    { askId: "ask-7", approve: true },
    { askId: "ask-8", optionId: "offered", approve: true },
  ])
    expect(() => parsePermissionResponse(params)).toThrow("invalid permission response");
});

it("falsifier: the stdout writer serializes a slow drain before the following frame", async () => {
  const writes: string[] = [];
  let drained: (() => void) | undefined;
  const stdout = {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      writes.push(chunk);
      callback();
      return writes.length !== 1;
    },
    once(_event: "drain", listener: () => void) {
      drained = listener;
      return this;
    },
    off(_event: "drain", listener: () => void) {
      if (drained === listener) drained = undefined;
      return this;
    },
  };
  const writer = new JsonRpcWriter(stdout);
  const first = writer.write({ jsonrpc: "2.0", id: 1, result: {} });
  const second = writer.write({ jsonrpc: "2.0", id: 2, result: {} });
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  drained?.();
  await Promise.all([first, second]);
  expect(writes).toEqual([
    '{"jsonrpc":"2.0","id":1,"result":{}}\n',
    '{"jsonrpc":"2.0","id":2,"result":{}}\n',
  ]);
});

it("falsifier: writer rejects a frame whose serialized envelope loses a required field", async () => {
  const writer = new JsonRpcWriter({
    write(): boolean {
      return true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  });
  await expect(
    writer.write({ jsonrpc: "2.0", id: "request-1", result: undefined }),
  ).rejects.toThrow("response");
});

/**
 * The shutdown route ACKNOWLEDGES first and closes afterwards, and that order is a cross-language
 * contract rather than a style choice.
 *
 * The Rust launcher clamps its graceful wait for the host's EXIT to whatever is left of its 7 s
 * ceiling once the shutdown response has arrived (`host_process.rs`, `shutdown()`). While the close
 * ran BEFORE the response, a room that spent its documented 4 s close budget left the launcher
 * 2.4 s — less than the 3,094 ms slowest exit ever measured from this host — and it terminated a
 * healthy process. Measured on 2026-09-12 by codex's counterexample and reproduced by the reviewer;
 * fixed on 2026-09-13 by moving the phase boundary, because the ceiling is a ratchet and does not
 * rise.
 *
 * Asserted on the source because the lifecycle is constructed inside `RoomRpcServer` and there is no
 * seam to inject a slow room through. What it guards is narrow and exact: the arm must hand the
 * detach to `afterResponse`, which `executeRequest` runs AFTER the write, and must not await it
 * inline. If this file grows a proper injection seam, replace this with the behavioural test.
 */
it("the shutdown route acknowledges before it closes, because the launcher's reap budget depends on it", async () => {
  const source = await readFile(new URL("./zer0-v2-host.ts", import.meta.url), "utf8");
  // The route arm delegates, and the method it delegates to is where the ordering lives.
  const arm = source.slice(source.indexOf('case "zer0/room/shutdown":'));
  expect(arm.slice(0, arm.indexOf("default:"))).toContain("return this.shutdownRoute()");
  const route = source.slice(source.indexOf("private shutdownRoute"));
  expect(route).not.toBe("");
  const body = route.slice(0, route.indexOf("\n  }"));
  expect(body).toContain("afterResponse: () => this.lifecycle.detach");
  expect(body).not.toContain("await this.lifecycle.detach");
  // And the mechanism it depends on: the write happens before `afterResponse` is awaited.
  const execute = source.slice(source.indexOf("private async executeRequest"));
  const write = execute.indexOf("await this.writer.write(entry.response)");
  const after = execute.indexOf("await routed.afterResponse?.()");
  expect(write).toBeGreaterThan(-1);
  expect(after).toBeGreaterThan(write);
});
