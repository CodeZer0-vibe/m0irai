/**
 * @file src/chat/ui.screen-claimed.test.ts
 * @purpose F2 contract — no raw terminal writes while the Ink cockpit owns the screen. With the screen
 *   CLAIMED, both writeStdout and writeStderr (printChatStatus / printChatError) emit ZERO bytes to the
 *   real streams and TEE the line to `.zer0/tui-suppressed.log` instead (so nothing vanishes silently);
 *   UNCLAIMED, they hit the terminal byte-for-byte as before and touch no sink file. A temp cwd isolates
 *   the cwd-relative sink from the repo.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ../shared/screen-claim, ./ui
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimScreen, releaseScreen } from "../shared/screen-claim.js";
import { printChatError, printChatStatus } from "./ui.js";

const SINK_REL: string = join(".zer0", "tui-suppressed.log");

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
let sinkRoot: string;
let priorCwd: string;
let priorNoColor: string | undefined;

beforeEach(() => {
  priorNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  priorCwd = process.cwd();
  sinkRoot = mkdtempSync(join(tmpdir(), "zer0-ui-claim-"));
  process.chdir(sinkRoot);
});

afterEach(() => {
  releaseScreen();
  process.chdir(priorCwd);
  rmSync(sinkRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (priorNoColor === undefined) {
    process.env.NO_COLOR = undefined;
  } else {
    process.env.NO_COLOR = priorNoColor;
  }
});

function sinkText(): string {
  return readFileSync(join(sinkRoot, SINK_REL), "utf8");
}

describe("claimed screen — writers tee to the suppressed sink, zero terminal bytes", () => {
  it("printChatError writes ZERO bytes to stderr and lands the message in the sink", () => {
    claimScreen();

    printChatError("boom on stderr");

    expect(stderrChunks.join("")).toBe("");
    expect(sinkText()).toContain("boom on stderr");
  });

  it("printChatStatus writes ZERO bytes to stdout and lands the message in the sink", () => {
    claimScreen();

    printChatStatus("status while claimed");

    expect(stdoutChunks.join("")).toBe("");
    expect(sinkText()).toContain("status while claimed");
  });
});

describe("unclaimed screen — writers hit the terminal and touch no sink (unchanged)", () => {
  it("printChatError writes to stderr and creates no sink file", () => {
    releaseScreen();

    printChatError("boom unclaimed");

    expect(stderrChunks.join("")).toContain("boom unclaimed");
    expect(existsSync(join(sinkRoot, SINK_REL))).toBe(false);
  });

  it("printChatStatus writes to stdout and creates no sink file", () => {
    releaseScreen();

    printChatStatus("status unclaimed");

    expect(stdoutChunks.join("")).toContain("status unclaimed");
    expect(existsSync(join(sinkRoot, SINK_REL))).toBe(false);
  });
});
