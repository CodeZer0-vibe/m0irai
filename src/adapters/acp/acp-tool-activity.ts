/**
 * @file src/adapters/acp/acp-tool-activity.ts
 * @purpose Normalize provider ACP tool updates for room activity events.
 * @exports AcpToolActivity, normalizeAcpToolActivity
 * @depends no imports
 */
export interface AcpToolActivity {
  readonly update: "tool_call" | "tool_call_update";
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

/** Keeps only provider-reported ACP tool-call metadata safe for live room activity. */
export function normalizeAcpToolActivity(update: unknown): AcpToolActivity | undefined {
  if (!isRecord(update)) return undefined;
  const updateKind = update.sessionUpdate;
  if (updateKind !== "tool_call" && updateKind !== "tool_call_update") return undefined;
  const toolCallId = nonemptyString(update.toolCallId);
  if (toolCallId === undefined) return undefined;
  return {
    update: updateKind,
    toolCallId,
    ...optionalField("title", update.title),
    ...optionalField("kind", update.kind),
    ...optionalField("status", update.status),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalField<Key extends "title" | "kind" | "status">(
  key: Key,
  value: unknown,
): Partial<Pick<AcpToolActivity, Key>> {
  const normalized = nonemptyString(value);
  return normalized === undefined ? {} : ({ [key]: normalized } as Pick<AcpToolActivity, Key>);
}
