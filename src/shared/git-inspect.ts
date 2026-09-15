/**
 * @file src/shared/git-inspect.ts
 * @purpose THE shared git-inspect owner (G3): ONE home for the git child-env allowlist, the timeout policy,
 *   root canonicalization (resolve + realpath + win32 fold), the own-toplevel guard comparison, and porcelain
 *   (-z) parsing. The in-scope consumers (git-change-summary, project-scope, evidence-capture) keep their own
 *   sync/async git SPAWN but share THESE conventions, so timeouts/env/canonicalization/guard/parser can never
 *   diverge again (structure#4 + trust#8). Pure node:fs/node:path/node:process — never spawns git itself.
 * @exports GIT_INSPECT_ENV, GIT_INSPECT_TIMEOUT_MS, canonicalGitPath, isOwnToplevel, PorcelainKind, PorcelainEntry, parsePorcelainZ
 * @depends node:fs, node:path, node:process
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** git child-env allowlist: GIT_OPTIONAL_LOCKS=0 (no lock-file writes under concurrent lanes), LC_ALL=C
 *  (stable English bytes for prose output). Applied per each consumer's exec mechanism — execFileSync merges
 *  it over process.env explicitly; execa extends process.env by default. Replaces three identical copies. */
export const GIT_INSPECT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

/** ONE git timeout policy (structure#4: the three consumers previously diverged 30/10/15s). Consolidated to
 *  the receipt path's established value; the X3 DEBT test-headroom fix (lower + inject a short timeout for
 *  vitest) lowers this ONE constant globally later — the consolidation is precisely what makes that a one-line
 *  change instead of a three-site hunt. */
export const GIT_INSPECT_TIMEOUT_MS = 30_000;

/**
 * Canonical form of a filesystem path for COMPARISON (the own-toplevel guard; worktree containment): resolve
 * to absolute, dereference symlinks/junctions via realpath on the deepest EXISTING ancestor (re-appending any
 * not-yet-created lexical tail — mirrors worktree-path-guard's canonicalize, matching the operator's own
 * junction setup), then forward-slash + lowercase on win32 (NTFS is case-insensitive; POSIX stays
 * case-sensitive). NOT a hashing convention — project-scope keeps its own normalizePath for the stable
 * projectId (a moved/junctioned path must NOT change the id). A realpath failure falls back to the lexical
 * resolve; never throws.
 */
export function canonicalGitPath(p: string): string {
  return foldCase(realpathDeepest(path.resolve(p)));
}

function realpathDeepest(resolved: string): string {
  let dir = resolved;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      return resolved; // hit the filesystem root with nothing existing — lexical fallback
    }
    tail.unshift(path.basename(dir));
    dir = parent;
  }
  try {
    return tail.length === 0 ? realpathSync(dir) : path.resolve(realpathSync(dir), ...tail);
  } catch {
    return resolved; // realpath failed (permission, race) — lexical fallback, never throw
  }
}

function foldCase(p: string): string {
  const forwardSlashed = p.replace(/\\/g, "/");
  return process.platform === "win32" ? forwardSlashed.toLowerCase() : forwardSlashed;
}

/**
 * The own-toplevel guard's verdict: true iff `toplevel` (a `git rev-parse --show-toplevel` result) canonically
 * EQUALS `repoRoot`. git silently walks UP to an ancestor repo when `repoRoot` is not itself a repo, so a
 * caller must reject a toplevel that is not its own root — the home-dir/ancestor-repo contamination class
 * (structure#1). The git SPAWN stays with each consumer (sync execFileSync vs async execa); this is the pure
 * verdict every consumer shares.
 */
export function isOwnToplevel(toplevel: string, repoRoot: string): boolean {
  return canonicalGitPath(toplevel) === canonicalGitPath(repoRoot);
}

/** The XY-classification of one `git status --porcelain` entry. */
export type PorcelainKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** One parsed `git status --porcelain -z` entry. `path` is the CURRENT on-disk path (the rename TARGET);
 *  `renameFrom` carries the pre-rename path only when kind === "renamed". `deleted` is true when either
 *  status column reads 'D' (no on-disk content left to hash). */
export interface PorcelainEntry {
  readonly x: string;
  readonly y: string;
  readonly path: string;
  readonly deleted: boolean;
  readonly kind: PorcelainKind;
  readonly renameFrom?: string;
}

function classifyXY(x: string, y: string): PorcelainKind {
  if (x === "?" && y === "?") return "untracked";
  if (x === "R" || x === "C" || y === "R" || y === "C") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

/**
 * Parses `git status --porcelain -z` NUL-delimited output into flat entries. `-z` is the robust format: no
 * path quoting/escaping (unlike line-based `--porcelain`, which C-quotes special-char paths), NUL record
 * delimiters (safe for paths containing spaces OR newlines). A rename/copy consumes TWO tokens (`XY NEW\0OLD`
 * — NEW is the current path, OLD the source); every other kind consumes one. The trailing empty token from the
 * final NUL, and any malformed short token, are skipped.
 */
export function parsePorcelainZ(raw: string): PorcelainEntry[] {
  const tokens = raw.split("\0");
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (token.length < 3) {
      i += 1;
      continue;
    }
    const x = token[0] ?? " ";
    const y = token[1] ?? " ";
    const entryPath = token.slice(3);
    const kind = classifyXY(x, y);
    if (kind === "renamed") {
      entries.push({
        x,
        y,
        path: entryPath,
        deleted: false,
        kind,
        renameFrom: tokens[i + 1] ?? "",
      });
      i += 2;
    } else {
      entries.push({ x, y, path: entryPath, deleted: x === "D" || y === "D", kind });
      i += 1;
    }
  }
  return entries;
}
