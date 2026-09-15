# Module Contract Map — Feature: workspace-trust-gate (UNIT 3A)

**Goal:** Before zer0 chat lets any agent touch a folder, ask the operator — claude-style — "do you
trust this workspace?" Persist the decision OUTSIDE the workspace so it is asked once per folder.

Stack: TypeScript + Ink. Source dir: `src/`. Modules in scope: 3 new + 1 edit.

## Security invariants (the contract — derive code from these)

- **INV-T1 — trust lives outside the workspace it governs.** The trust store is in `~/.zer0/` (homedir),
  NEVER in the workspace. An untrusted repo must not be able to ship a file that pre-authorizes itself.
- **INV-T2 — fail closed.** Missing / unreadable / malformed / wrong-shape trust state ⇒ NOT trusted.
  A corrupt store never bricks launch (no throw) and never auto-trusts (returns false → re-prompt).
- **INV-T3 — trust precedes every agent action IN `zer0 chat`.** In the cockpit launch (`runChatTui`) the
  check runs BEFORE buildMount and BEFORE warm-up (`warmUpAgents` spawns claude+codex; booting an agent reads
  folder content e.g. CLAUDE.md → injection surface). **SCOPE:** 3A gates the `zer0 chat` cockpit ONLY. Other
  agent entry points (`zer0 council`, `zer0 build`, goal-loop) still dispatch agents WITHOUT this gate (codex
  pass-2 finding) — extending the check to them reuses trust-store/trust-flow and is a follow-up DECISION
  (non-interactive invocations skip via the stdin-TTY rule, so scripted council/CI is unaffected).
- **INV-T4 — reject hard-stops.** A "No" exits the launch cleanly; it never falls through to the cockpit.
- **INV-T5 — interactive (stdin-TTY) only.** Trust is enforced whenever `stdin.isTTY` — the operator drives
  turns via raw-mode stdin, so a redirected stdout (`zer0 chat > out.log`) must STILL gate (codex BLOCK #2:
  keying on stdout would skip the gate while stdin can still dispatch a turn). A non-TTY stdin (pipe / file /
  test) cannot drive useInput → no turn dispatches → gate skipped (proceed). Warm-up uses the same stdin axis.

## Modules

| Module (file)                     | Responsibility (ONE sentence)                                                   | Exports (≤2)                             | Trust boundary (must NOT assume)                                                                                                              | Budget | Imports from                     |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------- |
| `cli/commands/trust-store.ts`     | Read/write the global set of trusted workspace paths, fail-closed               | `isWorkspaceTrusted`, `trustWorkspace`   | store path derives from homedir, never the workspace; file may be absent/corrupt → untrusted; repoRoot is resolved to absolute before compare | ≤130   | node:fs, node:os, node:path      |
| `tui/trust-gate.tsx`              | Render the claude-style trust prompt and resolve the operator's yes/no decision | `runTrustGate` (+ `TrustGate` for tests) | renders repoRoot (own value, not agent bytes); never persists; only meaningful under a TTY                                                    | ≤150   | ink, react, ./safe-text          |
| `cli/commands/trust-flow.ts`      | Launch-time orchestration: trusted? → else gate → persist-on-accept             | `ensureWorkspaceTrusted`                 | must be called before any agent spawn; non-TTY ⇒ skip; reject ⇒ false (caller exits)                                                          | ≤90    | ./trust-store, ../tui/trust-gate |
| `cli/commands/chat-tui.ts` (EDIT) | + gate the launch on `ensureWorkspaceTrusted` before buildMount/warm-up         | (unchanged)                              | trust precedes warm-up                                                                                                                        | +~8    | ./trust-flow                     |

Data flow: `runChatTui → ensureWorkspaceTrusted → isWorkspaceTrusted(store) │ runTrustGate(gate) → trustWorkspace(store)`
Deletion test: `rm src/cli/commands/trust-store.ts src/cli/commands/trust-flow.ts src/tui/trust-gate.tsx`
breaks NOTHING except the single `ensureWorkspaceTrusted` call in chat-tui.ts (remove that line → builds).
Dependency direction: `chat-tui (cli) → trust-flow (cli) → { trust-store (cli), trust-gate (tui) }`.
cli→tui is the established direction (chat-tui already imports tui/). trust-store + trust-gate import each
nothing of the other (leaves). No cycle.

## 4-check pass

1. Acyclic — chat-tui → trust-flow → {trust-store, trust-gate}; neither leaf imports back up. ✓
2. Layer-monotonic — cli imports tui (down), never tui→cli. trust-store/trust-gate import only node/ink/leaf. ✓
3. Feature-isolated — no reach into another feature's internals; trust-gate uses the shared `safe-text` leaf. ✓
4. Single source of truth — the trusted-set on disk is owned by trust-store ALONE; nothing else reads/writes it. ✓

## ADR — store location + non-TTY behavior

- **Context:** trust must survive across sessions and cannot be spoofable by the workspace it governs.
- **Decision:** global JSON at `~/.zer0/trusted-workspaces.json` (`{version, trusted: string[]}`, abs paths),
  atomic write (temp+rename, mirrors `agy-statusline-config` writeAtomic). Non-TTY launch skips the gate.
- **Consequence:** matches claude (`~/.claude.json`) + agy (`trustedWorkspaces`) — trust is per-user-per-folder.
- **Open (DECISION, P0 — codex pass-2):** OTHER agent entry points that exist TODAY (`zer0 council`, `zer0
build`, goal-loop) dispatch agents WITHOUT this gate. 3A scopes the gate to `zer0 chat` (the operator's ask).
  Recommendation: extend `ensureWorkspaceTrusted` to those commands in a follow-up (it reuses trust-store +
  trust-flow; the stdin-TTY rule keeps scripted/CI invocations unaffected). Operator decides if/when.
- **Open (DECISION, low):** the "Security guide" link target — no public zer0 docs URL yet (GitHub push pending).
  Shipping the inline safety guidance now; wire the URL when the repo is public.

## Enforcement

Already wired in this repo (no re-install): `gate-clamps.mjs` (file/func line ceilings), `knip` (dead-code /
single-source), `biome` (lint), the PostToolUse file-size hook. The map's budgets sit under all of them.

## Build order (TDD, 3A)

1. `trust-store` (pure fs; RED test with a temp store path → GREEN). 2. `trust-gate` (ink-testing-library:
   1/enter→accept, 2/esc→reject, default highlight). 3. `trust-flow` (injectable isTty/storePath/runGate:
   trusted-skip, non-TTY-skip, accept-persists, reject-false). 4. wire one line into chat-tui. 5. gates + codex.
   3B (next unit): move the `[zer0] not initialized` nudge in-app + `/init` command + first-run polish.
