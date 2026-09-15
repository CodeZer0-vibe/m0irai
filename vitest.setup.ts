/**
 * @file vitest.setup.ts
 * @purpose Global test setup. Pins env-dependent gates so assertions are DETERMINISTIC across
 *          environments (the env-dependent-gate trap):
 *          (1) COLOUR — pins colour output off (FORCE_COLOR=0) so tower-owned chrome styling emits NO ANSI
 *          styling; a dev shell with an ambient FORCE_COLOR=3 (truecolor) would wrap differently-coloured
 *          text in \x1b[38;2;…m reset codes and split literal assertions across colour boundaries. Agent
 *          text is escaped upstream (escapeUntrusted, INV-13), so a leaked raw agent ESC still lands in
 *          rendered text and is still caught by the `not.toContain("\x1b[…")` security assertions. (The
 *          former GLYPHS pin for the Ink glyph resolver left with the TUI, m0irai 3.3.)
 *          (3) ZER0_DEBUG — cleared. The operator's dogfood env persists ZER0_DEBUG=1 at User scope
 *          (2026-07-09); inheriting it flips debug-gated sinks on and fails tests that assert the OFF
 *          baseline (live-hit: logger.test.ts, chat-tui.test.ts under the full suite). The suite's
 *          baseline is UNSET — debug-behavior tests set it explicitly per-test, so both directions stay
 *          deterministic regardless of the shell that launched vitest.
 *          (4) W4-R3a C1/RA-4 — PER-WORKER STORE ISOLATION. HOME/USERPROFILE/ZER0_DB_PATH point at a
 *          throwaway per-worker directory so any product code that re-derives its target from AMBIENT
 *          config or the home dir lands there instead of the operator's real store. This is a FLOOR,
 *          not a substitute for passing identity explicitly: it caught a measured leak where
 *          chat-tui-mount.test.ts's correctly-isolated fixture was defeated by persistSession's own
 *          bare loadConfig() (14,434 junk chat_sessions rows in the dogfood DB, 109 per run).
 *          CODEX_HOME is deliberately NOT touched — tests/setup/codex-home-global.ts owns it and has
 *          already run (globalSetup precedes the fork pool), and overwriting it here would undo that.
 */
import path from "node:path";
import { workerLocalAppData, workerStoreRoot } from "./tests/setup/worker-store-root.js";
// Pin BEFORE any test imports Ink/chalk (setupFiles run first) so chalk reads FORCE_COLOR=0 on init.
process.env.FORCE_COLOR = "0";
// "0" (an OFF sentinel in debug-mode.ts, the ONE reader) — NOT `= undefined`, which Node's env setter
// stringifies to "undefined" and debug-mode would read as ON. biome noDelete bars `delete` here.
process.env.ZER0_DEBUG = "0";

const storeRoot = workerStoreRoot();
// Node's os.homedir() reads USERPROFILE on win32 and HOME on POSIX, fresh on each call (never cached) —
// both are set so the redirect holds on either platform.
process.env.USERPROFILE = storeRoot;
process.env.HOME = storeRoot;
// And the Local AppData inside it. Redirecting USERPROFILE alone left every worker with a profile that
// has no `AppData\Local`, which makes Windows resolve LocalApplicationData to the EMPTY STRING — so a
// child that caches anything per-user writes it RELATIVE to its cwd, i.e. into the repo. That is what put
// an untracked `Microsoft/Windows/PowerShell/ModuleAnalysisCache` in a lane worktree (round-2 F3, RED and
// GREEN both reproduced on demand). workerStoreRoot() creates the subtree; this points the variable at it
// so env readers and the shell-folder API agree, and nothing the suite spawns writes outside the root.
process.env.LOCALAPPDATA = workerLocalAppData(storeRoot);
// shared/config.ts's applyEnvOverrides (:167) is the existing seam — this makes its redirect the
// DEFAULT for the suite instead of something each test must remember to opt into.
process.env.ZER0_DB_PATH = path.join(storeRoot, "evidence.db");
