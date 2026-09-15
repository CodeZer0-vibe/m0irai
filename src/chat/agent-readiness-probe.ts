/**
 * @file src/chat/agent-readiness-probe.ts
 * @purpose The three boot readiness probes — resolve, spawn, stat — fail-soft and concurrent.
 * @exports ReadinessSink, ReadinessProbeDeps, probeRoomReadiness, decodeClaudeAuthStatus
 * @depends node:child_process, node:fs, node:module, node:path, node:process, ../shared/child-env, ../shared/hermetic, ./agent-readiness, ./types
 *
 * ⚠ THIS MODULE WRITES TO NOTHING BUT ITS INJECTED SINK. No console, no ambient logger, no
 * process.stderr, ever. That is not tidiness — it is what makes the privacy claim below CHECKABLE. A
 * test can only assert "the operator's email never reached a log" if there is exactly one place a log
 * could have been written and the test is holding it.
 *
 * PRIVACY, BINDING. `claude auth status` returns the operator's email address, org id and org name.
 * This module reads `loggedIn` and NOTHING else, and those fields must never reach a log, a trace, the
 * feed, a chip, or an error message. The signed-out payload has no identity fields at all, so the rule
 * binds the signed-IN path specifically — which is exactly the path that is easiest to get right in the
 * record and wrong on the way past it.
 *
 * WHY THREE DIFFERENT PROBES. A uniform probe would have to be the weakest one, and the weakest one
 * here is "no probe at all": three agents, three auth models. claude ships a binary inside m0irai and a
 * real `auth status` subcommand; codex's logged-out state already falls out of the eager ACP open at
 * zero extra cost; gemini's CLI has no login, auth or status subcommand at all (agy 1.1.16 `--help`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { childEnv } from "../shared/child-env.js";
import { assertNotHermetic } from "../shared/hermetic.js";
import type { ProbeOutcome, RoomReadiness } from "./agent-readiness.js";
import { roomReadinessFrom } from "./agent-readiness.js";
import type { AgentName } from "./types.js";

/** The ONLY write path out of this module. Injected so a test can hold every line it produces. */
export interface ReadinessSink {
  readonly debug: (message: string) => void;
}

export interface ReadinessProbeDeps {
  readonly sink: ReadinessSink;
  /** Resolves the claude binary the adapter would actually run; throws when it cannot. */
  readonly resolveClaudeBinary?: () => string;
  /** Resolves the codex package the adapter would actually run; throws when it cannot. */
  readonly resolveCodexPackage?: () => string;
  /** Runs `claude auth status` and returns its stdout plus exit code; rejects only on spawn failure. */
  readonly runClaudeAuthStatus?: (binary: string) => Promise<{
    readonly stdout: string;
    readonly exitCode: number;
  }>;
  readonly agyExists?: () => boolean;
  /** codex's login state as the eager ACP open already learned it — see probeRoomReadiness. */
  readonly codexLoggedIn?: "yes" | "no" | "unknown";
  readonly timeoutMs?: number;
}

const CLAUDE_LOGIN_COMMAND = "claude auth login";
const CODEX_LOGIN_COMMAND = "codex login";
const NPM_CI_REMEDY = "npm ci in the m0irai install";
const AGY_REMEDY = "install the Antigravity CLI";
/** Measured: `claude auth status` is 0.78 s and 0.77 s signed-in on this machine. Four seconds is five
 *  times that, and a probe that exceeds it reports `unknown`, which renders ready. */
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/**
 * Runs all three agents' probes CONCURRENTLY and returns the room's readiness record. Nothing on the
 * boot path may await this — the room paints its first frame without waiting for any probe, and the
 * record it starts from is every agent `unknown`.
 *
 * Never throws. Every leg is individually fail-soft: a probe that errors reports `unknown`, which
 * renders exactly as ready, because a broken instrument is not evidence about an agent.
 */
export async function probeRoomReadiness(deps: ReadinessProbeDeps): Promise<RoomReadiness> {
  const [claude, codex, gemini] = await Promise.all([
    safely(deps, "claude", () => probeClaude(deps)),
    safely(deps, "codex", () => probeCodex(deps)),
    safely(deps, "gemini", () => probeGemini(deps)),
  ]);
  return roomReadinessFrom({ claude, codex, gemini });
}

async function safely(
  deps: ReadinessProbeDeps,
  agent: AgentName,
  probe: () => Promise<ProbeOutcome>,
): Promise<ProbeOutcome> {
  try {
    return await probe();
  } catch (error) {
    // The message is OURS, not the child's: a vendor error string can carry anything, and this line is
    // the one place a probe is allowed to speak. Never the payload, never the caught error's text.
    deps.sink.debug(`${agent} readiness probe failed; reporting unknown`);
    void error;
    return { installed: "unknown", loggedIn: "unknown" };
  }
}

