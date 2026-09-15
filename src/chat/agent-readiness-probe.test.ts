/**
 * @file src/chat/agent-readiness-probe.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./agent-readiness, ./agent-readiness-probe
 * @purpose Slice A sites 2, 4 and 5 — the three probes themselves. The pure record they feed is
 *   contracted separately in agent-readiness.test.ts; this file is about what the probes ASK and what
 *   they are allowed to say afterwards.
 *
 *   The two that matter most are about ABSENCE and about PRIVACY. A probe that could not answer must
 *   render exactly as ready, because a broken instrument is not evidence about an agent; and the
 *   operator's email must not survive anywhere on the signed-in path, including the log lines the
 *   probe writes on its way past.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ReadinessProbeDeps,
  decodeClaudeAuthStatus,
  probeRoomReadiness,
} from "./agent-readiness-probe.js";
import { isUnusable } from "./agent-readiness.js";

// The child_process seam is mocked FILE-WIDE so the hermetic falsifier below can observe a spawn attempt
// DIRECTLY instead of inferring one from the record. Every pre-existing case here injects
// runClaudeAuthStatus, so none of them ever reached the real execFile and none of them change behaviour.
// The mock is hoisted as a bare vi.fn() — vi.mocked(execFile) would drag execFile's overloads into every
// mockImplementation, which is exactly the type-escape this file was once dinged for (h1 review H1-4).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));
beforeEach(() => {
  execFileMock.mockReset();
});

const dirs: string[] = [];
const savedLocalAppData = process.env.LOCALAPPDATA;
afterEach(() => {
  if (savedLocalAppData === undefined) Reflect.deleteProperty(process.env, "LOCALAPPDATA");
  else process.env.LOCALAPPDATA = savedLocalAppData;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The MEASURED signed-in payload from a real `claude auth status` on this machine, identity fields and
 *  all. Kept verbatim so the privacy assertions below are asserting against the real shape and not a
 *  sanitized idea of it. */
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "operator@example.com",
  orgId: "org_01ABCDEF",
  orgName: "Example Org",
  subscriptionType: "max",
});

/** The MEASURED signed-out payload: three keys, exit 1, and NO identity fields at all. */
const SIGNED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
});

function sink(): { readonly lines: string[]; readonly debug: (message: string) => void } {
  const lines: string[] = [];
  return { lines, debug: (message) => lines.push(message) };
}

function deps(overrides: Partial<ReadinessProbeDeps> = {}): ReadinessProbeDeps {
  return {
    sink: sink(),
    resolveClaudeBinary: () => "C:/bundled/claude.exe",
    resolveCodexPackage: () => "C:/bundled/codex/package.json",
    runClaudeAuthStatus: async () => ({ stdout: SIGNED_IN, exitCode: 0 }),
    agyExists: () => true,
    ...overrides,
  };
}

/** Save/restore for ZER0_HERMETIC around one test, so the ambient run is never left hermetic. */
function withHermetic(saved: string | undefined): void {
  if (saved === undefined) Reflect.deleteProperty(process.env, "ZER0_HERMETIC");
  else process.env.ZER0_HERMETIC = saved;
}

/** The deps WITHOUT an injected login runner — the real default runner is the seam under test. */
function hermeticDeps(spy: { readonly debug: (message: string) => void }): ReadinessProbeDeps {
  return {
    sink: spy,
    resolveClaudeBinary: () => "C:/bundled/claude.exe",
    resolveCodexPackage: () => "C:/bundled/codex/package.json",
    agyExists: () => true,
  };
}

/** A bare vi.fn() leaves the probe's promise pending forever; answer like the measured signed-out child
 *  (exit 1, well-formed payload on stdout) so an UNGUARDED run resolves and dies on the assertion
 *  instead of hanging to the timeout. */
function answerLikeClaudeAuthStatus(): void {
  execFileMock.mockImplementation(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      done: (error: null, stdout: string) => void,
    ) => {
      queueMicrotask(() => done(null, SIGNED_OUT));
      return undefined;
    },
  );
}

it("FALSIFIER site 2: a signed-out claude reads as needs sign-in, with the exact command", async () => {
  const readiness = await probeRoomReadiness(
    deps({ runClaudeAuthStatus: async () => ({ stdout: SIGNED_OUT, exitCode: 1 }) }),
  );

  // Exit 1 is the MEASURED signed-out reading and is not a failure — a probe that treated a non-zero
  // exit as "the instrument broke" would report unknown here and render this agent ready.
  expect(readiness.claude).toEqual({ state: "needs_login", command: "claude auth login" });
});

