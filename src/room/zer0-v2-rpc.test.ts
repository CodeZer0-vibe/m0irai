/**
 * @file src/room/zer0-v2-rpc.test.ts
 * @purpose Locks bounded replay and exact JSON-RPC permission/identity semantics.
 * @exports (test suite)
 * @depends vitest, ./zer0-v2-rpc
 */
import { expect, it } from "vitest";
import {
  ResponseReplayCache,
  classifyRouteError,
  invalidParams,
  parseJsonRpcRequest,
  parsePermissionResponse,
  requestFingerprint,
  requestKey,
  responseFor,
} from "./zer0-v2-rpc.js";

it("bounds replay without evicting or overwriting an existing request", () => {
  const cache = new ResponseReplayCache<string>(2);
  cache.set("one", "first");
  cache.set("two", "second");
  cache.set("one", "replacement");

  expect(cache.size()).toBe(2);
  expect(cache.get("one")).toBe("replacement");
  expect(cache.canStoreNew()).toBe(false);
  expect(() => cache.set("three", "third")).toThrow("capacity reached");
  expect(() => new ResponseReplayCache(0)).toThrow("positive safe integer");
});

it("accepts exactly one permission decision form and rejects ambiguous payloads", () => {
  expect(
    parsePermissionResponse({ sessionId: "room-1", askId: "ask-1", optionId: "allow" }),
  ).toEqual({
    askId: "ask-1",
    optionId: "allow",
  });
  expect(
    parsePermissionResponse({ sessionId: "room-1", askId: "ask-1", decision: "deny" }),
  ).toEqual({
    askId: "ask-1",
    decision: "deny",
  });
  expect(() =>
    parsePermissionResponse({
      sessionId: "room-1",
      askId: "ask-1",
      optionId: "allow",
      decision: "deny",
    }),
  ).toThrow("invalid permission response");
});

it("keeps string and numeric request ids distinct and preserves tagged route errors", () => {
  expect(requestKey(7)).not.toBe(requestKey("7"));
  expect(responseFor("request-1", { acknowledged: true })).toEqual({
    jsonrpc: "2.0",
    id: "request-1",
    result: { acknowledged: true },
  });
  expect(classifyRouteError(invalidParams("bad model"))).toEqual({
    code: -32602,
    message: "bad model",
  });
});

it("fingerprints method and canonical params so reused IDs cannot alias different work", () => {
  const first = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":7,"method":"zer0/room/models","params":{"agent":"codex","sessionId":"room"}}',
  );
  const reordered = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":7,"method":"zer0/room/models","params":{"sessionId":"room","agent":"codex"}}',
  );
  const different = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":7,"method":"zer0/room/models","params":{"sessionId":"room","agent":"claude"}}',
  );
  expect(requestFingerprint(first)).toBe(requestFingerprint(reordered));
  expect(requestFingerprint(first)).not.toBe(requestFingerprint(different));
});
