/**
 * @file src/adapters/agy-models.test.ts
 * @purpose Falsifiers for the agy model-list parser: it extracts the model display names out of the real
 *   `agy models` stream (braille "Fetching…" spinner + ANSI redraws), drops the spinner/non-model lines,
 *   de-dupes, bounds the count, and fetchAgyModels fails SOFT to [] on a runner error.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agy-models
 */
import { expect, it } from "vitest";
import { fetchAgyModels, parseAgyModels } from "./agy-models.js";

it("extracts model names from the spinner + ANSI `agy models` stream, in order", () => {
  const raw =
    "\x1b[?25l" +
    "\r\x1b[K⠋ Fetching available models..." +
    "\r\x1b[K⠙ Fetching available models..." +
    "\r\n\x1b[0mGemini 3.5 Flash (Medium)\r\nGemini 3.5 Flash (High)\r\n" +
    "Gemini 3.1 Pro (High)\r\nClaude Opus 4.6 (Thinking)\r\nGPT-OSS 120B (Medium)\r\n" +
    "\x1b[?25h";
  expect(parseAgyModels(raw)).toEqual([
    "Gemini 3.5 Flash (Medium)",
    "Gemini 3.5 Flash (High)",
    "Gemini 3.1 Pro (High)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)",
  ]);
});

it("drops the Fetching line, de-dupes, and ignores non-model prose", () => {
  const raw =
    "⠋ Fetching available models...\r\nGemini 3.1 Pro (High)\r\nGemini 3.1 Pro (High)\r\njust some prose\r\n";
  expect(parseAgyModels(raw)).toEqual(["Gemini 3.1 Pro (High)"]);
});

it("rejects agy ERROR lines that share the (tier) shape, keeps real models (codex DECISION)", () => {
  const raw =
    "Authentication failed (401)\r\nNo models available (offline)\r\nUnable to fetch (retry)\r\n" +
    "Gemini 3.1 Pro (High)\r\n";
  expect(parseAgyModels(raw)).toEqual(["Gemini 3.1 Pro (High)"]);
});

it("returns [] for empty / pure-control output", () => {
  expect(parseAgyModels("")).toEqual([]);
  expect(parseAgyModels("\x1b[2J\x1b[H\x1b[?25l")).toEqual([]);
});

it("drops ConPTY title OSC records in both BEL and ST forms", () => {
  const title = "C:\\Users\\operator\\agy.exe Gemini 3.7 Flash (High)";
  const raw = `\x1b]0;${title}\x07\r\n\x1b]2;${title}\x1b\\\r\nGemini 3.7 Flash (High)\r\n`;
  expect(parseAgyModels(raw)).toEqual(["Gemini 3.7 Flash (High)"]);
});

it("bounds a flood of model-shaped lines", () => {
  const flood = Array.from({ length: 200 }, (_, i) => `Model ${String(i)} (X)`).join("\n");
  expect(parseAgyModels(flood).length).toBeLessThanOrEqual(64);
});

it("fetchAgyModels parses the runner output, and fails soft to [] on error", async () => {
  await expect(fetchAgyModels(async () => "Gemini 3.1 Pro (High)\n")).resolves.toEqual([
    "Gemini 3.1 Pro (High)",
  ]);
  await expect(
    fetchAgyModels(async () => {
      throw new Error("pty died");
    }),
  ).resolves.toEqual([]);
});