it("FALSIFIER site 4: the login probe never carries identity — not in the record, not in the log", async () => {
  const spy = sink();
  const readiness = await probeRoomReadiness(deps({ sink: spy }));

  expect(readiness.claude).toEqual({ state: "ready" });
  // (a) A PROPERTY OVER THE WHOLE RECORD, not a spot check on a named field. Serializing the record and
  // searching it catches an identity that survived in a field nobody thought to look at.
  const serialized = JSON.stringify(readiness);
  for (const secret of ["operator@example.com", "@", "org_01ABCDEF", "Example Org", "orgName"]) {
    expect(serialized).not.toContain(secret);
  }
  // (b) AND EVERY LINE THE PROBE WROTE, which is the half with teeth. An implementation that logs the
  // raw payload on its way past passes (a) — it is the most natural way to write this defect — and the
  // hard rule is that identity must never reach a log, a trace, the feed, a chip or an error message.
  // A record-only assertion can see exactly one of those five. The sink is injected precisely so a
  // module that can only write where the test is looking has a privacy claim that is checkable.
  const logged = spy.lines.join("\n");
  for (const secret of ["operator@example.com", "@", "org_01ABCDEF", "Example Org", "max"]) {
    expect(logged, `the probe logged ${secret}`).not.toContain(secret);
  }
  // Positive control: the sink IS wired and the probe DOES write to it, so the assertions above are
  // reading a real log rather than an empty array that could never contain anything.
  expect(spy.lines.length).toBeGreaterThan(0);
  expect(logged).toContain("loggedIn=yes");
});

it("FALSIFIER site 5: a missing agy is not usable and says where to get it", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "readiness-no-agy-"));
  dirs.push(empty);
  process.env.LOCALAPPDATA = empty;

  // The real filesystem check, not the injected one: this site's whole subject is that the absence of
  // a file on disk reaches the record.
  const { agyExists: _injected, ...withoutInjection } = deps();
  const readiness = await probeRoomReadiness(withoutInjection);

  expect(readiness.gemini.state).toBe("unusable");
  expect(readiness.gemini).toMatchObject({ remedy: "install the Antigravity CLI" });
});

it("FALSIFIER: a signed-out codex reads as needs sign-in, at zero extra process cost", async () => {
  const readiness = await probeRoomReadiness(deps({ codexLoggedIn: "no" }));

  // The eager ACP open already learned this — the bridge rejects with the SDK's own "Authentication
  // required" and classifyLaneFailure already maps it. The probe spawns nothing for codex.
  expect(readiness.codex).toEqual({ state: "needs_login", command: "codex login" });
});

it("FALSIFIER: gemini has no login probe, so it stays unknown and renders ready", async () => {
  const readiness = await probeRoomReadiness(deps());

  // agy 1.1.16 --help lists no login, no auth and no status subcommand. The honest answer is that we
  // did not ask, and `unknown` renders exactly as ready.
  expect(readiness.gemini).toEqual({ state: "ready" });
  expect(isUnusable(readiness.gemini)).toBe(false);
});

it("FALSIFIER: the REAL resolvers find the REAL binaries this install ships", async () => {
  // ⚠ NO INJECTED RESOLVERS. Every other case here hands the probe a fake one, and a fake one cannot
  // be wrong about where a package lives — which is exactly how the first version of this probe shipped
  // a resolver that reported the operator's working claude as unusable. It resolved
  // @anthropic-ai/claude-agent-sdk from ITS OWN module, and that package is nested under
  // @agentclientprotocol/claude-agent-acp rather than hoisted, so the resolve could never succeed. Two
  // room tests caught it downstream, by failing an explicit @claude submit. This is the assertion that
  // catches it HERE, at the module that owns the mistake.
  const spy = sink();
  const readiness = await probeRoomReadiness({
    sink: spy,
    // The login half is still injected: this site's subject is INSTALL resolution, and spawning the
    // real claude binary would make it a 0.8-second test that depends on the operator's login state.
    runClaudeAuthStatus: async () => ({ stdout: SIGNED_OUT, exitCode: 1 }),
    agyExists: () => false,
  });

  // Both are declared production dependencies and both ship inside this install. If either of these
  // ever legitimately becomes optional, this assertion is the place that says so out loud.
  expect(readiness.claude, "the bundled claude binary did not resolve").toEqual({
    state: "needs_login",
    command: "claude auth login",
  });
  expect(readiness.codex, "the bundled codex package did not resolve").toEqual({ state: "ready" });
});

