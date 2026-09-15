/**
 * @file src/adapters/acp/acp-stream-utf8.test.ts
 * @purpose F4 (FIX-3) PROVING TEST: the earliest zer0-reachable byte->text boundary on the claude lane
 *   is the SDK's ndJsonStream (acp-lane-connection.ts:91, acp-turn-session.ts:302). It line-buffers raw
 *   stdout bytes (line-buffer.js) and decodes each COMPLETE newline-terminated line at once
 *   (stream.js textDecoder.decode). This asserts that a multi-byte UTF-8 glyph carried inside an ACP
 *   agent_message_chunk survives being split across read chunks at EVERY possible byte offset — exact
 *   code-point preservation, NO U+FFFD replacement character — so mojibake cannot be introduced at this
 *   boundary. The referee's binding correction: if this boundary is green, do NOT patch it; downstream
 *   scrubbing is forbidden. Field evidence (chat-1784553379589 trace, 10,914 agent.stdout events) shows
 *   ZERO U+FFFD and intact em-dashes, consistent with a clean boundary.
 * @exports (none — test file)
 * @depends vitest, node:stream, @agentclientprotocol/sdk
 */
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

const REPLACEMENT = "�";

// Multi-byte glyphs that actually appeared (or plausibly appear) in claude's stream: em-dash (U+2014,
// the exact glyph the field trace carried at turn 25 "connecting —"), right-arrow (U+2192, 3 bytes),
// a 4-byte emoji (U+1F525), and a CJK ideograph (U+4E2D). Each exercises a 2/3/4-byte UTF-8 sequence.
const GLYPH_TEXT = "connecting — status → done 🔥 中 ok";

// Builds one ACP session/update notification carrying `text` as an agent_message_chunk, exactly the
// envelope the live claude bridge writes on stdout (parsed by ndJsonStream into a plain object).
function updateLine(text: string): Uint8Array {
  const message = {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

// Feeds `chunks` (raw byte pieces) through the SAME ndJsonStream construction the adapter uses and
// returns every parsed message object. A silent /dev/null writable stands in for stdin (unused here).
async function decodeChunks(chunks: readonly Uint8Array[]): Promise<unknown[]> {
  const input = Readable.from(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  );
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const stream = ndJsonStream(Writable.toWeb(sink), Readable.toWeb(input));
  const messages: unknown[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    messages.push(value);
  }
  return messages;
}

function textOf(message: unknown): string | undefined {
  const update = (message as { params?: { update?: { content?: { text?: unknown } } } })?.params
    ?.update?.content?.text;
  return typeof update === "string" ? update : undefined;
}

describe("F4: ndJsonStream preserves multi-byte UTF-8 across every read-chunk split", () => {
  it("decodes the glyph line intact when delivered as one whole chunk (baseline)", async () => {
    const messages = await decodeChunks([updateLine(GLYPH_TEXT)]);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toBe(GLYPH_TEXT);
    expect(textOf(messages[0])).not.toContain(REPLACEMENT);
  });

  it("preserves the exact code points with the byte stream split at EVERY offset — no U+FFFD", async () => {
    const line = updateLine(GLYPH_TEXT);
    const failures: string[] = [];
    // Split at every interior byte boundary, including boundaries that fall INSIDE the multi-byte
    // glyphs (the exact condition that produces mojibake if the decoder ran per-chunk instead of
    // per-complete-line). A single decode is buggy if it drops the message, corrupts the text, or
    // introduces a replacement character.
    for (let k = 1; k < line.byteLength; k++) {
      const messages = await decodeChunks([line.subarray(0, k), line.subarray(k)]);
      const text = messages.length === 1 ? textOf(messages[0]) : undefined;
      if (text !== GLYPH_TEXT || (text?.includes(REPLACEMENT) ?? false)) {
        failures.push(`split@${String(k)}: ${JSON.stringify(text)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("preserves the glyphs when EACH byte arrives as its own chunk (worst-case fragmentation)", async () => {
    const line = updateLine(GLYPH_TEXT);
    const perByte = Array.from(line, (b) => Uint8Array.of(b));
    const messages = await decodeChunks(perByte);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toBe(GLYPH_TEXT);
    expect(textOf(messages[0])).not.toContain(REPLACEMENT);
  });

  // FALSIFIER / negative control (RED-before-GREEN proof of teeth): the mojibake the referee hypothesized
  // is REAL when a boundary decodes each read-chunk independently instead of buffering to a complete line.
  // A naive per-chunk `TextDecoder().decode(chunk)` (no `{stream:true}`, no line buffer) splitting the
  // em-dash's 3 bytes (E2 80 94) across two chunks DOES emit U+FFFD. This proves (a) the corruption
  // mechanism exists, and (b) the assertions above would catch it — they are not tautological. ndJsonStream
  // is correct precisely BECAUSE it does the opposite: line-buffer the bytes, then decode the whole line.
  it("NEGATIVE CONTROL: naive per-chunk decode DOES corrupt the split glyph (proves the test bites)", () => {
    const emDashBytes = new TextEncoder().encode("a—b"); // 61 E2 80 94 62
    const splitInsideGlyph = 2; // after 'a' and the first glyph byte (E2) — mid-codepoint
    const naive =
      new TextDecoder().decode(emDashBytes.subarray(0, splitInsideGlyph)) +
      new TextDecoder().decode(emDashBytes.subarray(splitInsideGlyph));
    expect(naive).toContain(REPLACEMENT); // the bug the real boundary AVOIDS
    expect(naive).not.toBe("a—b");
  });
});
