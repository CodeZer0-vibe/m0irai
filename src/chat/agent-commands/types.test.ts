/**
 * @file src/chat/agent-commands/types.test.ts
 * @purpose Falsifiers for isSafeCommandName — the SOLE admission gate that stops a hostile disk-sourced command
 *          name from reaching the trusted composer (codex P1 #1). Accepts real names incl. `:` namespacing;
 *          rejects empty / spaces / uppercase / slashes / path tricks / control bytes / over-long.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./types
 */
import { expect, it } from "vitest";
import { isSafeCommandName } from "./types.js";

const ESC = String.fromCharCode(27);

it("accepts real command names, including : namespacing and -_. separators", () => {
  for (const ok of [
    "model",
    "git:commit",
    "compose-prd",
    "prompts:draftpr",
    "a",
    "x_y.z",
    "review2",
  ]) {
    expect(isSafeCommandName(ok)).toBe(true);
  }
});

it("rejects unsafe names (the composer-injection guard)", () => {
  const bad = [
    "",
    " ",
    "has space",
    "UPPER", // grammar is lowercase-only; the scanner lowercases the filename BEFORE this gate
    "/slash",
    "a/b",
    "../etc",
    "trailing ",
    `${ESC}[31mevil`, // a raw ESC byte must never pass
    "x".repeat(60), // over the length cap
    ".dotfirst", // must start alphanumeric
  ];
  for (const b of bad) {
    expect(isSafeCommandName(b)).toBe(false);
  }
});
