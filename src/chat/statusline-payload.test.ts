/**
 * @file src/chat/statusline-payload.test.ts
 * @purpose Contract for readClaudeStatusUsage: claude's UNTRUSTED statusLine payload → normalized
 *   AgentStatusUsage (USED %s). Real captured fixture; parse-at-edge (bad/missing → undefined); the trust
 *   boundary — a hostile string in model.display_name/cwd must NEVER appear in the output.
 * @depends vitest, node:fs/promises, node:os, node:path, ./statusline-payload
 */
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acpUsageToStatus,
  bindingResetAtMs,
  readClaudeStatusUsage,
  readClaudeStatusUsageWhenFresh,
} from "./statusline-payload.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writePayload(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sl-payload-"));
  tmpDirs.push(dir);
  const file = join(dir, "payload.json");
  await writeFile(file, content, "utf8");
  return file;
}

// The REAL captured claude statusLine payload (post-turn), trimmed to the fields the reader extracts.
const REAL_PAYLOAD = {
  model: { display_name: "Opus 4.8 (1M context)" },
  cwd: "C:/Users/x/repo",
  context_window: {
    total_input_tokens: 29_904,
    context_window_size: 1_000_000,
    used_percentage: 3,
    remaining_percentage: 97,
    current_usage: null,
  },
  rate_limits: {
    five_hour: { used_percentage: 24, resets_at: 1_782_255_000 },
    seven_day: { used_percentage: 53, resets_at: 1_782_475_200 },
  },
  cost: { total_cost_usd: 0.068_645_5 },
};

describe("readClaudeStatusUsage — normalization (USED %)", () => {
  it("real post-turn payload → contextUsedPct 3 + label from the binding (seven_day 53%) window", async () => {
    const usage = await readClaudeStatusUsage(await writePayload(JSON.stringify(REAL_PAYLOAD)));
    expect(usage?.contextUsedPct).toBe(3); // used_percentage, not 100 − it
    expect(usage?.label).toBe("53%");
    expect(usage?.exhausted).toBe(false);
  });

  it("extracts the 5h + weekly windows distinctly: USED % = used_percentage + reset epoch in ms", async () => {
    const usage = await readClaudeStatusUsage(await writePayload(JSON.stringify(REAL_PAYLOAD)));
    expect(usage?.fiveHourUsedPct).toBe(24); // used_percentage directly (not 100 − 24)
    expect(usage?.fiveHourResetsAtMs).toBe(1_782_255_000_000); // resets_at (s) * 1000
    expect(usage?.weeklyUsedPct).toBe(53); // seven_day.used_percentage
    expect(usage?.weeklyResetsAtMs).toBe(1_782_475_200_000);
  });
});

describe("readClaudeStatusUsage — context fallbacks + boot", () => {
  it("used_percentage only (no remaining_percentage) -> contextUsedPct = used", async () => {
    const payload = {
      context_window: {
        context_window_size: 1_000_000,
        used_percentage: 8,
        remaining_percentage: null,
      },
      rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 5 } },
    };
    const usage = await readClaudeStatusUsage(await writePayload(JSON.stringify(payload)));
    expect(usage?.contextUsedPct).toBe(8);
    expect(usage?.label).toBe("10%"); // binding = the higher-used (five_hour 10%)
  });

  it("remaining_percentage only (no used_percentage) -> contextUsedPct = 100 − remaining", async () => {
    const payload = {
      context_window: { remaining_percentage: 90, used_percentage: null },
      rate_limits: { five_hour: { used_percentage: 4 } },
    };
    const usage = await readClaudeStatusUsage(await writePayload(JSON.stringify(payload)));
    expect(usage?.contextUsedPct).toBe(10); // 100 − 90
  });

  it("boot render (null percentages, no rate_limits) -> undefined", async () => {
    const payload = {
      context_window: {
        context_window_size: 1_000_000,
        used_percentage: null,
        remaining_percentage: null,
      },
    };
    expect(
      await readClaudeStatusUsage(await writePayload(JSON.stringify(payload))),
    ).toBeUndefined();
  });
});

