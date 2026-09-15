/**
 * @file src/shared/render-escape.test.ts
 * @purpose Per-file unit test of the INV-13 byte-neutralization primitive (moved with it from src/tower): every
 *          unsafe codepoint collapses to a visible literal at the exact class boundaries, ordinary text passes
 *          unchanged, TOTAL over unknown, BOUNDED source, preserveWhitespace semantics. No mocks.
 * @exports (none)
 * @depends vitest, ./render-escape
 */
import { describe, expect, it } from "vitest";
import { escapeUntrusted } from "./render-escape.js";

// Every control byte is built from a charcode so this SOURCE holds ZERO raw control chars (byte-exact,
// formatter-stable). The escaper's contract is decided per-codepoint, so the test is per-codepoint too.
const ch = (code: number): string => String.fromCharCode(code);

// True iff the output still contains a raw terminal-active control byte. TAB/LF/CR are escaped by this
// primitive too (it has no notion of legitimate layout — the renderer owns that), so here they ARE
// treated as control: a passing escaper leaves NONE of the 0x00-0x1f / 0x7f / 0x80-0x9f range raw.
const hasRawControl = (s: string): boolean => {
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

describe("escapeUntrusted — C0 / DEL / C1 control range", () => {
  it("collapses the FULL C0 range 0x00-0x1f to visible literals (no raw byte survives)", () => {
    for (let code = 0x00; code <= 0x1f; code += 1) {
      const out = escapeUntrusted(`a${ch(code)}b`);
      expect(hasRawControl(out)).toBe(false); // FALSIFIER: an off-by-one in isControl leaves 0x1f raw
      expect(out.startsWith("a")).toBe(true);
      expect(out.endsWith("b")).toBe(true);
    }
  });

  it("maps the 5 named control bytes to their mnemonics", () => {
    expect(escapeUntrusted(ch(0x1b))).toBe("\\x1b"); // ESC
    expect(escapeUntrusted(ch(0x08))).toBe("\\b"); // BS
    expect(escapeUntrusted(ch(0x09))).toBe("\\t"); // TAB
    expect(escapeUntrusted(ch(0x0a))).toBe("\\n"); // LF
    expect(escapeUntrusted(ch(0x0d))).toBe("\\r"); // CR
  });

  it("maps an un-named control byte to a fixed-width \\xNN hex literal", () => {
    expect(escapeUntrusted(ch(0x00))).toBe("\\x00"); // NUL
    expect(escapeUntrusted(ch(0x07))).toBe("\\x07"); // BEL
    expect(escapeUntrusted(ch(0x7f))).toBe("\\x7f"); // DEL
  });

  it("collapses the FULL 8-bit C1 range 0x80-0x9f (these are > DEL and easy to miss)", () => {
    for (let code = 0x80; code <= 0x9f; code += 1) {
      const out = escapeUntrusted(ch(code));
      expect(hasRawControl(out)).toBe(false);
      expect(out).toBe(`\\x${code.toString(16).padStart(2, "0")}`);
    }
  });
});

describe("escapeUntrusted — exact class boundaries (the off-by-one trap)", () => {
  it("passes 0x20 SPACE through (just below DEL is the start of printable ASCII)", () => {
    expect(escapeUntrusted(ch(0x20))).toBe(" ");
  });

  it("passes 0x7e ~ through but escapes 0x7f DEL (the printable/DEL seam)", () => {
    expect(escapeUntrusted(ch(0x7e))).toBe("~");
    expect(escapeUntrusted(ch(0x7f))).toBe("\\x7f");
  });

  it("escapes 0x9f (last C1) but passes 0xa0 NBSP through (first non-control above C1)", () => {
    // FALSIFIER: a guard written `code <= 0xa0` (instead of 0x9f) would eat NBSP — this catches it.
    expect(escapeUntrusted(ch(0x9f))).toBe("\\x9f");
    expect(hasRawControl(escapeUntrusted(ch(0xa0)))).toBe(false);
    expect(escapeUntrusted(ch(0xa0))).toBe(ch(0xa0));
  });
});

describe("escapeUntrusted — bidi override neutralization (Trojan Source, B1)", () => {
  it("escapes every bidi/directional override in U+202A-E and U+2066-69 to \\u#### ", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const code of bidi) {
      const out = escapeUntrusted(`x${ch(code)}y`);
      expect(out).not.toContain(ch(code)); // the raw reordering codepoint is GONE
      expect(out).toContain(`\\u${code.toString(16).padStart(4, "0")}`); // surfaced visibly
    }
  });

  it("un-reorders a classic RLO filename attack so the real extension is visible", () => {
    const RLO = ch(0x202e);
    const out = escapeUntrusted(`report${RLO}txt.exe`);
    expect(out).not.toContain(RLO);
    expect(out).toContain("\\u202e");
    expect(out.endsWith("txt.exe")).toBe(true); // operator sees the dangerous .exe, not a fake .txt
  });
});

