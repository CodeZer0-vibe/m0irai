/**
 * @file src/chat/pty-transcripts.offsets.test.ts
 * @purpose RED-first falsifiers for the W1-T4a session-binding rework (codex brief-gate G1): per-turn
 *          offsets over REAL files — turn 2 must never re-serve turn 1 (live bug A / F2), a binding must
 *          follow native-session ROTATION to a newer file (F2b: rollout rotation), recover from file
 *          TRUNCATION/rewrite without hanging or serving pre-truncation text (F2c), treat offsets as STRING
 *          indices not bytes (F2d), and not lose a marker split across polls (F2e/F2f). Append-only fakes
 *          are insufficient — these replace and truncate real temp files. Contract: resolveBinding(agent,
 *          opts, prev?) + readTurnDelta(binding) from pty-binding. (gemini is not a PtyAgent — agy lane.)
 * @exports (test suite — no runtime exports)
 * @depends vitest, node:fs, node:os, node:path, ./pty-binding
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type SessionBinding, readTurnDelta, resolveBinding } from "./pty-binding.js";

let root: string;
let codexDay: string;
const CWD = "C:/fake/repo";
const SPAWN = Date.now() - 5_000;

function codexLines(message: string): string {
  return (
    `${JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message } })}\n` +
    `${JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "task_complete", last_agent_message: message } })}\n`
  );
}

function touch(file: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(file, t, t);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zer0-bind-"));
  // codex layout: <root>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const d = new Date(SPAWN);
  codexDay = path.join(
    root,
    ".codex",
    "sessions",
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  );
  mkdirSync(codexDay, { recursive: true });
});

function bindCodex(prev?: SessionBinding): SessionBinding {
  return resolveBinding("codex", { cwd: CWD, spawnMs: SPAWN, rootDir: root }, prev);
}

describe("F2 — per-turn offsets: turn 2 never re-serves turn 1 (live bug A)", () => {
  it("codex: second read returns only the new task_complete after the offset", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    writeFileSync(file, codexLines("first"));
    let b = bindCodex();
    const t1 = readTurnDelta(b);
    expect(t1.reply).toBe("first");
    b = t1.binding;

    writeFileSync(file, codexLines("first") + codexLines("second"));
    const t2 = readTurnDelta(b);
    expect(t2.reply).toBe("second");
    expect(t2.reply).not.toContain("first");
  });
});

describe("F2b — rotation: the binding follows a NEWER session file (rollout rotation)", () => {
  it("codex: rollout rotates to a new file; re-resolve binds the newer rollout at offset 0", () => {
    const oldFile = path.join(codexDay, "rollout-a.jsonl");
    writeFileSync(oldFile, codexLines("from old rollout"));
    touch(oldFile, 4_000);
    let b = bindCodex();
    b = readTurnDelta(b).binding;

    const newFile = path.join(codexDay, "rollout-b.jsonl");
    writeFileSync(newFile, codexLines("from new rollout"));
    b = bindCodex(b);
    expect(readTurnDelta(b).reply).toBe("from new rollout");
  });
});

describe("F2c — truncation/rewrite: offset past EOF resets, never hangs, never serves stale text", () => {
  it("codex: file rewritten SHORTER than the consumed offset → reader recovers from 0", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    writeFileSync(file, codexLines("a long first answer that pushes the offset past the rewrite"));
    let b = bindCodex();
    b = readTurnDelta(b).binding; // offset now > size of the rewritten file below

    writeFileSync(file, codexLines("fresh")); // REWRITE (shorter) — same path, new content
    b = bindCodex(b);
    const t = readTurnDelta(b);
    expect(t.reply).toBe("fresh"); // FALSIFYING: a reader that trusts its offset returns "" forever
    expect(t.complete).toBe(true);
  });
});

describe("F2d — MULTIBYTE: offsets are string indices, not bytes (codex P0 #1)", () => {
  it("codex: a multibyte turn-1 does not corrupt the turn-2 slice", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    // Emoji + accents → byte length ≫ string length; a byte-offset reader slices mid-record.
    writeFileSync(file, codexLines("café ☕ résumé 🚀 first答案"));
    let b = bindCodex();
    const t1 = readTurnDelta(b);
    expect(t1.reply).toBe("café ☕ résumé 🚀 first答案");
    b = t1.binding;

    writeFileSync(file, codexLines("café ☕ résumé 🚀 first答案") + codexLines("second 第二"));
    const t2 = readTurnDelta(b);
    expect(t2.reply).toBe("second 第二"); // FALSIFYING: a byte offset returns garbage/partial here
    expect(t2.reply).not.toContain("first");
  });
});

describe("F2e — PARTIAL LINE: a marker split across polls is not lost (codex P0 #1)", () => {
  it("codex: a half-written final line is re-read once flushed, never consumed early", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    const complete = codexLines("done");
    const splitAt = complete.length - 12; // cut inside the trailing task_complete line (no newline)
    writeFileSync(file, complete.slice(0, splitAt)); // partial: no terminal newline yet
    let b = bindCodex();
    const partial = readTurnDelta(b);
    expect(partial.complete).toBe(false); // nothing consumed — no complete line yet
    b = partial.binding;

    writeFileSync(file, complete); // the rest + newline flushes
    const flushed = readTurnDelta(b);
    expect(flushed.complete).toBe(true); // FALSIFYING: an early-consume reader lost this marker → hang
    expect(flushed.reply).toBe("done");
  });
});

describe("F2f — a COMPLETE record with NO trailing newline still completes (codex re-review P1 #1)", () => {
  it("codex: a final task_complete written without a closing newline is observed", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    // No trailing "\n" — a CLI may not newline-terminate its final record.
    const rec = {
      timestamp: "t",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "done" },
    };
    writeFileSync(file, JSON.stringify(rec));
    const t = readTurnDelta(bindCodex());
    expect(t.complete).toBe(true); // FALSIFYING: a "consume only to last \n" reader hangs here
    expect(t.reply).toBe("done");
  });

  it("codex: a partial (unparseable, no-newline) tail is NOT consumed — waits for the flush", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    writeFileSync(file, '{"timestamp":"t","type":"event_msg","payl'); // truncated mid-write
    const t = readTurnDelta(bindCodex());
    expect(t.complete).toBe(false);
    expect(t.binding.offset).toBe(0); // nothing consumed — the partial record is re-read next poll
  });
});

describe("marker-only completion: content without a terminal marker is INCOMPLETE", () => {
  it("codex: agent_message without task_complete → complete=false (quiescence never completes)", () => {
    const file = path.join(codexDay, "rollout-a.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "streaming…" } })}\n`,
    );
    const t = readTurnDelta(bindCodex());
    expect(t.complete).toBe(false);
  });
});
