/**
 * @file src/chat/agy-statusline-config.test.ts
 * @purpose Falsifiers for the agy statusLine config writer: it MERGES the statusLine key into an existing
 *   settings.json WITHOUT clobbering other keys, writes an UNQUOTED command (agy's no-shell split), and is
 *   idempotent. Uses a temp settings file so the operator's real ~/.gemini config is never touched.
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./agy-statusline-config
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoWhitespace, writeAgyStatuslineSettings } from "./agy-statusline-config.js";

type AgySettings = {
  trustedWorkspaces?: readonly string[];
  general?: { defaultApprovalMode?: string };
  statusLine?: { type?: string; enabled?: boolean; command?: string };
  keep?: number;
};

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readBack(settingsPath: string): AgySettings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as AgySettings;
}

describe("writeAgyStatuslineSettings", () => {
  it("MERGES statusLine into existing settings without clobbering other keys", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        trustedWorkspaces: ["C:/repo"],
        general: { defaultApprovalMode: "auto_edit" },
      }),
      "utf8",
    );
    writeAgyStatuslineSettings(settingsPath);
    const after = readBack(settingsPath);
    expect(after.trustedWorkspaces).toEqual(["C:/repo"]); // preserved
    expect(after.general?.defaultApprovalMode).toBe("auto_edit"); // preserved
    expect(after.statusLine?.type).toBe("command");
    expect(after.statusLine?.enabled).toBe(true);
  });

  it("writes an UNQUOTED command pointing at the cockpit payload (agy splits without a shell)", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    const { emitScriptPath, payloadPath } = writeAgyStatuslineSettings(settingsPath);
    const after = readBack(settingsPath);
    expect(after.statusLine?.command).not.toContain('"'); // no quotes around the paths
    expect(after.statusLine?.command).toContain(payloadPath); // points at the cockpit payload
    expect(after.statusLine?.command).toContain(emitScriptPath);
    expect(after.statusLine?.command?.startsWith("node ")).toBe(true);
    expect(existsSync(emitScriptPath)).toBe(true);
  });

  it("is idempotent — re-running keeps other keys and one enabled statusLine", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ keep: 1 }), "utf8");
    writeAgyStatuslineSettings(settingsPath);
    writeAgyStatuslineSettings(settingsPath);
    const after = readBack(settingsPath);
    expect(after.keep).toBe(1);
    expect(after.statusLine?.enabled).toBe(true);
  });
});

describe("writeAgyStatuslineSettings refuses to clobber the operator's global settings (codex B2)", () => {
  it("THROWS and leaves the file untouched when existing settings are malformed JSON (no clobber)", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    const malformedJson = "\u007bnot valid json";
    writeFileSync(settingsPath, malformedJson, "utf8");
    expect(() => writeAgyStatuslineSettings(settingsPath)).toThrow();
    expect(readFileSync(settingsPath, "utf8")).toBe(malformedJson); // operator's file survives intact
  });

  it("THROWS when existing settings are a JSON array, not an object", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "[1,2,3]", "utf8");
    expect(() => writeAgyStatuslineSettings(settingsPath)).toThrow(/not a JSON object/i);
  });

  it("refuses a whitespace statusline directory without altering valid operator settings", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    const previousDir = process.env.ZER0_STATUSLINE_DIR;
    process.env.ZER0_STATUSLINE_DIR = join(dir, "unsafe directory");
    writeFileSync(settingsPath, JSON.stringify({ keep: 1 }), "utf8");
    try {
      expect(() => writeAgyStatuslineSettings(settingsPath)).toThrow(/whitespace/i);
      expect(readBack(settingsPath)).toEqual({ keep: 1 });
    } finally {
      if (previousDir === undefined) delete process.env.ZER0_STATUSLINE_DIR;
      else process.env.ZER0_STATUSLINE_DIR = previousDir;
    }
  });
});

describe("writeAgyStatuslineSettings preserves a non-Zer0 statusLine", () => {
  it("refuses to overwrite a valid non-Zer0 statusLine or stage its emitter", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    const original = {
      keep: 1,
      statusLine: { type: "command", command: "node my-status.js", enabled: true },
    };
    writeFileSync(settingsPath, JSON.stringify(original), "utf8");
    const paths = writeAgyStatuslineSettings;
    expect(() => paths(settingsPath)).toThrow(/non-Zer0 statusLine/i);
    expect(readBack(settingsPath)).toEqual(original);
  });
});

describe("writeAgyStatuslineSettings serializes and compare-swaps global settings", () => {
  it("treats only ENOENT as missing and never replaces an unreadable settings target", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    mkdirSync(settingsPath);
    expect(() => writeAgyStatuslineSettings(settingsPath)).toThrow();
    expect(() => readFileSync(settingsPath, "utf8")).toThrow();
  });

  it("refuses an operator edit that races the read-to-commit window", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ keep: 1 }), "utf8");
    expect(() =>
      writeAgyStatuslineSettings(settingsPath, {
        beforeCommit: () => writeFileSync(settingsPath, JSON.stringify({ keep: 2 }), "utf8"),
      }),
    ).toThrow(/changed during Zer0 configuration/i);
    expect(readBack(settingsPath)).toEqual({ keep: 2 });
  });

  it("fails closed on a live sibling lock and releases its own lock after failure", () => {
    dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
    const settingsPath = join(dir, "settings.json");
    const lockPath = `${settingsPath}.zer0.lock`;
    writeFileSync(settingsPath, JSON.stringify({ keep: 1 }), "utf8");
    writeFileSync(
      lockPath,
      JSON.stringify({ token: "sibling", pid: 123, expiresAt: Date.now() + 30_000 }),
      "utf8",
    );
    expect(() => writeAgyStatuslineSettings(settingsPath)).toThrow(/another Zer0 process/i);
    rmSync(lockPath);
    expect(() =>
      writeAgyStatuslineSettings(settingsPath, {
        beforeCommit: () => {
          throw new Error("injected write failure");
        },
      }),
    ).toThrow(/injected write failure/i);
    expect(existsSync(lockPath)).toBe(false);
    expect(() => writeAgyStatuslineSettings(settingsPath)).not.toThrow();
  });
});

describe("assertNoWhitespace (codex B1 — agy splits its command without a shell)", () => {
  it("throws on a whitespace path and passes on a clean one", () => {
    expect(() => assertNoWhitespace("C:/Users/First Last/emit.cjs", "p")).toThrow(/whitespace/i);
    expect(() => assertNoWhitespace("C:/Users/mianc/emit.cjs", "p")).not.toThrow();
  });
});
