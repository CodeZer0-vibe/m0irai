/**
 * @file src/chat/agy-statusline-payload.test.ts
 * @purpose Falsifiers for readAgyStatusUsage, driven by the REAL agy statusLine payload captured live via
 *   `agy -p` on 2026-06-24 (not a hand-invented shape): it normalizes context_window + the gemini quota
 *   windows to AgentStatusUsage as USED %s, strips raw strings (INV-13), honors the freshness gate, and
 *   returns undefined for missing/boot payloads.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./agy-statusline-payload
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAgyStatusUsage,
  readAgyStatusUsageWhenFreshForLane,
} from "./agy-statusline-payload.js";

// VERBATIM excerpt of a real `agy -p` statusLine payload (captured 2026-06-24); model/email kept to prove
// the schema STRIPS them (INV-13); 3p-* and extras the schema ignores.
const REAL_PAYLOAD = {
  context_window: {
    used_percentage: 0.0607,
    remaining_percentage: 99.939,
    context_window_size: 1048576,
  },
  model: { display_name: "Gemini 3.1 Pro (High)" },
  quota: {
    "gemini-5h": {
      remaining_fraction: 1,
      reset_time: "2026-06-25T00:50:40Z",
      reset_in_seconds: 17994,
    },
    "gemini-weekly": { remaining_fraction: 0.214, reset_time: "2026-06-26T21:16:05Z" },
    "3p-5h": { remaining_fraction: 1, reset_time: "2026-06-25T00:50:43Z" },
  },
  plan_tier: "Google AI Pro",
  email: "x@example.com",
};

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(payload: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "agy-pl-"));
  const p = join(dir, "agy.json");
  writeFileSync(p, JSON.stringify(payload), "utf8");
  return p;
}

describe("readAgyStatusUsage (real captured payload)", () => {
  it("normalizes ctx + the 5h/weekly USED gauges + the binding label, leaking no raw strings", async () => {
    const usage = await readAgyStatusUsage(write(REAL_PAYLOAD));
    expect(usage?.contextUsedPct).toBe(0); // 0.0607 used -> 0
    expect(usage?.fiveHourUsedPct).toBe(0); // gemini-5h remaining_fraction 1 -> 0% used
    expect(usage?.weeklyUsedPct).toBe(79); // gemini-weekly 0.214 left -> 79% used
    expect(usage?.weeklyResetsAtMs).toBe(Date.parse("2026-06-26T21:16:05Z"));
    expect(usage?.label).toBe("79%"); // binding = gemini-weekly 0.214 left -> 79% used
    expect(usage?.exhausted).toBe(false);
    expect(usage?.fiveHourResetsAtMs).toBe(Date.parse("2026-06-25T00:50:40Z"));
    expect(JSON.stringify(usage)).not.toContain("Gemini 3.1 Pro"); // INV-13: no raw string in the output
    expect(JSON.stringify(usage)).not.toContain("Google AI Pro");
  });

  it("flags exhausted when a gemini window is fully spent", async () => {
    const spent = {
      ...REAL_PAYLOAD,
      quota: {
        "gemini-5h": { remaining_fraction: 0 },
        "gemini-weekly": { remaining_fraction: 0.5 },
      },
    };
    const usage = await readAgyStatusUsage(write(spent));
    expect(usage?.exhausted).toBe(true);
    expect(usage?.fiveHourUsedPct).toBe(100); // 0 left -> 100% used
    expect(usage?.weeklyUsedPct).toBe(50); // 0.5 left -> 50% used (reader populates; display filters it)
    expect(usage?.label).toBe("100%"); // binding window 0 left -> 100% used
  });

  it("context-only when quota is absent (USED = 100 − remaining)", async () => {
    const usage = await readAgyStatusUsage(write({ context_window: { remaining_percentage: 80 } }));
    expect(usage).toEqual({ label: "ctx", exhausted: false, contextUsedPct: 20 });
  });

  it("undefined for a missing file or a stale payload (freshness gate)", async () => {
    expect(await readAgyStatusUsage(join(tmpdir(), "nope-agy.json"))).toBeUndefined();
    const p = write(REAL_PAYLOAD);
    const past = new Date(Date.parse("2020-01-01T00:00:00Z"));
    utimesSync(p, past, past); // mtime well before the floor
    expect(await readAgyStatusUsage(p, Date.now())).toBeUndefined();
  });
});

describe("readAgyStatusUsage cancellation", () => {
  it("aborts a missing-file poll without holding room shutdown for the full timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const read = await readAgyStatusUsageWhenFreshForLane(
      join(tmpdir(), "nope-agy-abort.json"),
      Date.now(),
      { cwd: "C:/repo" },
      { timeoutMs: 5_000, intervalMs: 250, signal: controller.signal },
    );
    expect(read).toEqual({ outcome: "missing" });
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("readAgyStatusUsage — out-of-range quota fractions are ignored (codex D1)", () => {
  it("ignores out-of-range quota fractions instead of painting a confident 100%/0%", async () => {
    const invalid = {
      context_window: { remaining_percentage: 90 },
      quota: {
        "gemini-5h": { remaining_fraction: 1.5 }, // invalid (>1) — must be omitted, not clamped to 0% used
        "gemini-weekly": { remaining_fraction: 0.5 }, // valid — the binding window
      },
    };
    const usage = await readAgyStatusUsage(write(invalid));
    expect(usage?.fiveHourUsedPct).toBeUndefined(); // the invalid 5h is dropped, not shown
    expect(usage?.weeklyUsedPct).toBe(50); // the valid weekly (0.5 left) -> 50% used
    expect(usage?.label).toBe("50%"); // the valid weekly drives the label
    expect(usage?.contextUsedPct).toBe(10); // 100 − 90 remaining
  });
});