it("PIN: a probe that throws reports unknown rather than calling the agent broken", async () => {
  const spy = sink();
  const readiness = await probeRoomReadiness(
    deps({
      sink: spy,
      runClaudeAuthStatus: async () => {
        throw new Error("spawn ENOENT C:/bundled/claude.exe");
      },
    }),
  );

  // A probe that timed out is a true statement about OUR INSTRUMENT and says nothing about the agent.
  // The operator watched `◇ gemini offline` and then gemini answered them normally; only a real failed
  // attempt earns offline.
  expect(readiness.claude).toEqual({ state: "unknown" });
  // And the caught error's own text does not reach the log either: a vendor message can carry a path, a
  // token or a payload, and this module's one write path speaks only our words.
  expect(spy.lines.join("\n")).not.toContain("ENOENT");
  expect(spy.lines.join("\n")).toContain("claude readiness probe failed");
});

it("FALSIFIER: an unresolvable claude binary is unusable, and points at the install", async () => {
  const readiness = await probeRoomReadiness(
    deps({
      resolveClaudeBinary: () => {
        throw new Error("cannot find module");
      },
    }),
  );

  expect(readiness.claude).toMatchObject({
    state: "unusable",
    remedy: "npm ci in the m0irai install",
  });
});

it("PIN: an ambiguous auth payload is unknown, never a guess in either direction", () => {
  // The behaviour of an EXPIRED credential is unverified for both CLIs. Guessing would guess in the
  // direction of calling a working agent broken, which is the whole failure mode this slice closes.
  expect(decodeClaudeAuthStatus('{"loggedIn":"true"}')).toBe("unknown");
  expect(decodeClaudeAuthStatus("not json at all")).toBe("unknown");
  expect(decodeClaudeAuthStatus("null")).toBe("unknown");
  expect(decodeClaudeAuthStatus("")).toBe("unknown");
  expect(decodeClaudeAuthStatus(SIGNED_IN)).toBe("yes");
  expect(decodeClaudeAuthStatus(SIGNED_OUT)).toBe("no");
});

it("FALSIFIER: under ZER0_HERMETIC=1 the boot probe creates no agent process and still resolves unknown", async () => {
  const spy = sink();
  const saved = process.env.ZER0_HERMETIC;
  process.env.ZER0_HERMETIC = "1";
  try {
    answerLikeClaudeAuthStatus();
    // No injected runClaudeAuthStatus: this drives the REAL default runner, the closure that reaches
    // execFile — the exact seam a room boot runs on every start.
    const readiness = await probeRoomReadiness(hermeticDeps(spy));

    // Observed DIRECTLY at the child_process seam, not inferred from the record: under hermetic no
    // process may be created, whatever the probe would have gone on to report. This is what the
    // F-review reproduced as a real `claude auth status` writing the operator HOME's first-run file.
    expect(execFileMock).not.toHaveBeenCalled();
    // AND the probe RESOLVES, fail-soft: the refusal is caught by safely() and decodes to `unknown`,
    // which renders exactly as ready (release-polish-wave spec §2.3) — hermetic must not turn a boot
    // into an unhandled rejection or a red chip.
    expect(readiness.claude).toEqual({ state: "unknown" });
    expect(spy.lines.join("\n")).toContain("claude readiness probe failed");
  } finally {
    withHermetic(saved);
  }
});

it("PIN (positive control): without ZER0_HERMETIC the same call DOES reach execFile", async () => {
  // Proves the mock above is wired and that it is THE GUARD, not the harness, stopping the spawn:
  // identical deps minus the env var produce exactly one claude auth status attempt, and its mocked
  // payload still flows through decode into needs_login — so the guard changed nothing else.
  const saved = process.env.ZER0_HERMETIC;
  withHermetic(undefined);
  try {
    answerLikeClaudeAuthStatus();
    const readiness = await probeRoomReadiness(hermeticDeps(sink()));

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["auth", "status"]);
    expect(readiness.claude).toEqual({ state: "needs_login", command: "claude auth login" });
  } finally {
    withHermetic(saved);
  }
});