describe("escapeUntrusted — zero-width / invisible neutralization (B2)", () => {
  it("escapes the zero-width and BOM hidden-byte vectors to visible \\u#### literals", () => {
    expect(escapeUntrusted(ch(0x200b))).toBe("\\u200b"); // ZWSP
    expect(escapeUntrusted(ch(0xfeff))).toBe("\\ufeff"); // BOM / ZWNBSP
    expect(escapeUntrusted(`app${ch(0x200b)}.js`)).toBe("app\\u200b.js"); // hidden boundary revealed
  });
});

describe("escapeUntrusted — ordinary content passes through UNCHANGED", () => {
  it("returns plain ASCII identically (no spurious escaping)", () => {
    expect(escapeUntrusted("rm -rf ./build && echo done")).toBe("rm -rf ./build && echo done");
  });

  it("passes emoji and CJK through verbatim (must not be eaten as 'unsafe')", () => {
    // FALSIFIER: a guard keyed on UTF-16 code UNITS (not codepoints) could mangle astral emoji.
    expect(escapeUntrusted("héllo 世界 🚀✅")).toBe("héllo 世界 🚀✅");
  });
});

describe("escapeUntrusted — TOTAL over unknown (B3, never throws)", () => {
  it("coerces null / undefined / number / object without throwing", () => {
    expect(escapeUntrusted(undefined)).toBe("undefined");
    expect(escapeUntrusted(null)).toBe("null");
    expect(escapeUntrusted(123)).toBe("123");
    expect(escapeUntrusted({ a: 1 })).toBe('{"a":1}');
  });

  it("returns a safe constant when toJSON throws (and still escapes the result's bytes)", () => {
    const hostile = {
      toJSON(): never {
        throw new Error("boom");
      },
    };
    let out = "";
    expect(() => {
      out = escapeUntrusted(hostile);
    }).not.toThrow();
    expect(out).toContain("unrenderable");
    expect(hasRawControl(out)).toBe(false);
  });

  it("does not throw for a symbol payload (String(symbol) itself throws)", () => {
    expect(() => escapeUntrusted(Symbol("s"))).not.toThrow();
  });
});

describe("escapeUntrusted — BOUNDED source (B4 DoS)", () => {
  it("caps a 20MB source and appends an exact truncated-byte marker", () => {
    const out = escapeUntrusted("A".repeat(20_000_000));
    expect(out.length).toBeLessThan(64 * 1024); // bounded, not ~20MB
    // Cap is 2048 source chars; 20_000_000 - 2048 = 19_997_952 dropped.
    expect(out).toContain("(19997952 bytes truncated)");
    expect(out.startsWith("A".repeat(2048))).toBe(true);
  });

  it("does NOT append a truncation marker to an in-bounds source", () => {
    expect(escapeUntrusted("short")).toBe("short");
    expect(escapeUntrusted("short")).not.toContain("truncated");
  });
});

describe("escapeUntrusted — preserveWhitespace (chat readability) keeps LF/TAB, still escapes danger", () => {
  const LF = ch(0x0a);
  const TAB = ch(0x09);
  const CR = ch(0x0d);
  const ESC = ch(0x1b);
  const RLO = ch(0x202e);

  it("renders real newlines + tabs as themselves so a multi-line answer is readable", () => {
    const out = escapeUntrusted(`line1${LF}line2${TAB}col`, { preserveWhitespace: true });
    expect(out).toContain(LF);
    expect(out).toContain(TAB);
    expect(out).toBe(`line1${LF}line2${TAB}col`);
  });

  it("drops a lone CR so CRLF collapses to LF (no cursor-return overwrite)", () => {
    expect(escapeUntrusted(`a${CR}${LF}b`, { preserveWhitespace: true })).toBe(`a${LF}b`);
  });

  it("STILL escapes ESC + bidi even with preserveWhitespace (security boundary unchanged)", () => {
    const out = escapeUntrusted(`x${ESC}[31m${RLO}text`, { preserveWhitespace: true });
    expect(out).toContain("x1b");
    expect(out).toContain("u202e");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(RLO);
  });

  it("the DEFAULT (no opts) still escapes newlines — the approval-card boundary is unchanged", () => {
    const out = escapeUntrusted(`a${LF}b`);
    expect(out).not.toContain(LF);
    expect(out).toContain("n");
  });

  it("honors a custom maxLen cap", () => {
    const out = escapeUntrusted("abcdef", { maxLen: 3 });
    expect(out.startsWith("abc")).toBe(true);
    expect(out).toContain("truncated");
  });
});