describe("readClaudeStatusUsage — trust boundary + parse errors", () => {
  it("hostile strings in model.display_name/cwd NEVER appear in the output (INV-13)", async () => {
    const esc = String.fromCharCode(0x1b); // ANSI escape introducer
    const rtl = String.fromCharCode(0x20_2e); // right-to-left override
    const evil = `${esc}[31mEVIL${rtl}`;
    const payload = { ...REAL_PAYLOAD, model: { display_name: evil }, cwd: evil };
    const usage = await readClaudeStatusUsage(await writePayload(JSON.stringify(payload)));
    const blob = JSON.stringify(usage);
    expect(blob).not.toContain(esc);
    expect(blob).not.toContain(rtl);
    expect(blob).not.toContain("EVIL");
  });

  it("truncated / malformed JSON -> undefined (no throw)", async () => {
    // Brace-free malformed sample on purpose: gate-clamps' line counter is not string/comment-aware, so a
    // stray open-brace in a test string (or comment) throws off its function-length count for the rest of
    // the file. A truncated array hits the same JSON.parse-throws -> undefined path without that hazard.
    expect(await readClaudeStatusUsage(await writePayload("[1, 2"))).toBeUndefined();
  });

  it("missing file -> undefined (no throw)", async () => {
    expect(
      await readClaudeStatusUsage(join(tmpdir(), "zer0-no-such-payload-xyz.json")),
    ).toBeUndefined();
  });
});

describe("readClaudeStatusUsage — freshness gate (codex BLOCK-2: no stale payload emitted as fresh)", () => {
  it("payload older than minMtimeMs -> undefined (a prior turn's payload is not re-emitted as fresh)", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    expect(await readClaudeStatusUsage(file, Date.now())).toBeUndefined();
  });

  it("payload at/after minMtimeMs -> usage (this turn's fresh write is emitted)", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    const { mtimeMs } = await stat(file);
    expect((await readClaudeStatusUsage(file, mtimeMs - 1))?.contextUsedPct).toBe(3);
  });

  it("no minMtimeMs -> gate disabled (existing callers unaffected)", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    expect((await readClaudeStatusUsage(file))?.contextUsedPct).toBe(3);
  });
});

