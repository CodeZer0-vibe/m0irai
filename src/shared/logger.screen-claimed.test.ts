/**
 * @file src/shared/logger.screen-claimed.test.ts
 * @purpose F3 contract — a stderr log line must not vanish while the Ink cockpit owns the screen. With
 *   the screen CLAIMED, writeLog emits ZERO bytes to process.stderr and TEEs the FULLY-FORMATTED line
 *   (level + context + metadata) to `.zer0/tui-suppressed.log`; UNCLAIMED, it writes to stderr as before
 *   and touches no sink. The prior behavior dropped the line entirely — the diagnostic vanished for weeks.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./screen-claim, ./logger
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { claimScreen, releaseScreen } from "./screen-claim.js";

const SINK_REL: string = join(".zer0", "tui-suppressed.log");

const stderrChunks: string[] = [];
let sinkRoot: string;
let priorCwd: string;

beforeEach(() => {
  stderrChunks.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  priorCwd = process.cwd();
  sinkRoot = mkdtempSync(join(tmpdir(), "zer0-log-claim-"));
  process.chdir(sinkRoot);
});

afterEach(() => {
  releaseScreen();
  process.chdir(priorCwd);
  rmSync(sinkRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("claimed screen — logs tee to the suppressed sink", () => {
  it("a warn line writes ZERO bytes to stderr and lands, fully formatted, in the sink", () => {
    claimScreen();

    createLogger().warn({ phase: "chat" }, "evidence write failed", { reason: "boom" });

    expect(stderrChunks.join("")).toBe("");
    const sink = readFileSync(join(sinkRoot, SINK_REL), "utf8");
    expect(sink).toContain("[WARN]");
    expect(sink).toContain("evidence write failed");
    expect(sink).toContain('"reason":"boom"');
  });
});

describe("unclaimed screen — logs hit stderr and touch no sink (unchanged)", () => {
  it("a warn line writes to stderr and creates no sink file", () => {
    releaseScreen();

    createLogger().warn({ phase: "chat" }, "evidence write failed", { reason: "boom" });

    expect(stderrChunks.join("")).toContain("evidence write failed");
    expect(existsSync(join(sinkRoot, SINK_REL))).toBe(false);
  });
});
