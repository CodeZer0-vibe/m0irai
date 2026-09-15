/**
 * @file src/room/room-protocol.ts
 * @purpose Validate and frame strict zer0.room v1 JSON-RPC wire messages.
 * @exports MAX_FRAME_BYTES, MAX_CHUNK_TEXT_UTF8_BYTES, JsonRpcId, JsonRpcRequest, decodeWireFrame, encodeWireFrame, parseJsonRpcRequestFrame, validateJsonRpcServerFrame, validateJsonRpcRequest, validateRoomEvent, validId, isSafeRoomWireText
 * @depends (none)
 */
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_CHUNK_TEXT_UTF8_BYTES = 32_768;
const MAX_ROOM_MODE_ID_LENGTH = 128;
const MAX_ROOM_MODE_ERROR_LENGTH = 240;
const MAX_ROOM_MODE_CATALOG_ITEMS = 32;
const MAX_ROOM_HOP_ID_LENGTH = 256;
const MAX_ROOM_HOP_TEXT_LENGTH = 2_048;
const MAX_PERMISSION_ID_LENGTH = 4096;
const MAX_PERMISSION_OPTIONS = 9;
const MAX_ROOM_NOTICE_CAUSE_BYTES = 64;
// CODE POINTS: the one unit JSON Schema maxLength, JS string iteration and Rust chars() all agree on.
const MAX_ROOM_NOTICE_DETAIL_CODE_POINTS = 200;

export type JsonRpcId = string | number;
export type JsonRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}>;

export function decodeWireFrame(raw: Uint8Array): unknown {
  if (raw.length === 0 || raw.length > MAX_FRAME_BYTES || raw.at(-1) !== 0x0a)
    throw new Error("wire frame must be one LF-terminated JSON value within 1 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, -1));
  } catch {
    throw new Error("wire frame is not strict UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("wire frame is not JSON");
  }
}

export function encodeWireFrame(value: unknown): string {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES)
    throw new Error("wire frame exceeds 1 MiB including LF");
  return frame;
}

export function parseJsonRpcRequestFrame(raw: Uint8Array): JsonRpcRequest {
  return validateJsonRpcRequest(decodeWireFrame(raw));
}
export function validateJsonRpcServerFrame(value: unknown): void {
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC server frame");
  if ("method" in value) {
    if (
      !hasExactKeys(value, ["jsonrpc", "method", "params"]) ||
      value.method !== "zer0/room/event" ||
      !isRecord(value.params)
    )
      throw new Error("invalid JSON-RPC notification");
    validateRoomEvent(value.params as RoomEventLike);
    return;
  }
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (
    hasResult === hasError ||
    !hasExactKeys(value, hasResult ? ["jsonrpc", "id", "result"] : ["jsonrpc", "id", "error"]) ||
    (value.id !== null && !validId(value.id)) ||
    (hasError && !validJsonRpcError(value.error))
  )
    throw new Error("invalid JSON-RPC response");
}
export function validateJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["jsonrpc", "id", "method", "params"]) ||
    value.jsonrpc !== "2.0" ||
    !validId(value.id) ||
    typeof value.method !== "string" ||
    !isRecord(value.params)
  )
    throw new Error("invalid JSON-RPC request");
  return { jsonrpc: "2.0", id: value.id, method: value.method, params: value.params };
}
type RoomEventLike = Readonly<{
  protocol: unknown;
  version: unknown;
  sessionId: unknown;
  eventSeq: unknown;
  eventId: unknown;
  turnId: unknown;
  occurredAt: unknown;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}>;
// biome-ignore format: the wire's type list is DATA, and one-per-line formatting spends 24 lines of
// this file's ceiling on it. Same technique, same reason, as the compact event alias in events.ts.
const EVENT_TYPES = new Set([
  "turn.accepted", "route.resolved", "lane.queued", "lane.started", "lane.activity", "lane.chunk",
  "lane.cancelling", "lane.completed", "lane.failed", "lane.cancelled", "agent.status", "agent.mode",
  "message.committed", "turn.completed", "room.paused", "room.resumed", "permission.requested",
  "permission.resolved", "hop.dispatched", "hop.blocked", "session.saved", "backend.failed",
  "room.notice",
]);

