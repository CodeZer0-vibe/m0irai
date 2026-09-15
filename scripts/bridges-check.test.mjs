/**
 * Falsifiers for scripts/bridges-check.mjs — the mechanism that turns "did we actually take the latest
 * ACP bridge?" into a number instead of a memory.
 *
 * The registry is reached through exactly ONE seam (`fetchLatest`), and every test here injects it, so
 * this file never touches the network and stays in the hermetic unit pool. The seam's real
 * implementation (`latestFromRegistry`, an `npm view` subprocess) is exercised by running
 * `npm run bridges:check` itself, which is not something a unit test may do.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_PACKAGES,
  checkBridges,
  formatJson,
  formatTable,
  pinnedVersions,
} from "./bridges-check.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function lockRoot(packages) {
  const root = await mkdtemp(join(tmpdir(), "zer0-bridges-check-"));
  roots.push(root);
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages }), "utf8");
  return root;
}

const TWO = ["@agentclientprotocol/claude-agent-acp", "@openai/codex"];

describe("pinnedVersions reads the lockfile, and fails loudly rather than guessing", () => {
  it("returns the installed version of every requested package", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.75.1" },
      "node_modules/@openai/codex": { version: "0.153.4" },
    });

    const pinned = await pinnedVersions(root, TWO);

    expect(pinned.get("@agentclientprotocol/claude-agent-acp")).toBe("0.75.1");
    expect(pinned.get("@openai/codex")).toBe("0.153.4");
  });

  it("throws naming the missing lockfile and the next action", async () => {
    const root = await mkdtemp(join(tmpdir(), "zer0-bridges-check-nolock-"));
    roots.push(root);

    await expect(pinnedVersions(root, TWO)).rejects.toThrow(
      /cannot read the lockfile.*npm install/s,
    );
  });

  it("throws naming the package that is absent from the lockfile", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.75.1" },
    });

    await expect(pinnedVersions(root, TWO)).rejects.toThrow(
      /no installed version for @openai\/codex/,
    );
  });

  it("throws on a lockfile with no packages map instead of reporting everything current", async () => {
    const root = await mkdtemp(join(tmpdir(), "zer0-bridges-check-v1lock-"));
    roots.push(root);
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ dependencies: {} }), "utf8");

    await expect(pinnedVersions(root, TWO)).rejects.toThrow(/not an npm v2\+ lockfile/);
  });
});

describe("checkBridges compares each pin against the registry seam", () => {
  it("reports zero stale when every pin equals the latest dist-tag", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.75.1" },
      "node_modules/@openai/codex": { version: "0.153.4" },
    });
    const latest = {
      "@agentclientprotocol/claude-agent-acp": "0.75.1",
      "@openai/codex": "0.153.4",
    };

    const result = await checkBridges({
      root,
      packages: TWO,
      fetchLatest: async (name) => latest[name],
    });

    expect(result.stale).toBe(0);
    expect(result.rows.every((row) => row.stale === false)).toBe(true);
  });

  it("counts a pin that is behind — the exact case the operator hit ('it wasn't the latest ones')", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.63.0" },
      "node_modules/@openai/codex": { version: "0.153.4" },
    });
    const latest = {
      "@agentclientprotocol/claude-agent-acp": "0.75.1",
      "@openai/codex": "0.153.4",
    };

    const result = await checkBridges({
      root,
      packages: TWO,
      fetchLatest: async (name) => latest[name],
    });

    expect(result.stale).toBe(1);
    expect(result.rows.find((row) => row.name === "@openai/codex")?.stale).toBe(false);
    const behind = result.rows.find((row) => row.name === "@agentclientprotocol/claude-agent-acp");
    expect(behind).toMatchObject({ installed: "0.63.0", latest: "0.75.1", stale: true });
  });

  it("asks the registry for every package exactly once, and for no others", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.75.1" },
      "node_modules/@openai/codex": { version: "0.153.4" },
    });
    const asked = [];

    await checkBridges({
      root,
      packages: TWO,
      fetchLatest: async (name) => {
        asked.push(name);
        return "0.0.0";
      },
    });

    expect(asked).toEqual(TWO);
  });

  it("propagates a registry failure instead of reporting a green table", async () => {
    const root = await lockRoot({
      "node_modules/@agentclientprotocol/claude-agent-acp": { version: "0.75.1" },
      "node_modules/@openai/codex": { version: "0.153.4" },
    });

    await expect(
      checkBridges({
        root,
        packages: TWO,
        fetchLatest: async () => {
          throw new Error("registry unreachable");
        },
      }),
    ).rejects.toThrow("registry unreachable");
  });
});

describe("the rendered output", () => {
  const result = {
    rows: [
      {
        name: "@agentclientprotocol/claude-agent-acp",
        installed: "0.63.0",
        latest: "0.75.1",
        stale: true,
      },
      { name: "@openai/codex", installed: "0.153.4", latest: "0.153.4", stale: false },
    ],
    stale: 1,
  };

  it("marks the stale row and states the count", () => {
    const table = formatTable(result);

    expect(table).toMatch(/@agentclientprotocol\/claude-agent-acp\s+0\.63\.0\s+0\.75\.1\s+STALE/);
    expect(table).toMatch(/@openai\/codex\s+0\.153\.4\s+0\.153\.4\s+current/);
    expect(table).toContain("1 STALE");
  });

  it("says 0 stale in words when nothing is behind", () => {
    expect(formatTable({ rows: result.rows.slice(1), stale: 0 })).toContain("0 stale");
  });

  it("--json carries the same rows for the release lane to read", () => {
    expect(JSON.parse(formatJson(result))).toEqual(result);
  });
});

describe("the four bridge pins this repo actually ships", () => {
  it("names exactly the direct bridges — the transitive claude-agent-sdk is the adapter's own pin", () => {
    expect([...BRIDGE_PACKAGES]).toEqual([
      "@agentclientprotocol/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
      "@agentclientprotocol/sdk",
      "@openai/codex",
    ]);
    expect(BRIDGE_PACKAGES).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("each is pinned EXACTLY in package.json and the lockfile agrees", async () => {
    const declared = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ).dependencies;
    const pinned = await pinnedVersions(REPO_ROOT, BRIDGE_PACKAGES);

    for (const name of BRIDGE_PACKAGES) {
      // An exact pin (no range operator) is what makes "equals the latest dist-tag" the whole
      // question — a caret here would silently let a bridge drift between installs.
      expect(declared[name]).toMatch(/^\d+\.\d+\.\d+/);
      expect(pinned.get(name)).toBe(declared[name]);
    }
  });
});
