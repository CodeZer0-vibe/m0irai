/**
 * @file src/chat/pty-session-registry.ts
 * @purpose Process-wide registry of persistent PtySession instances — one live interactive CLI per
 *   {agent}, reused across turns so boot cost is paid once (the parity invariant). Wires the
 *   production seams: a real node-pty child (exe-resolver spec + proven flags + whitelisted env, NO
 *   provider keys) + a BindingReader. In-process only (durable reattach = T4b).
 * @exports getOrSpawnPtySession, disposeAllPtySessions, PROD_TUNING
 * @depends node-pty, ../adapters/pty/exe-resolver, ../shared/child-env, ./pty-binding-reader, ./pty-session, ../shared/hermetic
 */
import * as pty from "node-pty";
import { type PtyAgent, resolveAgentLaunch } from "../adapters/pty/exe-resolver.js";
import { childEnv } from "../shared/child-env.js";
import { assertNotHermetic } from "../shared/hermetic.js";
import { BindingReader } from "./pty-binding-reader.js";
import { type PtyLike, PtySession, type SessionTuning } from "./pty-session.js";
import { writeClaudeStatuslineSettings } from "./statusline-config.js";

/** Production timing (ms). bootMs covers each CLI's slowest cold start; idleCapMs is a NO-OUTPUT hang
 *  watchdog, NOT a total cap — a turn runs as long as the agent keeps producing output (a real build
 *  task can legitimately run for hours); ~15 min of total silence means a genuinely wedged child. */
export const PROD_TUNING: SessionTuning = {
  bootMs: 12_000,
  readyCapMs: 60_000,
  settleMs: 700,
  pollMs: 400,
  stallMs: 12_000,
  idleCapMs: 900_000,
  killGraceMs: 1_000,
  maxPending: 3,
  dismissDelayMs: 400,
};

// Per-agent interactive launch flags (proven in spikes 03/05/08/09; mirrors the prior dispatch-pty).
const AGENT_FLAGS: Record<PtyAgent, readonly string[]> = {
  claude: ["--setting-sources", "", "--permission-mode", "bypassPermissions"],
  codex: [
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=low",
    "--dangerously-bypass-approvals-and-sandbox",
    "--no-alt-screen",
  ],
};

// Env allowlist consolidated to shared/child-env.ts (first-run wave: this local copy silently dropped
// the CODEX_HOME passthrough — codex PTY children escaped test isolation and wrote real ~/.codex trust).

/** One live session per (agent, cwd) — keying by agent alone would reuse a repo-A session in repo B,
 *  whose readers are bound to the wrong cwd (codex P0 #3). Joined with a SPACE (never a raw NUL byte —
 *  a raw NUL here previously made git treat the whole file as binary); agent names are single space-free
 *  tokens, so the key cannot collide across agents regardless of the cwd contents. */
const sessions = new Map<string, PtySession>();

const keyOf = (agent: PtyAgent, cwd: string): string => `${agent} ${cwd}`;

/**
 * Returns the live PtySession for `(agent, cwd)`, spawning it on first use. The real node-pty child
 * is created lazily by PtySession.ensureChild via the injected spawnPty seam; the reader is bound to
 * `cwd` and the session's spawn time so its transcript reads stay session-scoped + rotation-aware.
 */
export function getOrSpawnPtySession(agent: PtyAgent, cwd: string): PtySession {
  const key = keyOf(agent, cwd);
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const spawnMs = Date.now();
  const session = new PtySession(agent, {
    spawnPty: (a) => spawnChild(a, cwd),
    reader: (a, pid) => new BindingReader(a, { cwd, spawnMs, pid }),
    tuning: PROD_TUNING,
  });
  sessions.set(key, session);
  return session;
}

/** Disposes every live session (chat teardown). Idempotent. */
export async function disposeAllPtySessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.dispose()));
}

/** Run the synchronous `fn` with the process cwd temporarily set to `cwd`. node-pty's ConPTY backend on
 *  Windows does NOT reliably honor the `cwd` spawn option — the child can inherit the LAUNCHER's cwd
 *  instead, which made goal-loop claude turns operate on the main repo rather than the build worktree
 *  (silently reviewing the wrong tree). pty.spawn is synchronous, so the cwd is restored before any other
 *  turn runs — no concurrent dispatch can observe the change. */
function withCwd<T>(cwd: string, fn: () => T): T {
  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
  }
}

// claude only: write the cockpit-owned --settings file (statusLine → emit script + per-cwd payload)
// and return the flag. Runs INSIDE spawnChild before pty.spawn (NOT in getOrSpawnPtySession), so the
// settings file provably exists before the child launches; the post-turn reader derives the same path.
function claudeStatuslineArgs(cwd: string): readonly string[] {
  const { settingsPath } = writeClaudeStatuslineSettings(cwd);
  return ["--settings", settingsPath];
}

function spawnChild(agent: PtyAgent, cwd: string): PtyLike {
  assertNotHermetic("pty-session-registry.spawnChild");
  const spec = resolveAgentLaunch(agent);
  const statuslineArgs = agent === "claude" ? claudeStatuslineArgs(cwd) : [];
  const term = withCwd(cwd, () =>
    pty.spawn(spec.cmd, [...spec.args, ...AGENT_FLAGS[agent], ...statuslineArgs], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: childEnv(),
    }),
  );
  return {
    pid: term.pid,
    write: (data) => term.write(data),
    kill: () => term.kill(),
    onData: (cb) => {
      term.onData(cb);
    },
    onExit: (cb) => {
      term.onExit(() => cb());
    },
  };
}
