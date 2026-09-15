/**
 * @file src/shared/redact-payload.ts
 * @purpose FIX-3c BLOCK 4 (privacy): structure-only projection of an arbitrary bridge payload before it is
 *   written into a DEBUG ARTIFACT. Debug directories get shared (the operator hands a `.zer0/debug/<chat>/`
 *   to a reviewer), and the claude bridge's background-task notifications carry the operator's actual work
 *   instructions, the model's paraphrase of them, and absolute paths embedding user/project names. The wire
 *   may carry that content — the reply stream already does — but the artifact may not.
 * @exports RedactedString, redactPayload
 * @depends node:crypto
 */
import { createHash } from "node:crypto";

/**
 * THE INVERTED RULE: a string is CONTENT unless its key is on this structural allowlist. A blocklist would
 * leak every future SDK field carrying prose until someone noticed it; this way a new field is redacted by
 * default and someone must deliberately declare it structural. Every entry here is an identifier, an enum,
 * or a protocol discriminant — none can carry operator text.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "type",
  "subtype",
  "task_id",
  "taskId",
  "tool_use_id",
  "toolUseId",
  "session_id",
  "sessionId",
  "uuid",
  "task_type",
  "subagent_type",
  "status",
  "last_tool_name",
  "tool",
  "event",
  "reason",
  "stop_reason",
  "stopReason",
  "role",
  "model",
  "queryId",
  "id",
  "method",
]);

// Caps so a cyclic or pathological payload can never wedge or explode a debug write.
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

/** A content string's stand-in: enough to correlate it across rows, useless for reading it. */
export interface RedactedString {
  readonly redacted: true;
  readonly len: number;
  readonly sha8: string;
}

function sha8(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function redactString(text: string): RedactedString {
  return { redacted: true, len: text.length, sha8: sha8(text) };
}

/**
 * Projects `value` to structure only. Numbers, booleans and null pass through untouched — they cannot
 * carry prose. Strings pass through ONLY under a structural key; every other string becomes {len, sha8},
 * never dropped, so the shape stays diagnosable (a field was present, this long, stable or changed across
 * rows) with none of the text.
 */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (depth >= MAX_DEPTH) {
    return { redacted: true, depthCapped: true };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => redactPayload(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return { redacted: true, valueType: typeof value };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      typeof entry === "string" && STRUCTURAL_KEYS.has(key)
        ? entry
        : redactPayload(entry, depth + 1);
  }
  return out;
}
