/**
 * @file src/adapters/agy-output.test.ts
 * @purpose Falsifiers for the pure agy output parser: stripAnsi (CSI + OSC/BEL), fenced + bare JSON
 *   extraction, strict-vs-lenient malformed handling, plain-text passthrough, the withExitCode overlay,
 *   and (VESTIGE SWEEP S2) isAgyPermissionDenial's live-captured boilerplate match.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agy-output
 */
import { expect, it } from "vitest";
import { isAgyPermissionDenial, parseAgyOutput, withExitCode } from "./agy-output.js";

// The exact string live-captured 2026-07-17 from a fresh, ungranted agy install under --print (S1 research).
const LIVE_DENIAL_TEXT =
  'jetski: no output produced — a tool required the "write_file" permission that headless mode cannot ' +
  "prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. " +
  "write_file(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

it("strips CSI color escapes, leaving the bare reply", () => {
  expect(parseAgyOutput(`${ESC}[32m63${ESC}[0m\n`)).toEqual({ exitCode: 0, stdout: "63" });
});

it("strips OSC sequences terminated by BEL", () => {
  expect(parseAgyOutput(`${ESC}]0;window-title${BEL}answer`)).toEqual({
    exitCode: 0,
    stdout: "answer",
  });
});

it("parses fenced JSON into the shared structured shape", () => {
  expect(parseAgyOutput('```json\n{"stdout":"ok","rating":"GREEN"}\n```')).toEqual({
    exitCode: 0,
    stdout: "ok",
    structured: { rating: "GREEN", stdout: "ok" },
  });
});

it("parses a bare top-level JSON object", () => {
  expect(parseAgyOutput('{"stdout":"hi","n":2}')).toEqual({
    exitCode: 0,
    stdout: "hi",
    structured: { n: 2, stdout: "hi" },
  });
});

it("throws on non-JSON only when structured output is required", () => {
  expect(() => parseAgyOutput("plain answer", true)).toThrow("non-JSON");
  expect(parseAgyOutput("plain answer")).toEqual({ exitCode: 0, stdout: "plain answer" });
});

it("throws on malformed JSON in a fence when structured is required", () => {
  expect(() => parseAgyOutput("```json\n{ not valid }\n```", true)).toThrow("malformed");
});

it("treats a non-JSON brace substring as prose in lenient mode", () => {
  const raw = "Here { not: valid }";
  expect(parseAgyOutput(raw)).toEqual({ exitCode: 0, stdout: raw });
});

it("overlays the real process exit code onto a parsed result", () => {
  expect(withExitCode(parseAgyOutput("done"), 137)).toEqual({ exitCode: 137, stdout: "done" });
});

it("recognizes agy's own live-captured headless permission-denial boilerplate", () => {
  expect(isAgyPermissionDenial(LIVE_DENIAL_TEXT)).toBe(true);
});

it("recognizes the denial boilerplate wrapped in surrounding ConPTY noise", () => {
  expect(isAgyPermissionDenial(`\r\n${LIVE_DENIAL_TEXT}\r\n`)).toBe(true);
});

it("does not flag a normal reply that never mentions permissions", () => {
  expect(isAgyPermissionDenial("I updated src/index.ts to fix the off-by-one bug.")).toBe(false);
});

it("does not flag a reply that only mentions one denial fragment in isolation", () => {
  expect(isAgyPermissionDenial("See docs/permissions.allow for the schema.")).toBe(false);
  expect(
    isAgyPermissionDenial("The request was auto-denied by the reviewer, unrelated to agy."),
  ).toBe(false);
});

// S-A (FIX WAVE Round A, 2026-07-18 = sweep#1): the prior check was an unanchored substring search —
// BOTH fragments appearing ANYWHERE in the reply tripped it, so a legitimate answer that QUOTES agy's
// own denial boilerplate (e.g. the user asks gemini to explain the error) would false-positive into a
// thrown DispatchError, discarding a genuinely helpful reply. Shape-anchoring to the reply's own START
// fixes this: only a reply that IS, from its first character, agy's denial message classifies as one.
it("S-A: a normal reply that QUOTES the full denial boilerplate mid-answer is NOT flagged (shape-anchored, not a substring search)", () => {
  const quoting = `That error means agy couldn't write the file. The exact message was: "${LIVE_DENIAL_TEXT}" — add the permission and retry.`;
  expect(isAgyPermissionDenial(quoting)).toBe(false);
});
