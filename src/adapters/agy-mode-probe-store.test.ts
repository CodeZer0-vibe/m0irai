/**
 * @file src/adapters/agy-mode-probe-store.test.ts
 * @purpose RED-first falsifiers for the W4-R REFIT R3 persisted probe cache (mirrors trust-store.
 *   test.ts's own real-fs + injected-path conventions). A cache HIT requires an EXACT match on both
 *   agy binary path AND version; a missing/malformed/mismatched cache is undefined, never a throw.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./agy-mode-probe-store
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistProbeOutcome, readCachedProbeOutcome } from "./agy-mode-probe-store.js";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-probe-cache-"));
  // Sits under a not-yet-created subdir to prove persistProbeOutcome mkdir -p's its parent (~/.zer0
  // may not exist on first run) — mirrors trust-store.test.ts's own precedent exactly.
  cachePath = join(dir, "home", ".zer0", "agy-mode-probe-cache.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("agy-mode-probe-store: fail-closed default + persistence", () => {
  it("returns undefined when no cache file exists yet (fresh machine, never a throw)", () => {
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBeUndefined();
  });

  it("persists then reads back an EXACT path+version match", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "supported", cachePath);
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBe("supported");
  });

  it("persists 'unsupported' just as faithfully as 'supported'", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "unsupported", cachePath);
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBe("unsupported");
  });
});

describe("agy-mode-probe-store: the cache key is path+version — a mismatch on EITHER invalidates it", () => {
  it("a DIFFERENT binary path (a different agy install) misses — never cross-serves another install's answer", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "supported", cachePath);
    expect(readCachedProbeOutcome("D:/other-agy.exe", "1.1.4", cachePath)).toBeUndefined();
  });

  it("a DIFFERENT version (an upgrade/downgrade) misses — forces a fresh probe, never a stale answer", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "supported", cachePath);
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.5", cachePath)).toBeUndefined();
  });

  it("a fresh write REPLACES the prior entry (rewrite, not merge — only one path+version pair is ever meaningful)", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "unsupported", cachePath);
    persistProbeOutcome("C:/agy-new.exe", "1.2.0", "supported", cachePath);
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBeUndefined();
    expect(readCachedProbeOutcome("C:/agy-new.exe", "1.2.0", cachePath)).toBe("supported");
  });
});

describe("agy-mode-probe-store: fail-closed on a corrupt or wrong-shape file (never a throw, never a false hit)", () => {
  it("malformed JSON -> undefined, not a throw", () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "not json at all", "utf8");
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBeUndefined();
  });

  it("an unrecognized schema version -> undefined, never silently honored", () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        agyPath: "C:/agy.exe",
        agyVersion: "1.1.4",
        outcome: "supported",
      }),
      "utf8",
    );
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBeUndefined();
  });

  it("an outcome outside the 2 cache-worthy values -> undefined (probe-failed is never persisted, and a foreign value is rejected the same way)", () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        agyPath: "C:/agy.exe",
        agyVersion: "1.1.4",
        outcome: "probe-failed",
      }),
      "utf8",
    );
    expect(readCachedProbeOutcome("C:/agy.exe", "1.1.4", cachePath)).toBeUndefined();
  });
});

describe("agy-mode-probe-store: atomic write (temp + rename)", () => {
  it("the on-disk file is valid, pretty-printed JSON with the exact written fields", () => {
    persistProbeOutcome("C:/agy.exe", "1.1.4", "supported", cachePath);
    const raw = readFileSync(cachePath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      agyPath: "C:/agy.exe",
      agyVersion: "1.1.4",
      outcome: "supported",
    });
  });
});