export function validateRoomEvent(event: RoomEventLike): void {
  validateEventEnvelope(event);
  const p = event.payload;
  if (event.type === "lane.started") validateLaneStartedPayload(p);
  if (event.type === "lane.chunk") validateChunkPayload(p);
  if (event.type === "lane.activity") validateActivityPayload(p);
  if (event.type === "agent.status") validateAgentStatusPayload(p);
  if (event.type === "agent.mode") validateAgentModePayload(p);
  if (event.type === "hop.dispatched" || event.type === "hop.blocked") validateHopPayload(p);
  if (event.type === "permission.requested") validatePermissionRequestedPayload(p);
  if (event.type === "permission.resolved") validatePermissionResolvedPayload(p);
  if (event.type === "room.notice") validateRoomNoticePayload(p);
  if (
    event.type === "backend.failed" &&
    (!Object.keys(p).every((k) => k === "message" || k === "error") ||
      !Object.values(p).every((v) => typeof v === "string" && v.length > 0))
  )
    throw new Error("invalid backend.failed payload");
}

/** `cause` is a bounded safe STRING, not the closed enum the host mints from, so an older terminal
 *  can still render a newer host's notice; see src/shared/room-notice.ts. The byte argument below is
 *  the worst-case UTF-8 encoding of the code-point bound, and only bounds the safety scan. */
function validateRoomNoticePayload(payload: Readonly<Record<string, unknown>>): void {
  const detail = payload.detail;
  if (
    !hasOnlyKeys(payload, ["cause", "agent", "detail"]) ||
    !safeBoundedString(payload.cause, MAX_ROOM_NOTICE_CAUSE_BYTES) ||
    (payload.agent !== undefined && !validAgent(payload.agent)) ||
    !isSafeRoomWireText(detail, MAX_ROOM_NOTICE_DETAIL_CODE_POINTS * 4) ||
    [...detail].length > MAX_ROOM_NOTICE_DETAIL_CODE_POINTS
  )
    throw new Error("invalid room.notice payload");
}

function validatePermissionRequestedPayload(payload: Readonly<Record<string, unknown>>): void {
  if (
    !hasOnlyKeys(payload, ["agent", "askId", "toolTitle", "options"]) ||
    !validAgent(payload.agent) ||
    !validPermissionId(payload.askId) ||
    (payload.toolTitle !== undefined && !safeBoundedString(payload.toolTitle, 240)) ||
    (payload.options !== undefined &&
      (!Array.isArray(payload.options) || payload.options.length > MAX_PERMISSION_OPTIONS))
  )
    throw new Error("invalid permission.requested payload");
  const ids = new Set<string>();
  for (const option of payload.options ?? []) {
    if (
      !isRecord(option) ||
      !hasOnlyKeys(option, ["optionId", "kind", "name"]) ||
      !validPermissionId(option.optionId) ||
      (option.kind !== undefined && !safeBoundedString(option.kind, 120)) ||
      (option.name !== undefined && !safeBoundedString(option.name, 120)) ||
      ids.has(option.optionId)
    )
      throw new Error("invalid permission.requested option");
    ids.add(option.optionId);
  }
}

function validatePermissionResolvedPayload(payload: Readonly<Record<string, unknown>>): void {
  if (
    !hasOnlyKeys(payload, ["agent", "askId", "outcome", "optionId"]) ||
    !validAgent(payload.agent) ||
    !validPermissionId(payload.askId) ||
    (payload.outcome !== "approved" &&
      payload.outcome !== "denied" &&
      payload.outcome !== "timeout" &&
      payload.outcome !== "invalidated") ||
    (payload.optionId !== undefined && !validPermissionId(payload.optionId))
  )
    throw new Error("invalid permission.resolved payload");
}

