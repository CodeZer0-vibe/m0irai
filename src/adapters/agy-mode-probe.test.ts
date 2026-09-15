/**
 * @file src/adapters/agy-mode-probe.test.ts
 * @purpose Falsifiers for the W4-2 startup capability probe. D-0 (operator live evidence, agy 1.1.4):
 *   agy prints `--help` to STDERR, not stdout — a stdout-only probe misreports "unsupported" on a
 *   genuinely supporting install. W4-R REFIT R3 (referee FALSIFIED the env hypothesis — a real spawn
 *   answered in 188ms): a persisted cache (keyed on agy path+version) survives reboots with zero
 *   re-spawns; a TIMEOUT (never a non-timeout failure) retries once before declaring probe-failed.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agy-mode-probe
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("execa");
  vi.doUnmock("./pty/agy-pty-spawn.js");
  vi.doUnmock("./pty/agy-version.js");
  vi.doUnmock("./agy-mode-probe-store.js");
});

const FAKE_AGY_PATH = "C:/fake/agy/bin/agy.exe";

function mockSpawnModule(): void {
  vi.doMock("./pty/agy-pty-spawn.js", () => ({
    agyChildEnv: () => ({}),
    agyExePath: () => FAKE_AGY_PATH,
  }));
}

// R3: the version-probe module is mocked SEPARATELY from the mode-probe's own `execa` mock (a
// DIFFERENT spawn, ./pty/agy-version.js's own concern, already covered by its own test file) — so
// every pre-existing execa-call-count assertion below stays scoped to the --help probe alone.
// NOTE: version is a REQUIRED param (no default) — a JS default parameter fires on an explicitly
// passed `undefined` too, which would silently defeat the "version unknown" test below.
function mockVersionModule(version: string | undefined): void {
  vi.doMock("./pty/agy-version.js", () => ({ probeAgyVersion: async () => version }));
}

// R3: the persisted cache is mocked at the MODULE boundary (mirrors mockSpawnModule's own pattern) —
// its own real-fs read/write contract is agy-mode-probe-store.test.ts's concern. Defaults to an
// always-miss, no-op store so every pre-existing test keeps doing a real (mocked-execa) probe with
// zero fs side effects; a test that cares about cache behavior overrides `read`/`persist` directly.
function mockStoreModule(
  read?: (agyPath: string, agyVersion: string) => "supported" | "unsupported" | undefined,
): {
  readonly persist: ReturnType<typeof vi.fn>;
} {
  const persist = vi.fn();
  vi.doMock("./agy-mode-probe-store.js", () => ({
    readCachedProbeOutcome: read ?? (() => undefined),
    persistProbeOutcome: persist,
  }));
  return { persist };
}

function timeoutError(): Error {
  return Object.assign(new Error("Command timed out after 8000 milliseconds"), { timedOut: true });
}

// The exact fragment team-lead quoted from THIS machine's real `agy --version` 1.1.4 `--help`
// output, on STDERR (verified live: `agy --help 2>$null | Out-String` returns length 0, exit 0 —
// the flag list only renders under `2>&1`). A realistic surrounding help block, not just the bare
// line, so the fixture exercises the same MODE_FLAG_PATTERN token-boundary matching real output would.
const REAL_AGY_1_1_4_HELP_STDERR =
  "Usage: agy [options] [command]\n\n" +
  "Options:\n" +
  "  --version                  output the version number\n" +
  "  --mode  Set the agent execution mode for this session (accept-edits, plan)\n" +
  "  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting\n" +
  "  -h, --help                 display help for command\n";

it("supportsModeFlag: detects a --mode flag token, not a prose mention of 'mode'", async () => {
  const { supportsModeFlag } = await import("./agy-mode-probe.js");
  expect(
    supportsModeFlag("Usage: agy [options]\n  --mode <accept-edits|plan>  set agent mode\n"),
  ).toBe(true);
  expect(
    supportsModeFlag("  --model <name>  choose a model\n\nRuns in interactive mode by default."),
  ).toBe(false);
  expect(supportsModeFlag("")).toBe(false);
});

describe("agy-mode-probe: D-0 — the SUPPORTED path (both streams parsed correctly)", () => {
  // D-0: THE exact live defect, reproduced. RED-before-GREEN: this fixture is agy's REAL 1.1.4 help
  // text, on STDERR ONLY (stdout empty, exit 0) — a stdout-only probe sees "" and misreports
  // unsupported on an install that plainly supports --mode.
  it("D-0: agy's real 1.1.4 help text, printed to STDERR (stdout empty) -> probeAgyModeSupport resolves SUPPORTED", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeSupport } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeSupport()).resolves.toBe(true);
  });

  it("probeAgyModeOutcome: the same stderr-only real help text resolves the first-class 'supported' outcome", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "supported" });
  });

  it("probeAgyModeSupport: spawns agy --help ONCE and caches the result across repeat calls (this-process cache)", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: "", stdout: "--mode <accept-edits|plan>\n" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeSupport } = await import("./agy-mode-probe.js");

    const first = await probeAgyModeSupport();
    const second = await probeAgyModeSupport();

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(execa).toHaveBeenCalledTimes(1); // FALSIFYING: no repeat spawn on the second call
  });
});

describe("agy-mode-probe: D-0 — unsupported / probe-failed / cached-projection", () => {
  it("an installed agy WITHOUT --mode anywhere in EITHER stream resolves the 'unsupported' outcome (a genuine, confirmed absence)", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: "", stdout: "Usage: agy [options]\n  --sandbox\n" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome, probeAgyModeSupport } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "unsupported" });
    await expect(probeAgyModeSupport()).resolves.toBe(false);
  });

  // D-0 item (2): a probe FAILURE (spawn error, timeout, malformed) must NEVER collapse into
  // "unsupported" — that collapse is exactly how the operator's live lie was manufactured (a genuinely
  // supporting install that merely failed to be READ correctly was reported as lacking the feature).
  it("D-0: a spawn failure (missing binary / ENOENT) resolves 'probe-failed' with the reason -- NEVER 'unsupported'", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() => Promise.reject(new Error("spawn agy.exe ENOENT")));
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome, probeAgyModeSupport } = await import("./agy-mode-probe.js");

    const outcome = await probeAgyModeOutcome();
    expect(outcome).toEqual({ outcome: "probe-failed", reason: expect.stringContaining("ENOENT") });
    // The boolean-facing API (argv-building call sites) still safely degrades to false either way —
    // "not confirmed true" is the correct signal there regardless of WHY it isn't confirmed.
    await expect(probeAgyModeSupport()).resolves.toBe(false);
  });

  it("cachedAgyModeSupport: undefined ('not yet known') before any probe has settled, then mirrors the boolean projection after", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: "", stdout: "--mode <accept-edits|plan>\n" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { cachedAgyModeSupport, probeAgyModeSupport } = await import("./agy-mode-probe.js");

    expect(cachedAgyModeSupport()).toBeUndefined(); // FALSIFYING: no probe has run yet this module instance
    await probeAgyModeSupport();
    expect(cachedAgyModeSupport()).toBe(true);
  });
});

describe("agy-mode-probe: W4-R REFIT R3 — a timeout retries ONCE; a non-timeout failure never does", () => {
  it("R3: a timeout on the FIRST attempt retries and succeeds on the second — never declares probe-failed for a one-off stall", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule(); // cache misses — forces a real (mocked-execa) probe attempt
    const execa = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" });
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "supported" });
    expect(execa).toHaveBeenCalledTimes(2); // the retry ran — this is NOT a first-attempt success
  });

  it("R3: a timeout on BOTH attempts still resolves probe-failed (a genuine persistent failure, surfaced honestly)", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    const { persist } = mockStoreModule();
    const execa = vi.fn(() => Promise.reject(timeoutError()));
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({
      outcome: "probe-failed",
      reason: expect.stringContaining("timed out"),
    });
    expect(execa).toHaveBeenCalledTimes(2); // retried once, still failed
    expect(persist).not.toHaveBeenCalled(); // a stall is never a fact about the binary
  });

  it("R3: a NON-timeout failure (ENOENT) is never retried — a binary that cannot spawn will not spawn twice either", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule();
    const execa = vi.fn(() => Promise.reject(new Error("spawn agy.exe ENOENT")));
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    const outcome = await probeAgyModeOutcome();
    expect(outcome).toEqual({ outcome: "probe-failed", reason: expect.stringContaining("ENOENT") });
    expect(execa).toHaveBeenCalledTimes(1); // NOT retried
  });
});

describe("agy-mode-probe: W4-R REFIT R3 — cache HIT / cache MISS on a version change", () => {
  it("R3: a cache HIT (matching path+version) resolves WITHOUT spawning agy --help at all", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    mockStoreModule((agyPath, agyVersion) =>
      agyPath === FAKE_AGY_PATH && agyVersion === "1.1.4" ? "supported" : undefined,
    );
    const execa = vi.fn(); // never expected to be called — that's the whole point of the cache
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "supported" });
    expect(execa).not.toHaveBeenCalled();
  });

  it("R3: a cache entry for a DIFFERENT version misses — a fresh probe runs, never a stale cross-version answer", async () => {
    mockSpawnModule();
    mockVersionModule("1.2.0"); // the CURRENT version differs from what's cached below
    mockStoreModule((_agyPath, agyVersion) => (agyVersion === "1.1.4" ? "unsupported" : undefined));
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    // The FRESH probe's real answer ("supported"), never the stale "unsupported" cached under 1.1.4.
    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "supported" });
    expect(execa).toHaveBeenCalledTimes(1); // the version mismatch forced a real spawn
  });
});

describe("agy-mode-probe: W4-R REFIT R3 — persistence on completion, skipped when the version is unknown", () => {
  it("R3: a completed fresh probe PERSISTS its outcome keyed on path+version — available to the next boot", async () => {
    mockSpawnModule();
    mockVersionModule("1.1.4");
    const { persist } = mockStoreModule();
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await probeAgyModeOutcome();
    expect(persist).toHaveBeenCalledWith(FAKE_AGY_PATH, "1.1.4", "supported");
  });

  it("R3: the agy VERSION being unknown (agy-version's own probe failed) skips the cache entirely — falls through to a real probe", async () => {
    mockSpawnModule();
    mockVersionModule(undefined); // agy-version.ts's own documented "version unknown" case
    const { persist } = mockStoreModule(() => "supported"); // would hit if the code wrongly ignored the undefined version
    const execa = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stderr: REAL_AGY_1_1_4_HELP_STDERR, stdout: "" }),
    );
    vi.doMock("execa", () => ({ execa }));
    const { probeAgyModeOutcome } = await import("./agy-mode-probe.js");

    await expect(probeAgyModeOutcome()).resolves.toEqual({ outcome: "supported" });
    expect(execa).toHaveBeenCalledTimes(1); // the cache was never consulted meaningfully
    expect(persist).not.toHaveBeenCalled(); // nothing to key a persisted write on either
  });
});
