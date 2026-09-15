/**
 * @file src/chat/native-mode-store.ts
 * @purpose D4's ONLY read/write of `.zer0/native-mode.json` — the per-project persisted per-engine mode
 *   choice. Schema-versioned ({version:1, modes:{claude,codex,gemini}}), atomic write (temp file +
 *   rename, the SAME idiom every .zer0-owned config file uses), malformed/unknown-version degrades to
 *   catalog defaults with a VISIBLE boot note, a rename failure leaves the prior file intact. Git-ignored
 *   via init-scaffold.ts's GITIGNORE_BLOCK.
 * @exports NativeModeFsOps, PersistNativeModeResult, bootNativeModeState, persistNativeMode
 * @depends node:fs, node:path, ../shared/atomic-write, ./native-mode, ./types
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../shared/atomic-write.js";
import { MODE_CATALOG, type NativeModeState, initialNativeModeState } from "./native-mode.js";
import type { AgentName } from "./types.js";

const SCHEMA_VERSION = 1;
const ENGINES: readonly AgentName[] = ["claude", "codex", "gemini"];

interface PersistedFileV1 {
  readonly version?: unknown;
  readonly modes?: unknown;
}

interface PersistedFileWrite {
  readonly version: 1;
  readonly modes: Readonly<Record<AgentName, string>>;
}

/** Injectable fs seam (tests only) — defaults to real node:fs so production always hits the real disk;
 *  a test overrides `renameSync` to force the "rename throws" failure contract deterministically. */
export interface NativeModeFsOps {
  readonly mkdirSync: typeof mkdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly renameSync: typeof renameSync;
}

const REAL_FS: NativeModeFsOps = { mkdirSync, readFileSync, writeFileSync, renameSync };

function persistedFilePath(repoRoot: string): string {
  return join(repoRoot, ".zer0", "native-mode.json");
}

// Validates the persisted `modes` object entry-by-entry: a malformed/missing value degrades that ONE
// engine to its catalog default rather than invalidating the whole file — the other engines' valid
// choices still load.
function validatedModes(raw: unknown): Readonly<Record<AgentName, string>> | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const engine of ENGINES) {
    result[engine] = validatedModeFor(engine, record[engine]);
  }
  return result as Readonly<Record<AgentName, string>>;
}

// B3 (MAX review fix round 1): claude/codex accept ANY non-empty string here — MODE_CATALOG is only
// the PRE-SESSION fallback (a session's real catalog may legitimately include an entry this static
// list excludes, e.g. claude's gated "auto"); a genuinely bogus persisted value still degrades safely,
// just LIVE — lane-transport.ts's applyRestoredMode calls setMode with it, and the FAILURE CONTRACT
// reverts + renders on a bridge rejection. gemini (agy) has NO live negotiation or rejection safety
// net (a one-shot process per turn, not a session) — a bogus value would reach the real binary's argv
// unchecked, so it STAYS validated against the static catalog, the only authority agy ever gets.
function validatedModeFor(engine: AgentName, value: unknown): string {
  const catalog = MODE_CATALOG[engine];
  if (engine === "gemini") {
    return typeof value === "string" && (catalog as readonly string[]).includes(value)
      ? value
      : (catalog[0] ?? "default");
  }
  return typeof value === "string" && value.length > 0 ? value : (catalog[0] ?? "default");
}

function parsePersisted(raw: string): Readonly<Record<AgentName, string>> | undefined {
  const parsed = JSON.parse(raw) as PersistedFileV1;
  if (parsed.version !== SCHEMA_VERSION) {
    return undefined; // unknown/absent schema version -> treated as malformed (never silently accepted)
  }
  return validatedModes(parsed.modes);
}

/**
 * Resolves the boot-time native-mode state for `repoRoot`: the persisted choice when the file parses
 * cleanly under schema v1, or catalog defaults with a VISIBLE note when the file is absent (normal, no
 * note), malformed, or an unrecognized schema version (both degrade with a note — the transparency
 * charter: a corrupted internal-state file is never silently reinterpreted as "no choice yet").
 *
 * W4-R2f RA-2: `persisted` is the flag the RESUME restore needs and could not previously ask for —
 * "did the OPERATOR ever choose, or is this just the catalog default?" The two cases were
 * indistinguishable in the returned state (a fresh project and a project whose operator deliberately
 * picked `default` produce byte-identical NativeModeState), and lane-hold.ts's restore has to tell
 * them apart to know whose value outranks the session's own. File-level, not per-engine, because
 * persistNativeMode writes all three engines on every write — a file that exists at all is the
 * operator's, whole.
 */
export function bootNativeModeState(repoRoot: string): {
  readonly state: NativeModeState;
  readonly persisted: boolean;
  readonly notice?: string;
} {
  const filePath = persistedFilePath(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { state: initialNativeModeState(), persisted: false }; // no file yet — normal, unlogged
  }
  try {
    const modes = parsePersisted(raw);
    if (modes !== undefined) {
      return { state: stateFromModes(modes), persisted: true };
    }
  } catch {
    // falls through to the malformed note below — a JSON parse error and a well-formed-but-invalid
    // schema are the same class of problem here (this file is write-exclusive to persistNativeMode).
  }
  return {
    state: initialNativeModeState(),
    // A file we cannot read is NOT an operator choice — the restore must fall back to the session's
    // own ground truth rather than push a catalog default nobody picked over it.
    persisted: false,
    notice: `[native-mode] ${filePath} is malformed or an unrecognized schema version — using defaults.`,
  };
}

function stateFromModes(modes: Readonly<Record<AgentName, string>>): NativeModeState {
  return {
    claude: { modeId: modes.claude, status: "active" },
    codex: { modeId: modes.codex, status: "active" },
    gemini: { modeId: modes.gemini, status: "active" },
  };
}

export type PersistNativeModeResult =
  | { readonly outcome: "written" }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Atomically persists the current per-engine mode choice (temp file + rename). FAILURE CONTRACT: if
 * either the temp write or the rename throws, the PRIOR file (if any) is untouched — the atomic-rename
 * pattern itself guarantees that, since nothing ever writes `filePath` directly — and the reason is
 * returned (never thrown, never silently dropped) so the caller can render a visible note. A leftover
 * temp file from a failed rename is best-effort cleaned up; a cleanup failure never masks the original.
 */
export function persistNativeMode(
  repoRoot: string,
  state: NativeModeState,
  fsOps: NativeModeFsOps = REAL_FS,
): PersistNativeModeResult {
  // The replace itself lives in src/shared/atomic-write.ts — this was the fourth hand-written copy of
  // one temp-then-rename idiom, and the transcript's copy was the one that had the tearing bug.
  return writeFileAtomicSync(
    persistedFilePath(repoRoot),
    `${JSON.stringify(persistedShape(state), null, 2)}\n`,
    { ensureDirectory: true, fs: fsOps },
  );
}

function persistedShape(state: NativeModeState): PersistedFileWrite {
  return {
    version: SCHEMA_VERSION,
    modes: {
      claude: state.claude.modeId,
      codex: state.codex.modeId,
      gemini: state.gemini.modeId,
    },
  };
}
