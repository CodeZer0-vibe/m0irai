/**
 * @file src/adapters/pty/agy-version.test.ts
 * @purpose Falsifiers for the agy version probe (hygiene H3): semver extraction from the REAL output
 *   shape (bare "1.1.1", verified live), fail-soft on garbage/spawn failure, and the once-per-process
 *   cache (both outcomes cached — a broken binary must not re-stall every carrier turn).
 */
import { afterEach, describe, expect, it } from "vitest";
import { probeAgyVersion, resetAgyVersionCache } from "./agy-version.js";

afterEach(() => {
  resetAgyVersionCache();
});

describe("probeAgyVersion", () => {
  it("extracts the bare-semver line agy actually prints", async () => {
    expect(await probeAgyVersion(async () => "1.1.1\n")).toBe("1.1.1");
  });

  it("tolerates a suffix but requires the semver prefix", async () => {
    resetAgyVersionCache();
    expect(await probeAgyVersion(async () => "2.0.3-beta (build 7)")).toBe("2.0.3");
    resetAgyVersionCache();
    expect(await probeAgyVersion(async () => "Antigravity CLI")).toBeUndefined();
  });

  it("a spawn failure yields undefined (caller uses the documented floor)", async () => {
    expect(
      await probeAgyVersion(async () => {
        throw new Error("ENOENT agy.exe");
      }),
    ).toBeUndefined();
  });

  it("caches BOTH outcomes — one probe per process, success or failure", async () => {
    let calls = 0;
    const failing = async (): Promise<string> => {
      calls += 1;
      throw new Error("boom");
    };
    expect(await probeAgyVersion(failing)).toBeUndefined();
    expect(await probeAgyVersion(failing)).toBeUndefined();
    expect(calls).toBe(1);

    resetAgyVersionCache();
    let successCalls = 0;
    const succeeding = async (): Promise<string> => {
      successCalls += 1;
      return "3.2.1";
    };
    expect(await probeAgyVersion(succeeding)).toBe("3.2.1");
    expect(await probeAgyVersion(succeeding)).toBe("3.2.1");
    expect(successCalls).toBe(1);
  });
});