/**
 * claude — install by resolving the SAME binary the adapter resolves, login by asking it.
 *
 * ⚠ `CLAUDE_CODE_EXECUTABLE` IS DELIBERATELY NOT MODELLED, and this comment is here so the next reader
 * does not "fix" it. The adapter does check it first (`acp-agent.js:226-227`, ahead of the SDK-bound
 * resolution at `:233-234`) — but it is NOT on the child-env allowlist (`src/shared/child-env.ts:14-37`)
 * and every adapter spawn pairs that allowlist with `extendEnv:false`, so the adapter CHILD never sees
 * the variable and the branch is unreachable in production. A probe that honoured it would report a
 * binary the room cannot actually run, which is a confident lie — the one failure mode this slice
 * exists to prevent. If a future wave wants the override, the ALLOWLIST is what changes, and the probe
 * follows it, not the reverse.
 */
async function probeClaude(deps: ReadinessProbeDeps): Promise<ProbeOutcome> {
  let binary: string;
  try {
    binary = (deps.resolveClaudeBinary ?? resolveClaudeBinary)();
  } catch {
    return {
      installed: "no",
      loggedIn: "unknown",
      installReason: "the bundled claude binary could not be resolved",
      installRemedy: NPM_CI_REMEDY,
    };
  }
  const run = deps.runClaudeAuthStatus ?? runClaudeAuthStatus(deps.timeoutMs);
  const result = await run(binary);
  const loggedIn = decodeClaudeAuthStatus(result.stdout);
  deps.sink.debug(`claude auth status exit ${result.exitCode}, loggedIn=${loggedIn}`);
  return loggedIn === "no"
    ? { installed: "yes", loggedIn: "no", loginCommand: CLAUDE_LOGIN_COMMAND }
    : { installed: "yes", loggedIn };
}

/**
 * Reads `loggedIn` OUT of claude's auth payload AND NOTHING ELSE.
 *
 * The signed-in payload carries `email`, `orgId`, `orgName` and `subscriptionType`. They are not parsed,
 * not stored, not returned and not logged — the function's whole return type is three strings wide, so
 * there is no field for an identity to survive in even by accident.
 *
 * ⚠ ANYTHING THAT IS NEITHER A CLEAN TRUE NOR A CLEAN FALSE IS `unknown`, WHICH RENDERS READY. The
 * behaviour of an EXPIRED (as opposed to absent) credential is unverified for both CLIs, and a probe
 * that guessed at it would be guessing in the direction of calling a working agent broken.
 */
