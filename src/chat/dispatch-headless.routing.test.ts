/**
 * @file src/chat/dispatch-headless.routing.test.ts
 * @purpose Falsifying contract for transport routing: claude AND codex reach ACP by DEFAULT (native skills +
 *          live streaming over their subscription, via the clean config). ZER0_ACP=0 opts OUT to the proven
 *          pty path (claude unconditional — `claude -p` is API-credit billed; codex pty with a
 *          ZER0_CODEX_NO_PTY=1 registry escape for a wedged session). gemini ALWAYS routes through the
 *          registry — no ACP adapter (Google #31); the agy adapter drives its own ConPTY (gemini-cli retired).
 *          Module-level mocks isolate the seam, so this lives apart from dispatch-headless.test.ts.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./dispatch-headless, ./dispatch-pty, ../adapters/registry
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentInput } from "../adapters/types.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";

const ptyCalls: string[] = [];
const registryCalls: string[] = [];
const acpCalls: string[] = [];

vi.mock("./dispatch-pty.js", () => ({
  dispatchPty: (input: AgentInput) => {
    ptyCalls.push(input.agent);
    return Promise.resolve({ exitCode: 0, stdout: "pty" });
  },
}));

vi.mock("./dispatch-acp.js", () => ({
  acpTransportEnabled: () => process.env.ZER0_ACP !== "0",
  dispatchAcpHeadless: (input: AgentInput) => {
    acpCalls.push(input.agent);
    return Promise.resolve({ exitCode: 0, stdout: "acp" });
  },
}));

vi.mock("../adapters/registry.js", () => ({
  AdapterRegistry: class {
    public dispatch(input: AgentInput): Promise<{ exitCode: number; stdout: string }> {
      registryCalls.push(input.agent);
      return Promise.resolve({ exitCode: 0, stdout: "registry" });
    }
  },
}));

const ENV_KEYS = ["ZER0_CODEX_NO_PTY", "ZER0_ACP"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  ptyCalls.length = 0;
  registryCalls.length = 0;
  acpCalls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function input(agent: "claude" | "codex" | "gemini"): AgentInput {
  return {
    agent,
    contextFile: "context.md",
    signal: new AbortController().signal,
    worktreePath: "C:/worktree",
    grant: CHAT_GRANT,
  };
}

function readOnlyInput(agent: "claude" | "codex" | "gemini"): AgentInput {
  const { grant: _grant, ...readOnly } = input(agent);
  return readOnly;
}

it("grantless review lanes use isolated safe transports and never persistent PTY", async () => {
  const { dispatchHeadless } = await import("./dispatch-headless.js");
  await dispatchHeadless(readOnlyInput("claude"));
  await dispatchHeadless(readOnlyInput("codex"));
  await dispatchHeadless(readOnlyInput("gemini"));
  expect(acpCalls).toEqual(["claude", "codex"]);
  expect(ptyCalls).toEqual([]);
  expect(registryCalls).toEqual(["gemini"]);
});

it("by DEFAULT (ZER0_ACP unset) claude + codex route to the ACP transport; gemini to the registry", async () => {
  const { dispatchHeadless } = await import("./dispatch-headless.js");
  const result = await dispatchHeadless(input("claude"));
  await dispatchHeadless(input("codex"));
  await dispatchHeadless(input("gemini"));
  expect(result.stdout).toBe("acp"); // ACP is the DEFAULT transport now (native skills + live streaming)
  expect(acpCalls).toEqual(["claude", "codex"]);
  expect(ptyCalls).toEqual([]);
  expect(registryCalls).toEqual(["gemini"]); // gemini has no ACP adapter (Google #31)
});

it("gemini NEVER routes to ACP or the pty — ALWAYS the registry (even with ACP default-on)", async () => {
  const { dispatchHeadless } = await import("./dispatch-headless.js");
  await dispatchHeadless(input("gemini"));
  // FALSIFYING: gemini must never reach ACP or the PtySession path (the retired gemini-cli regression).
  expect(acpCalls).toEqual([]);
  expect(ptyCalls).toEqual([]);
  expect(registryCalls).toEqual(["gemini"]);
});

it("ZER0_ACP=0 opts OUT: claude + codex ride the pty; gemini stays on the registry", async () => {
  process.env.ZER0_ACP = "0";
  const { dispatchHeadless } = await import("./dispatch-headless.js");
  const result = await dispatchHeadless(input("claude"));
  await dispatchHeadless(input("codex"));
  await dispatchHeadless(input("gemini"));
  // the escape hatch falls back to the proven pty/registry path — NO ACP.
  expect(result.stdout).toBe("pty");
  expect(acpCalls).toEqual([]);
  expect(ptyCalls).toEqual(["claude", "codex"]);
  expect(registryCalls).toEqual(["gemini"]);
});

it("ZER0_ACP=0 + ZER0_CODEX_NO_PTY=1: codex falls back to the registry; claude still pty; gemini registry", async () => {
  process.env.ZER0_ACP = "0";
  process.env.ZER0_CODEX_NO_PTY = "1";
  const { dispatchHeadless } = await import("./dispatch-headless.js");
  await dispatchHeadless(input("claude"));
  await dispatchHeadless(input("codex"));
  await dispatchHeadless(input("gemini"));
  // FALSIFYING: only codex falls back to the registry; claude must NOT, and gemini is ALWAYS registry.
  expect(acpCalls).toEqual([]);
  expect(ptyCalls).toEqual(["claude"]);
  expect(registryCalls).toEqual(["codex", "gemini"]);
});
