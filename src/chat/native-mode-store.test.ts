/**
 * @file src/chat/native-mode-store.test.ts
 * @purpose Falsifiers for native-mode-store: round-trip persistence, malformed/unknown-schema-version
 *   degradation to defaults with a visible note, a forced rename failure leaving the prior file intact
 *   with the reason surfaced (never silent, never half-written), and the state-exclusion (gitignore)
 *   contract via a REAL git subprocess against a fresh repo scaffolded exactly as `zer0 init` would.
 *   Real fs (mkdtempSync) throughout, mirroring review-mode-store.test.ts's retired precedent — no mocks
 *   on the fs boundary except the one test that specifically forces the rename step to fail.
 * @exports (test suite — no runtime exports)
 * @depends vitest, node:child_process, node:fs, node:os, node:path, ./native-mode, ./native-mode-store
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NativeModeFsOps,
  bootNativeModeState,
  persistNativeMode,
} from "./native-mode-store.js";
import { applyActive, beginCycle, initialNativeModeState } from "./native-mode.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function freshRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-native-mode-store-"));
  return tempRoot;
}

describe("native-mode-store: round-trip persistence", () => {
  it("persists then reads back the exact per-engine choice", () => {
    const root = freshRoot();
    const pending = beginCycle(initialNativeModeState(), "codex");
    const cycled = applyActive(pending, "codex", pending.codex.modeId);
    expect(persistNativeMode(root, cycled)).toEqual({ outcome: "written" });
    const booted = bootNativeModeState(root);
    expect(booted.notice).toBeUndefined();
    expect(booted.state.codex).toEqual({ modeId: "agent", status: "active" });
    // Untouched engines still boot on their catalog default.
    expect(booted.state.claude.modeId).toBe("default");
  });

  it("no file yet -> catalog defaults, no notice (a fresh project has no cycled choice)", () => {
    const root = freshRoot();
    const booted = bootNativeModeState(root);
    expect(booted.notice).toBeUndefined();
    expect(booted.state).toEqual(initialNativeModeState());
  });

  it("overwriting a persisted choice replaces it (rewrite, not append)", () => {
    const root = freshRoot();
    persistNativeMode(root, initialNativeModeState());
    const cycled = beginCycle(initialNativeModeState(), "claude");
    persistNativeMode(root, applyActive(cycled, "claude", cycled.claude.modeId));
    const raw = readFileSync(join(root, ".zer0", "native-mode.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      modes: { claude: "acceptEdits", codex: "read-only", gemini: "auto" },
    });
  });

  it("persists into a repoRoot with no pre-existing .zer0 folder (mkdirSync recursive creates it)", () => {
    const root = freshRoot();
    expect(persistNativeMode(root, initialNativeModeState())).toEqual({ outcome: "written" });
    expect(bootNativeModeState(root).state).toEqual(initialNativeModeState());
  });
});

describe("native-mode-store: malformed / unknown-schema-version degrades to defaults with a VISIBLE note", () => {
  it("malformed JSON -> defaults + a notice (never a throw, never silently discarded)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".zer0"), { recursive: true });
    writeFileSync(join(root, ".zer0", "native-mode.json"), "not json at all", "utf8");
    const booted = bootNativeModeState(root);
    expect(booted.state).toEqual(initialNativeModeState());
    expect(booted.notice).toMatch(/malformed or an unrecognized schema version/);
  });

  it("an unrecognized schema version is treated as malformed, not silently accepted", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".zer0"), { recursive: true });
    writeFileSync(
      join(root, ".zer0", "native-mode.json"),
      JSON.stringify({ version: 2, modes: { claude: "plan", codex: "agent", gemini: "plan" } }),
      "utf8",
    );
    const booted = bootNativeModeState(root);
    expect(booted.state).toEqual(initialNativeModeState());
    expect(booted.notice).toMatch(/malformed or an unrecognized schema version/);
  });

  // B3 (MAX review fix round 1): claude/codex are ACP session engines — a persisted value outside
  // the STATIC MODE_CATALOG (which is only the pre-session fallback) may be exactly what a LIVE
  // session's own advertised catalog includes (e.g. claude's gated "auto"), so it is accepted
  // as-is here and verified live instead (lane-transport.ts's applyRestoredMode + the setMode
  // FAILURE CONTRACT reverts + renders if the bridge actually rejects it). gemini (agy) has no
  // live session/negotiation to verify against — the static catalog is its ONLY authority, so it
  // alone still degrades a stale value to its default.
  it("a stored mode outside the static catalog: claude/codex pass through (verified live), gemini still degrades (no live verification exists)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".zer0"), { recursive: true });
    writeFileSync(
      join(root, ".zer0", "native-mode.json"),
      JSON.stringify({
        version: 1,
        modes: { claude: "auto", codex: "some-removed-preset", gemini: "some-removed-preset" },
      }),
      "utf8",
    );
    const booted = bootNativeModeState(root);
    expect(booted.notice).toBeUndefined(); // the FILE is well-formed v1 — no degrade note needed
    expect(booted.state.claude.modeId).toBe("auto");
    expect(booted.state.codex.modeId).toBe("some-removed-preset");
    expect(booted.state.gemini.modeId).toBe("auto"); // degraded to gemini's own catalog default
  });
});

// D-4 tier-boot fix round 1 NIT (confirming pass finding #2): split into its own describe block to
// stay under the function-length clamp (gate-clamps.mjs, 50 lines) once this case landed — mirrors
// this file's own C6 precedent elsewhere.
describe("native-mode-store: D-4 tier-boot fix — the operator's OWN pre-D-3 upgrade path, pinned exactly", () => {
  // Pins the operator's OWN real upgrade path — a native-mode.json written before D-3's rename
  // carries gemini's old "default" literal, which is no longer in MODE_CATALOG.gemini (now
  // ["auto", "accept-edits", "plan"]) and must degrade to "auto" (gemini's new catalog default) the
  // SAME clean way any other stale value does: no notice (the FILE is still well-formed v1 — only the
  // ONE value is unrecognized), no crash. Distinct from the generic "some-removed-preset" case above:
  // "default" is not an arbitrary unknown string, it is the EXACT pre-rename literal every operator's
  // existing on-disk file carries today.
  it("a pre-D-3 stale file (gemini modeId 'default') boots as 'auto' — no notice, no crash", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".zer0"), { recursive: true });
    writeFileSync(
      join(root, ".zer0", "native-mode.json"),
      JSON.stringify({
        version: 1,
        modes: { claude: "default", codex: "read-only", gemini: "default" },
      }),
      "utf8",
    );
    const booted = bootNativeModeState(root);
    expect(booted.notice).toBeUndefined();
    // claude's OWN "default" is a DIFFERENT, unrelated, still-valid mode id — passes through as-is
    // (B3's live-verified-engines rule), proving the SAME literal string means different things for
    // different engines and only gemini's copy needed the D-3 rename to begin with.
    expect(booted.state.claude.modeId).toBe("default");
    expect(booted.state.gemini.modeId).toBe("auto");
  });
});

describe("native-mode-store: atomic write failure — old file intact, error visible, never half-written", () => {
  it("a rename failure returns {outcome:'failed', reason} and leaves the PRIOR file exactly as it was", () => {
    const root = freshRoot();
    persistNativeMode(root, initialNativeModeState()); // seed a real, valid prior file
    const before = readFileSync(join(root, ".zer0", "native-mode.json"), "utf8");

    const failingRename: NativeModeFsOps["renameSync"] = () => {
      throw new Error("EPERM: simulated rename failure");
    };
    const pendingGemini = beginCycle(initialNativeModeState(), "gemini");
    const cycled = applyActive(pendingGemini, "gemini", pendingGemini.gemini.modeId);
    // Only renameSync is overridden — the write step still hits the REAL disk, so the temp file this
    // forces a failure after is genuinely present (proving persistNativeMode's own cleanup, not a fake).
    const result = persistNativeMode(root, cycled, {
      mkdirSync,
      readFileSync,
      writeFileSync,
      renameSync: failingRename,
    });

    expect(result).toEqual({ outcome: "failed", reason: "EPERM: simulated rename failure" });
    // FALSIFYING: the old file is byte-identical to before the failed attempt — never half-written.
    const after = readFileSync(join(root, ".zer0", "native-mode.json"), "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after)).toEqual({
      version: 1,
      modes: { claude: "default", codex: "read-only", gemini: "auto" },
    });
  });
});

describe("native-mode-store: state-exclusion — git-ignored exactly like the retired review-mode.json", () => {
  it("a project scaffolded by `zer0 init`'s gitignore block ignores .zer0/native-mode.json (real git)", () => {
    const root = freshRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    // Mirrors init-scaffold.ts's GITIGNORE_MARKER + GITIGNORE_BLOCK literal-for-literal (a src/chat test
    // may not import src/cli — no-cli-as-dep — so this is the block's VALUE, not a live import; the
    // production scaffold's OWN test (init-scaffold.test.ts) asserts the block contains this exact path).
    writeFileSync(
      join(root, ".gitignore"),
      [
        "# zer0 runtime (added by zer0 init)",
        ".zer0/evidence.db",
        ".zer0/blobs/",
        ".zer0/native-mode.json",
        "",
      ].join("\n"),
      "utf8",
    );
    persistNativeMode(root, initialNativeModeState());

    const output = execFileSync("git", ["check-ignore", "-v", ".zer0/native-mode.json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(output).toContain(".zer0/native-mode.json");
  });
});