function validateAgentModePayload(payload: Readonly<Record<string, unknown>>): void {
  if (!hasOnlyKeys(payload, ["agent", "modeId", "word", "status", "error", "availableModeIds"]))
    throw new Error("invalid agent.mode payload");
  if (!validAgent(payload.agent)) throw new Error("invalid agent.mode agent");
  if (!safeBoundedString(payload.modeId, MAX_ROOM_MODE_ID_LENGTH))
    throw new Error("invalid agent.mode modeId");
  if (payload.status !== "active" && payload.status !== "pending" && payload.status !== "failed")
    throw new Error("invalid agent.mode status");
  if (
    payload.word !== undefined &&
    payload.word !== "plan" &&
    payload.word !== "careful" &&
    payload.word !== "edits" &&
    payload.word !== "auto" &&
    payload.word !== "strict" &&
    payload.word !== "smart"
  )
    throw new Error("invalid agent.mode word");
  if (payload.error !== undefined && !safeBoundedString(payload.error, MAX_ROOM_MODE_ERROR_LENGTH))
    throw new Error("invalid agent.mode error");
  if (payload.availableModeIds !== undefined) {
    if (
      !Array.isArray(payload.availableModeIds) ||
      payload.availableModeIds.length > MAX_ROOM_MODE_CATALOG_ITEMS ||
      !payload.availableModeIds.every((modeId) =>
        safeBoundedString(modeId, MAX_ROOM_MODE_ID_LENGTH),
      ) ||
      new Set(payload.availableModeIds).size !== payload.availableModeIds.length
    )
      throw new Error("invalid agent.mode availableModeIds");
  }
}

function validateHopPayload(payload: Readonly<Record<string, unknown>>): void {
  if (
    !hasOnlyKeys(payload, [
      "fromAgent",
      "toAgent",
      "parentMessageId",
      "hopIndex",
      "maxHop",
      "hopBudget",
      "hopId",
      "text",
    ]) ||
    !validAgent(payload.fromAgent) ||
    !validAgent(payload.toAgent) ||
    payload.fromAgent === payload.toAgent ||
    !safeBoundedString(payload.parentMessageId, MAX_ROOM_HOP_ID_LENGTH) ||
    !safeBoundedString(payload.hopId, MAX_ROOM_HOP_ID_LENGTH) ||
    !validPositiveSafeInteger(payload.hopIndex) ||
    Object.hasOwn(payload, "maxHop") === Object.hasOwn(payload, "hopBudget") ||
    !validPositiveSafeInteger(payload.maxHop ?? payload.hopBudget) ||
    (payload.text !== undefined && !safeBoundedString(payload.text, MAX_ROOM_HOP_TEXT_LENGTH))
  )
    throw new Error("invalid hop payload");
}

function validateAgentStatusPayload(payload: Readonly<Record<string, unknown>>): void {
  if (!hasOnlyKeys(payload, ["agent", "auth", "usage", "availability"]))
    throw new Error("invalid agent.status payload");
  if (!validAgent(payload.agent)) throw new Error("invalid agent.status agent");
  if (
    payload.auth === undefined &&
    payload.usage === undefined &&
    payload.availability === undefined
  )
    throw new Error("agent.status requires status data");
  if (
    payload.auth !== undefined &&
    payload.auth !== "ready" &&
    payload.auth !== "limited" &&
    payload.auth !== "down"
  )
    throw new Error("invalid agent.status auth");
  if (payload.usage !== undefined) validateAgentUsage(payload.usage);
  if (payload.availability !== undefined) validateAgentAvailability(payload.availability);
}

function validateAgentUsage(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "exhausted",
      "contextUsedPct",
      "fiveHourUsedPct",
      "fiveHourResetsAtMs",
      "weeklyUsedPct",
      "weeklyResetsAtMs",
    ]) ||
    typeof value.exhausted !== "boolean"
  )
    throw new Error("invalid agent.status usage");
  for (const field of ["contextUsedPct", "fiveHourUsedPct", "weeklyUsedPct"] as const) {
    const number = value[field];
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 100)
    )
      throw new Error("invalid agent.status usage percent");
  }
  for (const field of ["fiveHourResetsAtMs", "weeklyResetsAtMs"] as const) {
    const number = value[field];
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    )
      throw new Error("invalid agent.status reset");
  }
}

function validateAgentAvailability(value: unknown): void {
  if (!isRecord(value) || !hasOnlyKeys(value, ["state", "resetsAtMs"]))
    throw new Error("invalid agent.status availability");
  if (
    value.state !== "ready" &&
    value.state !== "exhausted" &&
    value.state !== "needs_auth" &&
    value.state !== "local_blocked" &&
    value.state !== "retrying"
  )
    throw new Error("invalid agent.status availability state");
  if (
    value.resetsAtMs !== undefined &&
    (typeof value.resetsAtMs !== "number" ||
      !Number.isSafeInteger(value.resetsAtMs) ||
      value.resetsAtMs < 0)
  )
    throw new Error("invalid agent.status availability reset");
}

