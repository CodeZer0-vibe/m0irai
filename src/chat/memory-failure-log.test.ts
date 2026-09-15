import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  MEMORY_FAILURE_LOG_KEEP_BYTES,
  MEMORY_FAILURE_LOG_MAX_BYTES,
  memoryFailureLogPath,
  recordMemoryFailure,
} from "./memory-failure-log.js";

const roots: string[] = [];

function root(): string {
  const created = mkdtempSync(path.join(tmpdir(), "memory-failure-log-"));
  roots.push(created);
  return created;
}

afterEach(() => {
  for (const created of roots.splice(0)) {
    rmSync(created, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it("holds the cap under the exact flood that used to grow without bound", () => {
  const repoRoot = root();
  // The defect this replaces, measured on the pre-fix code: 500 failures of 1,000 characters each
  // wrote 520,500 bytes and would have kept going.
  for (let index = 0; index < 500; index += 1) {
    expect(
      recordMemoryFailure(repoRoot, "memory-compose-failed", new Error("x".repeat(1000))),
    ).toBe(true);
  }
  const log = memoryFailureLogPath(repoRoot);
  expect(statSync(log).size).toBeLessThanOrEqual(MEMORY_FAILURE_LOG_MAX_BYTES);
  expect(statSync(log).size).toBeGreaterThan(MEMORY_FAILURE_LOG_KEEP_BYTES);
});

it("keeps the NEWEST failures and never leaves a half record at the top", () => {
  const repoRoot = root();
  for (let index = 0; index < 400; index += 1) {
    recordMemoryFailure(
      repoRoot,
      "memory-compose-failed",
      new Error(`failure-${index} ${"y".repeat(400)}`),
    );
  }
  const text = readFileSync(memoryFailureLogPath(repoRoot), "utf8");
  expect(text).toContain("failure-399 ");
  expect(text).not.toContain("failure-0 ");
  // Every surviving line is a whole record: it opens with the ISO timestamp the writer emits.
  for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z memory-compose-failed /u);
  }
});

it("trims a log that was already oversized before the cap existed", () => {
  const repoRoot = root();
  mkdirSync(path.join(repoRoot, ".zer0", "journal"), { recursive: true });
  const log = memoryFailureLogPath(repoRoot);
  writeFileSync(log, "legacy line\n".repeat(20_000));
  expect(statSync(log).size).toBeGreaterThan(MEMORY_FAILURE_LOG_MAX_BYTES);

  expect(recordMemoryFailure(repoRoot, "memory-cursor-failed", new Error("after the cap"))).toBe(
    true,
  );
  expect(statSync(log).size).toBeLessThanOrEqual(MEMORY_FAILURE_LOG_MAX_BYTES);
  expect(readFileSync(log, "utf8")).toContain("memory-cursor-failed after the cap");
});

it("bounds and neutralizes the detail it writes", () => {
  const repoRoot = root();
  recordMemoryFailure(
    repoRoot,
    "memory-db-open-failed",
    new Error(`open\nfailed[31m${"z".repeat(400)}`),
  );
  const text = readFileSync(memoryFailureLogPath(repoRoot), "utf8");
  expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
  expect(text).toContain("open\\nfailed\\x1b[31m");
  expect(text.length).toBeLessThan(300);
});

it("reports FALSE when the record cannot be written, instead of swallowing it", () => {
  const repoRoot = root();
  // A directory standing where the log file must be: every write path fails, and the caller must
  // learn that, because a fail-soft record that cannot record has become fail-silent.
  mkdirSync(memoryFailureLogPath(repoRoot), { recursive: true });
  expect(recordMemoryFailure(repoRoot, "memory-compose-failed", new Error("unwritable"))).toBe(
    false,
  );
});

it("never throws out of the caller's briefing path when the root itself is a file", () => {
  const repoRoot = root();
  const notADirectory = path.join(repoRoot, "root-is-a-file");
  writeFileSync(notADirectory, "not a directory");
  expect(() =>
    recordMemoryFailure(notADirectory, "memory-compose-failed", new Error("bad")),
  ).not.toThrow();
  expect(recordMemoryFailure(notADirectory, "memory-compose-failed", new Error("bad"))).toBe(false);
});
