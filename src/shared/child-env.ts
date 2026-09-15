/**
 * @file src/shared/child-env.ts
 * @purpose Single source of truth for the allowlisted environment handed to spawned agent CLIs. Paired with `extendEnv:false` on every execa call, this is the env trust boundary (audit DISPATCH-SEC-3): the child receives EXACTLY these keys, never the full worker env. Subscription-first: NO provider API keys are forwarded, so every CLI (claude/codex/gemini) authenticates via its on-disk subscription/account login.
 * @exports childEnv
 * @depends (none)
 */

// Non-secret OS/runtime keys every child CLI needs. Includes the Windows path
// family (APPDATA/LOCALAPPDATA/TEMP/TMP) so `extendEnv:false` cannot strip a key
// the CLI requires to locate its config or temp dir. Provider API-key vars
// (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / ...) are
// deliberately ABSENT: forwarding one makes the CLI select per-call API billing
// instead of the operator's subscription login. Subscription-first is the invariant.
const CHILD_ENV_KEYS: readonly string[] = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  // Config-LOCATION passthrough, not a credential: codex resolves ~/.codex from CODEX_HOME when set.
  // Absent unless the operator/harness sets it. The test harness points it at an ISOLATED throwaway
  // home so live codex spawns never write project-trust entries into the operator's real
  // ~/.codex/config.toml (the 877-entry bloat class, measured recurring 2026-07-10) — and it must
  // survive THIS allowlist to reach grandchild spawns (zer0 CLI → adapter → codex).
  "CODEX_HOME",
  // BLOCK 4 (F6 probe): a debug TRACE-FILE PATH, not a credential — the receipted
  // `PATCH(zer0 f6-taskprobe)` instrumentation inside the claude ACP adapter appends its
  // session/turn/task lifecycle rows here. It must survive THIS allowlist or the adapter (which runs in
  // the spawned bridge CHILD) can never see it — the exact reason the first live F6 repro produced a
  // 0-byte trace. Absent unless the operator/harness sets it, so production cost stays zero.
  "ZER0_ADAPTER_TRACE",
];

/**
 * Builds the bounded, subscription-first child environment for a spawned agent CLI.
 *
 * Returns only the non-secret allowlisted OS/runtime keys present in process.env — no
 * provider API keys — so the spawned CLI authenticates via its on-disk subscription
 * login. Pair with `extendEnv:false` on the execa call so the child cannot inherit the
 * full parent env around this allowlist.
 *
 * @returns a record containing only the allowlisted keys present in process.env
 */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows environment variables are case-insensitive at the OS level, so process.env reads for two
  // differently-cased keys can resolve to the SAME underlying slot (verified live: PATH and Path are one
  // slot on this box — child-env.test.ts). Folding on lowercase here means a future duplicate-cased key
  // added to CHILD_ENV_KEYS can never again write two spellings of one value into the child's env.
  const seenFolded = new Set<string>();
  for (const key of CHILD_ENV_KEYS) {
    const folded = key.toLowerCase();
    if (seenFolded.has(folded)) continue;
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
      seenFolded.add(folded);
    }
  }
  return env;
}
