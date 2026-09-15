// The protocol boundary's input validation: what a hostile or buggy client reaches first. Every falsifier
// here is about REFUSING something — an unexpected key, a relative cwd, a cwd outside the project, a
// session id that is not a room. The mode-cycle falsifier moved here with its subject when the validators
// were split out of zer0-v2-host.ts.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "zer0-host-params-"): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

it("falsifier: mode cycle is a strict text-bearing RPC and cannot be mistaken for submit", () => {
  expect(parseModeCycle({ sessionId: "chat-room", text: "@codex fix" }, "cycle-1")).toEqual({
    requestId: "cycle-1",
    text: "@codex fix",
  });
  for (const params of [
    { sessionId: "chat-room" },
    { sessionId: "chat-room", text: 1 },
    { sessionId: "chat-room", text: "", extra: true },
  ])
    expect(() => parseModeCycle(params, "cycle-1")).toThrow("mode_cycle");
});

it("falsifier: a cwd is accepted only when it canonicalises to the host's own project root", async () => {
  const root = tempRoot();
  const elsewhere = tempRoot("zer0-host-params-other-");
  await expect(requireRoomCwd(root, root)).resolves.toBeUndefined();
  await expect(requireRoomCwd(elsewhere, root)).rejects.toThrow(
    "cwd must match the host project root",
  );
  await expect(requireRoomCwd(".", root)).rejects.toThrow("cwd must be absolute");
  await expect(requireRoomCwd(42, root)).rejects.toThrow("cwd must be absolute");
  await expect(requireRoomCwd(path.join(root, "no-such-dir"), root)).rejects.toThrow(
    "cwd must name an existing directory",
  );
});

it("falsifier: session/new refuses anything but an empty mcpServers array, and load needs a chat id", async () => {
  const root = tempRoot();
  await expect(
    validateSessionCreateParams({ cwd: root, mcpServers: [] }, root),
  ).resolves.toBeUndefined();
  for (const mcpServers of [undefined, {}, [{ name: "x" }]])
    await expect(validateSessionCreateParams({ cwd: root, mcpServers }, root)).rejects.toThrow(
      "mcpServers must be an empty array",
    );
  await expect(
    validateSessionLoadParams({ cwd: root, mcpServers: [], sessionId: "chat-1" }, root),
  ).resolves.toBeUndefined();
  for (const sessionId of [undefined, 7, "room-1"])
    await expect(
      validateSessionLoadParams({ cwd: root, mcpServers: [], sessionId }, root),
    ).rejects.toThrow("sessionId must be a chat session id");
});

it("falsifier: initialize is pinned to this protocol version and a client capabilities object", () => {
  expect(() => validateInitialize({ protocolVersion: 1, clientCapabilities: {} })).not.toThrow();
  for (const params of [
    { protocolVersion: 2, clientCapabilities: {} },
    { protocolVersion: 1 },
    { protocolVersion: 1, clientCapabilities: [] },
  ])
    expect(() => validateInitialize(params)).toThrow("initialize requires protocolVersion 1");
  expect(() =>
    validateInitialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: "nope" }),
  ).toThrow("clientInfo must be an object");
  const result = initializeResult() as { protocolVersion: number };
  expect(result.protocolVersion).toBe(ROOM_VERSION);
});

it("falsifier: control scope and agent are cancellation-only, and an agent scope needs its agent", () => {
  expect(parseControl({ command: "pause" }, "r1")).toEqual({ requestId: "r1", command: "pause" });
  expect(parseControl({ command: "cancel", scope: "agent", agent: "codex" }, "r2")).toEqual({
    requestId: "r2",
    command: "cancel",
    scope: "agent",
    agent: "codex",
  });
  expect(() => parseControl({ command: "restart" }, "r3")).toThrow(
    "unsupported room control command",
  );
  expect(() => parseControl({ command: "cancel", scope: "agent" }, "r4")).toThrow(
    "agent scope requires agent",
  );
  expect(() => parseControl({ command: "pause", scope: "all" }, "r5")).toThrow(
    "valid only for cancellation",
  );
  expect(() => parseControl({ command: "cancel", agent: "gpt" }, "r6")).toThrow(
    "unsupported room control agent",
  );
});

it("falsifier: model requests carry exactly their declared keys and a known agent", () => {
  expect(parseModelAgent({ sessionId: "chat-1", agent: "gemini" }, ["sessionId", "agent"])).toBe(
    "gemini",
  );
  expect(() =>
    parseModelAgent({ sessionId: "chat-1", agent: "gemini", extra: 1 }, ["sessionId", "agent"]),
  ).toThrow("unexpected fields");
  expect(() =>
    parseModelAgent({ sessionId: "chat-1", agent: "llama" }, ["sessionId", "agent"]),
  ).toThrow("requires claude, codex, or gemini");
  expect(requireSessionId({ sessionId: "chat-1" })).toBe("chat-1");
  for (const params of [{}, { sessionId: "" }, { sessionId: 3 }])
    expect(() => requireSessionId(params)).toThrow("sessionId is required");
});