export function decodeClaudeAuthStatus(stdout: string): "yes" | "no" | "unknown" {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object") return "unknown";
    const loggedIn = (parsed as { readonly loggedIn?: unknown }).loggedIn;
    if (loggedIn === true) return "yes";
    return loggedIn === false ? "no" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * codex — install by resolving its declared production dependency, login for FREE.
 *
 * The eager ACP session open already discovers a logged-out codex: the bridge rejects with the SDK's own
 * "Authentication required", which `classifyLaneFailure` already maps to `needs_auth`
 * (`lane-availability.ts:42-44,62-70`). So `codexLoggedIn` is handed in by the caller that owns that
 * open rather than re-derived by spawning `codex login status` — zero extra process, and no second
 * answer to disagree with the first.
 */
async function probeCodex(deps: ReadinessProbeDeps): Promise<ProbeOutcome> {
  try {
    (deps.resolveCodexPackage ?? resolveCodexPackage)();
  } catch {
    return {
      installed: "no",
      loggedIn: "unknown",
      installReason: "the bundled codex package could not be resolved",
      installRemedy: NPM_CI_REMEDY,
    };
  }
  const loggedIn = deps.codexLoggedIn ?? "unknown";
  return loggedIn === "no"
    ? { installed: "yes", loggedIn: "no", loginCommand: CODEX_LOGIN_COMMAND }
    : { installed: "yes", loggedIn };
}

/**
 * gemini — install by looking for the file, login NOT AT ALL.
 *
 * There is no login probe and there must not be one. agy `1.1.16 --help` lists `agent, agents,
 * changelog, help, install, models, plugin, plugins, update` — no `login`, no `auth`, no `status`. The
 * only thing that could stand in is `agy models`, which needs a ConPTY and budgets 2.5 s idle / 30 s
 * hard (`agy-models-run.ts:16-17`), and a probe timeout misread as agent-down is precisely the defect
 * the operator ruled out on 2026-07-27. So gemini's login stays `unknown`, renders ready, and the first
 * failed send is what decides otherwise, through the path that already does that (`lane-gate.ts`).
 */
async function probeGemini(deps: ReadinessProbeDeps): Promise<ProbeOutcome> {
  const exists = (deps.agyExists ?? agyExists)();
  return exists
    ? { installed: "yes", loggedIn: "unknown" }
    : {
        installed: "no",
        loggedIn: "unknown",
        installReason: "the Antigravity CLI is not installed",
        installRemedy: AGY_REMEDY,
      };
}

/**
 * The adapter's own reachable resolution, minus the unreachable env override. Throws when it fails.
 *
 * ⚠ RESOLVED FROM THE ADAPTER, NOT FROM HERE, and this was caught by the blast-radius run rather than
 * by reasoning. `@anthropic-ai/claude-agent-sdk` is a NESTED dependency of
 * `@agentclientprotocol/claude-agent-acp` and is not hoisted:
 *   node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk
 * A require bound to THIS module cannot see it, so the first version of this function reported the
 * operator's perfectly working claude as `unusable` — a confident lie, and one that also refused an
 * explicit `@claude` submit. Two room tests went red on it.
 *
 * The adapter resolves the SDK from inside its OWN module (`acp-agent.js:233-234`), where the nested
 * copy is visible. Binding the require to the adapter's package.json reproduces that view exactly. The
 * platform binary itself IS hoisted, so only the middle hop was ever wrong — which is why the failure
 * looked like "the whole install is broken" rather than "one resolve root is off".
 */
function resolveClaudeBinary(): string {
  const here = createRequire(import.meta.url);
  const adapter = createRequire(here.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
  const sdk = createRequire(adapter.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const candidate of claudeBinaryCandidates(ext)) {
    try {
      return sdk.resolve(candidate);
    } catch {
      // Try the next variant. The loop's failure is the caller's signal, not this catch's.
    }
  }
  throw new Error("no bundled claude binary variant resolved");
}

/**
 * The adapter's full candidate order, including the linux glibc/musl split. Copied rather than
 * simplified: the adapter's own comment says the wrong binary SEGFAULTS at runtime instead of failing
 * to spawn (`acp-agent.js:235-239`), so a probe that reported the wrong variant would report a binary
 * that cannot run. Ordering is by detected libc, matching the adapter.
 */
function claudeBinaryCandidates(ext: string): readonly string[] {
  const arch = process.arch;
  if (process.platform !== "linux") {
    return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}/claude${ext}`];
  }
  const glibc = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`;
  const musl = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`;
  return isMuslLibc() ? [musl, glibc] : [glibc, musl];
}

// The adapter detects musl by looking for its loader. Same test, same fallback: unknown means glibc,
// which is the majority and the one the adapter itself prefers when it cannot tell.
function isMuslLibc(): boolean {
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

function resolveCodexPackage(): string {
  return createRequire(import.meta.url).resolve("@openai/codex/package.json");
}

function agyExists(): boolean {
  const local = process.env.LOCALAPPDATA;
  if (local === undefined || local === "") return false;
  return existsSync(join(local, "agy", "bin", "agy.exe"));
}

/**
 * Spawns `claude auth status` on the resolved binary. JSON is the DEFAULT output (`--text` is the
 * opt-out), so no format flag is passed. Command and args are separate with the shell disabled, and the
 * environment is the shared subscription-first allowlist — the same one every other spawn in this tree
 * uses, so a probe cannot see a credential var the real lane would not.
 *
 * A non-zero exit is NOT a failure here: the measured signed-out reading is exit 1 with a well-formed
 * payload on stdout. Only stdout and the exit code are read; codex's own isolation run proved stderr
 * carries harness noise that means nothing about auth.
 */
function runClaudeAuthStatus(
  timeoutMs: number | undefined,
): (binary: string) => Promise<{ readonly stdout: string; readonly exitCode: number }> {
  return (binary) => {
    assertNotHermetic("agent-readiness-probe.runClaudeAuthStatus");
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        ["auth", "status"],
        {
          shell: false,
          env: childEnv(),
          timeout: timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          maxBuffer: 1_048_576,
          windowsHide: true,
        },
        (error, stdout) => {
          const code = (error as { readonly code?: unknown } | null)?.code;
          if (error !== null && typeof code !== "number") {
            reject(new Error("claude auth status did not run"));
            return;
          }
          resolve({ stdout, exitCode: typeof code === "number" ? code : 0 });
        },
      );
    });
  };
}
