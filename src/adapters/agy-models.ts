/**
 * @file src/adapters/agy-models.ts
 * @purpose Fetch gemini's LIVE model list for the native model picker. `agy models` prints a "Fetching…"
 *   braille spinner (redrawn via CR) then the model display names, one per line — parseAgyModels turns that
 *   raw terminal stream into a clean ordered list (non-printable + ANSI residue dropped, only "<name>
 *   (<tier>)"-shaped lines kept, de-duped, bounded). fetchAgyModels runs it via an INJECTED runner (the real
 *   ConPTY runner is a separate seam) so this module + its test never load node-pty. Read FRESH each
 *   picker-open — a model agy adds later appears with no restart (NOT a startup snapshot).
 * @exports fetchAgyModels, parseAgyModels
 * @depends ./agy-output
 */
import { stripAgyTerminalSequences } from "./agy-output.js";

const MAX_MODELS = 64; // hard cap so a runaway/garbage stream can't grow the picker unbounded
// A model line is "<words> (<tier>)" — e.g. "Gemini 3.5 Flash (Medium)". Requiring a trailing parenthesised
// tier rejects stray spinner/prose remnants without hard-coding any vendor.
const MODEL_SHAPE = /\(.+\)\s*$/;
// …but an agy ERROR can also be "<text> (<code>)" — "Authentication failed (401)", "No models available
// (offline)". A numeric paren (an error code, not a tier) or an error keyword rejects those, so a failure
// message can never become a selectable model that is then passed to --model.
const NUMERIC_TIER = /\(\s*\d+\s*\)\s*$/;
const ERROR_LINE =
  /\b(fail|error|unavailable|unable|offline|denied|invalid|expired|forbidden|no models|not found|please|retry|timed? ?out)\b/i;
// CSI residue once the ESC byte is gone (printableAscii drops ESC); pattern itself has no control chars.
const CSI_RESIDUE = /\[[0-9;?]*[A-Za-z]/g;

// Keep only printable ASCII — drops ESC, every C0 control byte, AND the braille spinner glyphs (all > 0x7e)
// in one pass, by CODEPOINT (not a control-char regex). Model display names are ASCII, so this preserves them.
function printableAscii(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f) {
      out += ch;
    }
  }
  return out;
}

/**
 * Parses the raw `agy models` terminal output into the ordered list of model display names. Never throws.
 *
 * @param raw - the raw captured stdout of `agy models`
 * @returns the model display names in listed order (the exact strings `--model` accepts)
 */
export function parseAgyModels(raw: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of stripAgyTerminalSequences(raw).split(/[\r\n]+/)) {
    const line = printableAscii(segment)
      .replace(CSI_RESIDUE, "")
      .replace(/Fetching available models\.*/gi, "")
      .trim();
    if (
      line.length === 0 ||
      seen.has(line) ||
      !MODEL_SHAPE.test(line) ||
      NUMERIC_TIER.test(line) ||
      ERROR_LINE.test(line)
    ) {
      continue;
    }
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_MODELS) {
      break;
    }
  }
  return out;
}

/**
 * Fetches gemini's live model list via the injected `run` (the real ConPTY runner in production; a fake in
 * tests). Fail-soft: any runner error yields [] so the picker shows an empty state, never a crash.
 *
 * @param run - returns the raw stdout of `agy models`
 * @returns the parsed model display names ([] on failure)
 */
export async function fetchAgyModels(run: () => Promise<string>): Promise<readonly string[]> {
  try {
    return parseAgyModels(await run());
  } catch {
    return [];
  }
}
