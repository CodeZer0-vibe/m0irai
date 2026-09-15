/**
 * @file src/chat/agy-statusline-payload.ts
 * @purpose Read agy's untrusted statusLine payload and normalize it to AgentStatusUsage. The carrier
 *   reader additionally classifies missing/stale/malformed payloads and rejects mismatched lane cwd/session.
 * @exports AgyUsageRead, readAgyStatusUsage, readAgyStatusUsageWhenFresh, readAgyStatusUsageWhenFreshForLane
 * @depends node:fs/promises, zod, ./statusline-payload
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { AgentStatusUsage } from "./statusline-payload.js";

export type AgyUsageRead =
  | { readonly outcome: "arrived"; readonly usage: AgentStatusUsage }
  | { readonly outcome: "missing" | "stale" | "malformed" };

const QuotaWindowSchema = z
  .object({ remaining_fraction: z.number().optional(), reset_time: z.string().optional() })
  .optional();
const PayloadSchema = z.object({
  context_window: z
    .object({
      used_percentage: z.number().nullable().optional(),
      remaining_percentage: z.number().nullable().optional(),
    })
    .optional(),
  cwd: z.string().optional(),
  quota: z
    .object({ "gemini-5h": QuotaWindowSchema, "gemini-weekly": QuotaWindowSchema })
    .optional(),
  session_id: z.string().optional(),
});
type ParsedPayload = z.infer<typeof PayloadSchema>;
const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export async function readAgyStatusUsage(
  payloadPath: string,
  minMtimeMs?: number,
): Promise<AgentStatusUsage | undefined> {
  const read = await readAgyStatusUsageOnce(payloadPath, minMtimeMs);
  return read.outcome === "arrived" ? read.usage : undefined;
}

/** @public Retained generic polling reader for callers that do not have a carrier lane identity. */
export async function readAgyStatusUsageWhenFresh(
  payloadPath: string,
  minMtimeMs: number,
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AgentStatusUsage | undefined> {
  const read = await pollAgyStatus(payloadPath, minMtimeMs, {}, opts);
  return read.outcome === "arrived" ? read.usage : undefined;
}

export async function readAgyStatusUsageWhenFreshForLane(
  payloadPath: string,
  minMtimeMs: number,
  guard: { readonly cwd: string; readonly sessionId?: string },
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AgyUsageRead> {
  return pollAgyStatus(payloadPath, minMtimeMs, guard, opts);
}

async function pollAgyStatus(
  payloadPath: string,
  minMtimeMs: number,
  guard: { readonly cwd?: string; readonly sessionId?: string },
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<AgyUsageRead> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const intervalMs = opts.intervalMs ?? 250;
  for (;;) {
    if (opts.signal?.aborted === true) return { outcome: "missing" };
    const read = await readAgyStatusUsageOnce(payloadPath, minMtimeMs, guard);
    if (read.outcome !== "missing" || Date.now() >= deadline) return read;
    await abortableDelay(intervalMs, opts.signal);
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function readAgyStatusUsageOnce(
  payloadPath: string,
  minMtimeMs?: number,
  guard: { readonly cwd?: string; readonly sessionId?: string } = {},
): Promise<AgyUsageRead> {
  let parsed: ParsedPayload;
  try {
    if (minMtimeMs !== undefined && (await stat(payloadPath)).mtimeMs < minMtimeMs)
      return { outcome: "missing" };
    parsed = PayloadSchema.parse(JSON.parse(await readFile(payloadPath, "utf8")));
  } catch (error) {
    return missingOrMalformed(error);
  }
  if (!matchesLaneGuard(parsed, guard)) return { outcome: "stale" };
  const usage = usageFromParsed(parsed);
  return usage === undefined ? { outcome: "malformed" } : { outcome: "arrived", usage };
}

function usageFromParsed(parsed: ParsedPayload): AgentStatusUsage | undefined {
  const ctx = contextUsed(parsed.context_window);
  const fiveHour = parsed.quota?.["gemini-5h"];
  const weekly = parsed.quota?.["gemini-weekly"];
  const usage = usageFromQuota([fiveHour?.remaining_fraction, weekly?.remaining_fraction]);
  if (usage === undefined)
    return ctx === undefined ? undefined : { label: "ctx", exhausted: false, contextUsedPct: ctx };
  return {
    ...usage,
    ...(ctx !== undefined ? { contextUsedPct: ctx } : {}),
    ...fiveHourFields(fiveHour),
    ...weeklyFields(weekly),
  };
}

function contextUsed(cw: ParsedPayload["context_window"]): number | undefined {
  if (typeof cw?.used_percentage === "number") return clampPct(cw.used_percentage);
  if (typeof cw?.remaining_percentage === "number") return clampPct(100 - cw.remaining_percentage);
  return undefined;
}

function usageFromQuota(
  fractions: ReadonlyArray<number | undefined>,
): { label: string; exhausted: boolean } | undefined {
  const remaining = fractions.filter(isValidFraction);
  if (remaining.length === 0) return undefined;
  const minRemaining = Math.min(...remaining);
  return { label: `${clampPct((1 - minRemaining) * 100)}%`, exhausted: minRemaining <= 0 };
}

function quotaWindowUsed(w: z.infer<typeof QuotaWindowSchema>): {
  usedPct?: number;
  resetsAtMs?: number;
} {
  const frac = w?.remaining_fraction;
  const resetMs = typeof w?.reset_time === "string" ? Date.parse(w.reset_time) : Number.NaN;
  return {
    ...(isValidFraction(frac) ? { usedPct: clampPct((1 - frac) * 100) } : {}),
    ...(Number.isNaN(resetMs) ? {} : { resetsAtMs: resetMs }),
  };
}

function fiveHourFields(w: z.infer<typeof QuotaWindowSchema>): {
  fiveHourUsedPct?: number;
  fiveHourResetsAtMs?: number;
} {
  const u = quotaWindowUsed(w);
  return {
    ...(u.usedPct !== undefined ? { fiveHourUsedPct: u.usedPct } : {}),
    ...(u.resetsAtMs !== undefined ? { fiveHourResetsAtMs: u.resetsAtMs } : {}),
  };
}

function weeklyFields(w: z.infer<typeof QuotaWindowSchema>): {
  weeklyUsedPct?: number;
  weeklyResetsAtMs?: number;
} {
  const u = quotaWindowUsed(w);
  return {
    ...(u.usedPct !== undefined ? { weeklyUsedPct: u.usedPct } : {}),
    ...(u.resetsAtMs !== undefined ? { weeklyResetsAtMs: u.resetsAtMs } : {}),
  };
}

function matchesLaneGuard(
  parsed: ParsedPayload,
  guard: { readonly cwd?: string; readonly sessionId?: string },
): boolean {
  if (guard.cwd !== undefined && parsed.cwd !== guard.cwd) return false;
  if (guard.sessionId !== undefined && parsed.session_id !== guard.sessionId) return false;
  return true;
}

function isValidFraction(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

function missingOrMalformed(error: unknown): AgyUsageRead {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" ? { outcome: "missing" } : { outcome: "malformed" };
}
