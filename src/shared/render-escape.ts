/**
 * @file src/shared/render-escape.ts
 * @purpose The INV-13 byte-neutralization primitive: `escapeUntrusted` collapses every unsafe codepoint of an
 *   untrusted agent value (C0/DEL/C1 control bytes, bidi overrides, zero-width/invisible chars) to a visible
 *   literal, is TOTAL over unknown (never throws) and BOUNDED (source capped before escaping). Moved from
 *   the tower's render-escape module (plan v5 Phase 3.1 seam): the room host, permission asks, headless turns
 *   and room-mode all depend on it; the tower's chrome constants left with the tower (m0irai 3.6).
 * @exports EscapeOptions, escapeUntrusted
 * @depends (none)
 */

// Per-field cap on the SOURCE length BEFORE escaping (B4 DoS): a 20MB payload is sliced here so the
// per-char escape loop is bounded — the card can never freeze or push the decision keys off-screen.
const MAX_AGENT_FIELD_LEN = 2048;
// Total fallback when an `unknown` payload cannot be coerced without throwing (B3): escapeUntrusted is
// TOTAL — it returns this constant rather than ever propagating a throw past the trust boundary.
const UNRENDERABLE = "[unrenderable payload]";
// The visible literal each control byte collapses to. ESC, BS, TAB, LF, CR get a readable mnemonic;
// every other control byte (incl DEL + C1) collapses to `\xNN` — never a raw terminal-active byte.
const NAMED_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x1b, "\\x1b"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0d, "\\r"],
]);
// Invisible / reordering Unicode FORMAT chars — all > 0x9f, so the C0/DEL/C1 guard misses them. These
// are the Trojan-Source (bidi override, B1) + hidden-byte (zero-width, B2) vectors: each is escaped to
// a visible `\u####` literal so the operator SEES it and cannot be misled by reordered/hidden text.
const SPOOFING_FORMAT_CHARS: ReadonlySet<number> = new Set([
  // B1 bidi / directional: LRE,RLE,PDF,LRO,RLO + LRI,RLI,FSI,PDI + LRM,RLM + ALM.
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
  // B2 zero-width / invisible: ZWSP,ZWNJ,ZWJ + word-joiner + BOM/ZWNBSP.
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
]);

/** Options for {@link escapeUntrusted}. */
export interface EscapeOptions {
  /**
   * CHAT context only: keep LF (0x0a) + TAB (0x09) as real characters (so a multi-line answer renders as
   * line breaks, not literal `\n`), and DROP lone CR (0x0d) so CRLF→LF (no cursor-return overwrite). Every
   * other control byte + bidi/zero-width is STILL neutralized. The approval-card chrome leaves this off, so
   * an agent newline still can't forge a column-0 chrome line — the security boundary is unchanged there.
   */
  readonly preserveWhitespace?: boolean;
  /** Per-field source cap before escaping (default {@link MAX_AGENT_FIELD_LEN}); chat passes a larger bound. */
  readonly maxLen?: number;
}

/**
 * Neutralizes every UNSAFE codepoint in an untrusted agent value so it can NEVER emit raw terminal
 * control, forge chrome, REORDER text (bidi), HIDE bytes (zero-width), or freeze the card (DoS) — the
 * full INV-13 boundary. Decision is by CODEPOINT, not sequence shape: C0 (0x00–0x1f), DEL (0x7f), 8-bit
 * C1 (0x80–0x9f) → `\xNN`; bidi/zero-width format chars (B1/B2) → visible `\u####`. TOTAL (B3): any
 * `unknown` (incl a payload whose toJSON/toString throws, or a symbol) yields a safe string, NEVER a
 * throw. BOUNDED (B4): the SOURCE is capped BEFORE escaping. With `preserveWhitespace`, LF + TAB survive
 * (CHAT readability) while every dangerous byte is still escaped.
 *
 * @param value - the untrusted agent-supplied value (string or any `unknown` payload)
 * @param opts - optional whitespace-preservation + source cap (defaults: strict, {@link MAX_AGENT_FIELD_LEN})
 * @returns a render-safe, length-bounded string
 */
export function escapeUntrusted(value: unknown, opts?: EscapeOptions): string {
  const preserve = opts?.preserveWhitespace === true;
  const { text, truncatedBytes } = capSource(
    coerceToString(value),
    opts?.maxLen ?? MAX_AGENT_FIELD_LEN,
  );
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += escapeCodepoint(code, ch, preserve);
  }
  return truncatedBytes === 0 ? out : `${out}…(${String(truncatedBytes)} bytes truncated)`;
}

// Slices the source to the per-field cap (B4) and reports how many source chars were dropped, so a huge
// payload is bounded BEFORE the O(n) escape loop runs — the DoS fix must measure/slice the SOURCE.
function capSource(source: string, maxLen: number): { text: string; truncatedBytes: number } {
  if (source.length <= maxLen) return { text: source, truncatedBytes: 0 };
  return {
    text: source.slice(0, maxLen),
    truncatedBytes: source.length - maxLen,
  };
}

// One codepoint → its render-safe form. With preserve (chat), LF + TAB pass verbatim (real formatting) and
// a lone CR is dropped (CRLF→LF, no overwrite); otherwise a control byte (C0/DEL/C1) → mnemonic/`\xNN`, a
// bidi or zero-width format char (B1/B2) → visible `\u####`, else the char verbatim.
function escapeCodepoint(code: number, ch: string, preserve: boolean): string {
  if (preserve && (code === 0x0a || code === 0x09)) return ch;
  if (preserve && code === 0x0d) return "";
  if (isControl(code)) return escapeControl(code);
  if (SPOOFING_FORMAT_CHARS.has(code)) return `\\u${code.toString(16).padStart(4, "0")}`;
  return ch;
}

// A control codepoint is C0 (0x00–0x1f), DEL (0x7f), or C1 (0x80–0x9f) — the full terminal-active set.
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// A named mnemonic when one exists, else a fixed-width `\xNN` hex literal (always 2+ printable chars).
function escapeControl(code: number): string {
  const named = NAMED_ESCAPES.get(code);
  if (named !== undefined) return named;
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

// Stringifies any `unknown` payload TOTALLY (B3): a string is itself; null/undefined are named; every
// other value is coerced inside a try/catch so a throwing toJSON / Symbol.toStringTag / String(symbol)
// yields {@link UNRENDERABLE} instead of crashing render before the operator can DENY. The result still
// flows through the per-char escape above, so even a stringified object's hostile bytes are neutralized.
function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    if (typeof value === "object") {
      return JSON.stringify(value) ?? UNRENDERABLE;
    }
    return String(value);
  } catch {
    return UNRENDERABLE;
  }
}

/**
 * The tower's decision-chrome mark — a tower-owned ASCII sentinel emitted ONLY at COLUMN 0 (a line
 * start) by {@link towerChrome}. Unspoofability is STRUCTURAL, not glyph-secrecy: every agent segment
 * is escaped (printable-only) AND rendered INDENTED + single-line (agent newlines are escaped, so an
 * agent string can never begin a new line), so an agent that types this exact sentinel mid-text yields
 * a literal that is never at column 0 — it can never occupy a chrome line. The leading glyph also
 * carries inverse+bold under color so it is additionally distinct on a real TTY.
 */