describe("readClaudeStatusUsageWhenFresh — waits out the async statusLine write (the blank-bar race)", () => {
  it("catches a payload written AFTER the poll starts (a single read would miss it)", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // stale at poll start
    const laneStart = Date.now();
    setTimeout(() => {
      void writeFile(file, JSON.stringify(REAL_PAYLOAD), "utf8"); // the real statusLine write lands LATE
    }, 250);
    const usage = await readClaudeStatusUsageWhenFresh(file, laneStart, {
      timeoutMs: 3000,
      intervalMs: 80,
    });
    expect(usage?.contextUsedPct).toBe(3);
  });

  it("returns undefined if no fresh payload lands within the window (no-stale preserved)", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(
      await readClaudeStatusUsageWhenFresh(file, Date.now(), { timeoutMs: 250, intervalMs: 80 }),
    ).toBeUndefined();
  });

  it("aborts a detached freshness poll without keeping its timer alive", async () => {
    const file = await writePayload(JSON.stringify(REAL_PAYLOAD));
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const controller = new AbortController();
    const started = Date.now();
    const poll = readClaudeStatusUsageWhenFresh(file, Date.now(), {
      timeoutMs: 5000,
      intervalMs: 1000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(poll).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("acpUsageToStatus — the ACP rate-limit windows map to the SAME meters as the pty payload (U2d-b)", () => {
  it("windows with utilization → 5h/weekly USED % + reset ms, label from the binding window, pty parity", () => {
    const usage = acpUsageToStatus({
      used: 42_585,
      size: 1_000_000,
      rateLimits: {
        five_hour: { status: "allowed", utilization: 24, resetsAt: 1_782_255_000 },
        seven_day: { status: "allowed_warning", utilization: 53, resetsAt: 1_782_475_200 },
      },
    });
    // Identical semantics to readClaudeStatusUsage on the pty payload: USED %s, resets in ms, the label
    // is the binding (highest-used) window — so the bar renders claude the same on either transport.
    expect(usage).toEqual({
      label: "53%",
      exhausted: false,
      contextUsedPct: 4,
      fiveHourUsedPct: 24,
      fiveHourResetsAtMs: 1_782_255_000_000,
      weeklyUsedPct: 53,
      weeklyResetsAtMs: 1_782_475_200_000,
    });
  });

  it("a REJECTED window is exhausted even without a utilization number (never fabricate a %)", () => {
    const usage = acpUsageToStatus({
      used: 10,
      size: 100,
      rateLimits: { five_hour: { status: "rejected", resetsAt: 1_783_080_600 } },
    });
    expect(usage?.exhausted).toBe(true); // rejected MEANS rate-limited — no % needed to know that
    expect(usage?.fiveHourUsedPct).toBeUndefined(); // absent stays absent
    expect(usage?.fiveHourResetsAtMs).toBe(1_783_080_600_000); // the reset instant still shows
    expect(usage?.label).toBe("ctx"); // no numeric window % → no fake "NN%" label
  });
});

describe("acpUsageToStatus — window verdicts + fallbacks (U2d-b)", () => {
  it("weekly falls back to the most-used MODEL weekly when the overall seven_day is absent", () => {
    const usage = acpUsageToStatus({
      used: 10,
      size: 100,
      rateLimits: {
        seven_day_opus: { status: "allowed", utilization: 42, resetsAt: 2_000_000_000 },
        seven_day_sonnet: { status: "allowed", utilization: 17, resetsAt: 2_000_000_100 },
      },
    });
    expect(usage?.weeklyUsedPct).toBe(42); // the binding model weekly
    expect(usage?.weeklyResetsAtMs).toBe(2_000_000_000_000); // from the SAME picked window
  });
});

describe("acpUsageToStatus — the /usage plan source (U2d-c)", () => {
  it("STATUS-LESS windows map to the same meters — knowledge, no verdict", () => {
    const usage = acpUsageToStatus({
      used: 42_585,
      size: 1_000_000,
      rateLimits: {
        five_hour: { utilization: 70, resetsAt: 1_783_080_599 },
        seven_day: { utilization: 55, resetsAt: 1_783_079_999 },
      },
    });
    expect(usage).toEqual({
      label: "70%",
      exhausted: false,
      contextUsedPct: 4,
      fiveHourUsedPct: 70,
      fiveHourResetsAtMs: 1_783_080_599_000,
      weeklyUsedPct: 55,
      weeklyResetsAtMs: 1_783_079_999_000,
    });
  });

  it("no rateLimits → the ctx-only shape is unchanged (the pre-U2d-b contract holds)", () => {
    expect(acpUsageToStatus({ used: 42_585, size: 1_000_000 })).toEqual({
      label: "ctx",
      exhausted: false,
      contextUsedPct: 4,
    });
  });

  it("utilization ≥ 100 → exhausted, clamped label (the 5h window is spent)", () => {
    const usage = acpUsageToStatus({
      used: 10,
      size: 100,
      rateLimits: { five_hour: { status: "rejected", utilization: 104 } },
    });
    expect(usage?.exhausted).toBe(true);
    expect(usage?.fiveHourUsedPct).toBe(100); // clamped
    expect(usage?.label).toBe("100%");
  });
});

// FIX-3c BLOCK 5: lane recovery keys off the reset instant of the window that is actually BINDING. The
// field death (chat-1784553379589) was WEEKLY-based — weeklyUsedPct 97-98 while fiveHourUsedPct sat at
// 27-32 — so feeding recovery the 5h reset made an exhausted lane re-probe every 15 minutes for DAYS.
describe("BLOCK 5: bindingResetAtMs picks the window that actually constrains the lane", () => {
  it("returns the WEEKLY reset when weekly is the more-used window (the field's own shape)", () => {
    expect(
      bindingResetAtMs({
        label: "98%",
        exhausted: false,
        fiveHourUsedPct: 32,
        fiveHourResetsAtMs: 1_784_574_000_000,
        weeklyUsedPct: 98,
        weeklyResetsAtMs: 1_784_894_400_000,
      }),
    ).toBe(1_784_894_400_000);
  });

  it("returns the 5h reset when the 5h window is the more-used one", () => {
    expect(
      bindingResetAtMs({
        label: "91%",
        exhausted: false,
        fiveHourUsedPct: 91,
        fiveHourResetsAtMs: 111,
        weeklyUsedPct: 12,
        weeklyResetsAtMs: 999,
      }),
    ).toBe(111);
  });

  it("falls back to whichever reset exists when only one window reported", () => {
    expect(bindingResetAtMs({ label: "x", exhausted: false, weeklyResetsAtMs: 999 })).toBe(999);
    expect(bindingResetAtMs({ label: "x", exhausted: false, fiveHourResetsAtMs: 111 })).toBe(111);
    expect(bindingResetAtMs({ label: "ctx", exhausted: false })).toBeUndefined();
  });

  it("a REJECTED window wins outright — that is the one that actually refused the request", () => {
    // exhausted:true with only a weekly reset means the weekly window is the refusing one, even when the
    // 5h utilization number happens to be higher/absent.
    expect(
      bindingResetAtMs({
        label: "98%",
        exhausted: true,
        fiveHourUsedPct: 99,
        weeklyUsedPct: 98,
        weeklyResetsAtMs: 1_784_894_400_000,
      }),
    ).toBe(1_784_894_400_000);
  });
});