function validateEventEnvelope(event: RoomEventLike): void {
  if (
    !hasExactKeys(event as Record<string, unknown>, [
      "protocol",
      "version",
      "sessionId",
      "eventSeq",
      "eventId",
      "turnId",
      "occurredAt",
      "type",
      "payload",
    ]) ||
    event.protocol !== "zer0.room" ||
    event.version !== 1 ||
    !EVENT_TYPES.has(event.type) ||
    !isRecord(event.payload)
  )
    throw new Error("invalid room event envelope");
  for (const key of ["sessionId", "eventId", "turnId", "occurredAt"] as const)
    if (typeof event[key] !== "string" || event[key].length === 0)
      throw new Error("invalid room event field");
  if (
    typeof event.eventSeq !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(event.eventSeq) ||
    typeof event.occurredAt !== "string" ||
    !validRfc3339Timestamp(event.occurredAt)
  )
    throw new Error("invalid room event sequence or time");
}
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function validRfc3339Timestamp(value: string): boolean {
  const match = value.match(RFC3339_TIMESTAMP);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function validateLaneStartedPayload(p: Readonly<Record<string, unknown>>): void {
  if (
    typeof p.laneId !== "string" ||
    p.laneId.length === 0 ||
    typeof p.streamId !== "string" ||
    p.streamId.length === 0 ||
    !validAgent(p.agent) ||
    !validOptionalModelId(p)
  )
    throw new Error("invalid lane.started payload");
}

function validateChunkPayload(p: Readonly<Record<string, unknown>>): void {
  if (
    typeof p.laneId !== "string" ||
    p.laneId.length === 0 ||
    typeof p.streamId !== "string" ||
    p.streamId.length === 0 ||
    !validAgent(p.agent) ||
    typeof p.streamSeq !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(p.streamSeq) ||
    typeof p.channel !== "string" ||
    p.channel.length === 0 ||
    typeof p.chunkIndex !== "number" ||
    !Number.isSafeInteger(p.chunkIndex) ||
    p.chunkIndex < 0 ||
    typeof p.text !== "string" ||
    Buffer.byteLength(p.text, "utf8") > MAX_CHUNK_TEXT_UTF8_BYTES ||
    !validOptionalModelId(p)
  )
    throw new Error("invalid lane.chunk payload");
}
function validateActivityPayload(p: Readonly<Record<string, unknown>>): void {
  if (
    typeof p.laneId !== "string" ||
    p.laneId.length === 0 ||
    typeof p.streamId !== "string" ||
    p.streamId.length === 0 ||
    typeof p.toolCallId !== "string" ||
    p.toolCallId.length === 0 ||
    (p.update !== "tool_call" && p.update !== "tool_call_update")
  )
    throw new Error("invalid lane.activity payload");
}
function validAgent(value: unknown): boolean {
  return value === "claude" || value === "codex" || value === "gemini";
}
function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxLength
  );
}
function safeBoundedString(value: unknown, maxLength: number): value is string {
  return isSafeRoomWireText(value, maxLength);
}

export function isSafeRoomWireText(value: unknown, maxLength: number): value is string {
  if (!boundedString(value, maxLength)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isUnsafeRoomWireCodePoint(codePoint)) return false;
  }
  return true;
}

function isUnsafeRoomWireCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}
export function validPermissionId(value: unknown): value is string {
  // IDs are opaque and are never rendered. Preserve them byte-for-byte (including whitespace)
  // while bounding their aggregate wire/memory cost.
  return boundedString(value, MAX_PERMISSION_ID_LENGTH);
}
function validPositiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validOptionalModelId(payload: Readonly<Record<string, unknown>>): boolean {
  return (
    !("modelId" in payload) || (typeof payload.modelId === "string" && payload.modelId.length > 0)
  );
}
export function validId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function validJsonRpcError(value: unknown): boolean {
  return (
    isRecord(value) &&
    (hasExactKeys(value, ["code", "message"]) ||
      hasExactKeys(value, ["code", "message", "data"])) &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
