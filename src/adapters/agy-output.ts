/**
 * @file src/adapters/agy-output.ts
 * @exports parseAgyOutput, withExitCode, isAgyPermissionDenial, stripAgyTerminalSequences, normalizeAgyDiagnostic
 * @depends zod, ../shared/errors, ../shared/types
 * @purpose Pure output parsing for the Antigravity CLI (agy) dispatch: strip ANSI (CSI + OSC), extract
 *   fenced-or-bare JSON, and normalize raw stdout to an AgentResult. Split out of agy.ts so the dispatch
 *   orchestrator stays under the file-size ceiling and the parsing path is independently testable.
 *   VESTIGE SWEEP S2 (2026-07-17): agy's headless/--print permission denial is a CONTENT-shaped failure,
 *   not a process-exit-shaped one — a fresh install with no permissions.allow grant hits its "auto-denied"
 *   boilerplate on stderr (merged into stdout under the real ConPTY transport) while the agy PROCESS ITSELF
 *   exits 0 (live-captured 2026-07-17, F1-adjacent). isAgyPermissionDenial is the seam the dispatcher
 *   (agy.ts) consults to convert that content into a thrown DispatchError instead of a "successful" reply.
 */
import { z } from "zod";
import { MalformedAgentOutputError } from "../shared/errors.js";
import type { AgentName, AgentResult } from "../shared/types.js";

const AGENT_NAME: AgentName = "gemini";
const SUCCESS_EXIT_CODE = 0;
const AGY_OUTPUT_PREVIEW_LENGTH = 2_000;
const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/u;
// ESC/BEL built via fromCharCode so no control char appears in a regex literal (biome safe).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

const StructuredOutputSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());
const AgentResultBaseSchema = z
  .object({
    exitCode: z.number().int(),
    files: z.array(z.object({ content: z.string(), path: z.string() }).strict()).optional(),
    stdout: z.string(),
    structured: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Parses raw agy stdout into an AgentResult: ANSI-stripped text, plus structured data when the output
 * is (or contains) JSON. `requireStructured` makes non-JSON / malformed-JSON a hard MalformedAgentOutputError
 * instead of a silent text fallback.
 *
 * @param raw - the raw stdout collected from the agy ConPTY turn
 * @param requireStructured - when true, throw if no valid JSON object is present
 * @returns the normalized agent result (exitCode defaults to success; the caller overlays the real code)
 */
export function parseAgyOutput(raw: string, requireStructured = false): AgentResult {
  const clean = stripAgyTerminalSequences(raw);
  const structured = parseStructuredOutput(clean, requireStructured);
  return toAgentResult(
    AgentResultBaseSchema.parse({
      exitCode: SUCCESS_EXIT_CODE,
      stdout: selectStdout(clean, structured),
      ...(structured !== undefined ? { structured } : {}),
    }),
  );
}

/** Overlays the real process exit code onto a parsed result (parse defaults to the success code). */
export function withExitCode(result: AgentResult, exitCode: number): AgentResult {
  return { ...result, exitCode };
}

// Fragments of agy's own live-captured headless denial boilerplate (verified 2026-07-17 against a
// fresh, ungranted install): 'jetski: no output produced — a tool required the "write_file" permission
// that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow
// in settings.json (e.g. write_file(<target>)). Alternatively, re-run with --dangerously-skip-permissions
// to auto-approve all tools.' DENIAL_PREFIX is "jetski" — agy's own internal tool-execution component
// name, never natural coding-assistant prose — the distinctive SHAPE that anchors this to agy's own
// denial message specifically, not any reply that happens to discuss permissions.
const DENIAL_PREFIX = "jetski: no output produced";
const DENIAL_CLAIM = "was auto-denied";
const DENIAL_REMEDY = "permissions.allow";

/**
 * True when raw agy output IS (from its own first character, after trimming ConPTY whitespace noise)
 * agy's own headless permission-denial boilerplate. The agy PROCESS exits 0 for this case (confirmed
 * live), so exit-code classification alone cannot catch it — this is the content-based check the
 * dispatcher must run before treating a reply as a successful turn.
 *
 * S-A (FIX WAVE Round A, 2026-07-18 = sweep#1): anchored to the reply's own START, not an unanchored
 * substring search across the whole reply — the prior check (`raw.includes(DENIAL_CLAIM) &&
 * raw.includes(DENIAL_REMEDY)`) matched anywhere, so a LEGITIMATE reply that quotes or paraphrases both
 * fragments (e.g. the operator asks gemini to explain agy's permission error) would false-positive into
 * a thrown DispatchError, discarding a genuinely helpful answer. A real coding reply never legitimately
 * STARTS with "jetski: no output produced" — only agy's own denial message does.
 *
 * @param raw - the raw (pre- or post-ANSI-strip; the marker text carries no ANSI) agy output
 * @returns true when the reply's own start IS the denial shape (prefix + both content fragments)
 */
export function isAgyPermissionDenial(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith(DENIAL_PREFIX) &&
    trimmed.includes(DENIAL_CLAIM) &&
    trimmed.includes(DENIAL_REMEDY)
  );
}

/** Removes complete CSI and OSC terminal-control sequences from captured agy output. */
export function stripAgyTerminalSequences(raw: string): string {
  return raw.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}

/** Produces a single-line, inert diagnostic suitable for user-visible failure text. */
export function normalizeAgyDiagnostic(raw: string): string {
  let printable = "";
  for (const character of stripAgyTerminalSequences(raw)) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  return printable.replace(/\s+/gu, " ").trim();
}

function parseStructuredOutput(
  raw: string,
  requireStructured: boolean,
): Record<string, unknown> | undefined {
  const jsonText = extractJsonText(raw);
  if (jsonText === undefined) {
    if (requireStructured) {
      throw malformedOutput("Antigravity CLI emitted non-JSON output", raw);
    }
    return undefined;
  }
  try {
    return StructuredOutputSchema.parse(JSON.parse(jsonText));
  } catch (error) {
    if (requireStructured) {
      throw malformedOutput("Antigravity CLI emitted malformed JSON output", raw, error);
    }
    return undefined;
  }
}

function extractJsonText(raw: string): string | undefined {
  const fenced = FENCED_JSON_PATTERN.exec(raw);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  const trimmed = raw.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : undefined;
}

function selectStdout(raw: string, structured: Record<string, unknown> | undefined): string {
  return typeof structured?.stdout === "string" ? structured.stdout : raw.trim();
}

function toAgentResult(value: z.infer<typeof AgentResultBaseSchema>): AgentResult {
  return {
    exitCode: value.exitCode,
    stdout: value.stdout,
    ...(value.files !== undefined ? { files: value.files } : {}),
    ...(value.structured !== undefined ? { structured: value.structured } : {}),
  };
}

function malformedOutput(message: string, raw: string, cause?: unknown): MalformedAgentOutputError {
  return new MalformedAgentOutputError(
    message,
    AGENT_NAME,
    raw.slice(0, AGY_OUTPUT_PREVIEW_LENGTH),
    {
      cause,
    },
  );
}
