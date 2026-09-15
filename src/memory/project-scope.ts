/**
 * @file src/memory/project-scope.ts
 * @purpose Derive a stable project_id from canonical git root + git common-dir + remote fingerprint.
 * @exports ProjectScope, resolveProjectId, normalizeRemote
 * @depends execa, node:crypto, node:path, ../shared/git-inspect
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execa } from "execa";
import { GIT_INSPECT_ENV, GIT_INSPECT_TIMEOUT_MS, isOwnToplevel } from "../shared/git-inspect.js";

/**
 * Discriminated union returned by resolveProjectId.
 *
 * `scoped` carries a deterministic projectId that is stable across processes
 * and subdirectory traversals within the same repo.
 * `unscopable` is returned — never thrown — when the path is not inside a git
 * work tree, does not exist, or is otherwise inaccessible.
 */
export type ProjectScope =
  | {
      kind: "scoped";
      projectId: string;
      root: string;
      commonDir: string;
      remoteFingerprint: string;
    }
  | { kind: "unscopable"; reason: string };

/**
 * Normalizes a filesystem path to a stable, platform-independent form for hashing.
 * Converts all backslashes to forward slashes and lowercases a leading Windows
 * drive letter so that `C:/path` and `c:\path` produce identical hash inputs.
 *
 * @param p - raw path from git output or Node.js path.resolve
 * @returns normalized path string
 */
function normalizePath(p: string): string {
  const withForwardSlashes = p.replaceAll("\\", "/");
  if (withForwardSlashes.length >= 2 && /^[A-Za-z]:/u.test(withForwardSlashes)) {
    return `${withForwardSlashes.charAt(0).toLowerCase()}${withForwardSlashes.slice(1)}`;
  }
  return withForwardSlashes;
}

/**
 * Runs a single git sub-command in the given directory.
 * Returns null for any failure — non-zero exit, spawn error (ENOENT), or timeout —
 * so callers can uniformly produce `{ kind: "unscopable" }` without catching.
 *
 * @param args - git arguments (e.g. ["rev-parse", "--show-toplevel"])
 * @param cwd - working directory for the git process
 * @returns trimmed stdout, or null on any failure
 */
async function gitQuery(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await execa("git", args, {
      cwd,
      env: GIT_INSPECT_ENV,
      reject: false,
      shell: false,
      timeout: GIT_INSPECT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout.trim() : null;
  } catch {
    // Spawn errors (ENOENT, ENOTDIR) when cwd does not exist or git is absent.
    return null;
  }
}

/**
 * Normalizes a git remote URL to a stable fingerprint component.
 * Strips a trailing ".git" suffix. For HTTPS URLs, lowercases the hostname.
 * For SSH-style URLs (user@Host:path), lowercases ONLY the host segment (between
 * '@' and ':'); the SSH username and the path are case-sensitive and preserved.
 *
 * @param url - raw remote URL from `git remote get-url origin`
 * @returns normalized URL string
 */
export function normalizeRemote(url: string): string {
  const stripped = url.endsWith(".git") ? url.slice(0, -4) : url;
  try {
    const u = new URL(stripped);
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    // SSH-style (e.g. User@GitHub.COM:Org/Repo) — lowercase ONLY the host segment.
    const colonIdx = stripped.indexOf(":");
    if (colonIdx === -1) return stripped.toLowerCase();
    const authority = stripped.slice(0, colonIdx);
    const rest = stripped.slice(colonIdx);
    const atIdx = authority.lastIndexOf("@");
    if (atIdx === -1) return `${authority.toLowerCase()}${rest}`;
    return `${authority.slice(0, atIdx + 1)}${authority.slice(atIdx + 1).toLowerCase()}${rest}`;
  }
}

/**
 * Fetches and normalizes the origin remote URL for the canonical repo root.
 *
 * @param root - canonical repo root path
 * @returns normalized remote URL, or empty string when no remote is configured
 */
async function fetchRemoteFingerprint(root: string): Promise<string> {
  const raw = await gitQuery(["remote", "get-url", "origin"], root);
  return raw === null ? "" : normalizeRemote(raw);
}

/**
 * Hashes the normalized (root, commonDir, remoteFingerprint) tuple into a stable
 * project_id using the full SHA-256 digest. normalizePath is applied to both path
 * components before hashing so Windows drive-letter case and separator differences
 * produce identical ids.
 *
 * @param root - canonical repo root (git --show-toplevel), already normalized
 * @param commonDir - git common directory, already normalized
 * @param remoteFingerprint - normalized origin URL, or empty string
 * @returns full 64-char hex SHA-256 digest
 */
function hashTuple(root: string, commonDir: string, remoteFingerprint: string): string {
  return createHash("sha256").update(`${root}\0${commonDir}\0${remoteFingerprint}`).digest("hex");
}

/**
 * Derives a stable project scope from the git working tree that contains `cwd`.
 *
 * G2 OWN-TOPLEVEL GUARD: `cwd` MUST be its OWN git toplevel. A `cwd` whose git root resolves to an
 * ANCESTOR repo (a non-repo project folder sitting under an unrelated repo — the home-dir/temp-dir
 * contamination class) is REFUSED as `unscopable`, never bound to the ancestor's id. Every production caller
 * passes the project's own repo root, whose toplevel is itself. The `projectId` is deterministic across
 * processes for the same root. Two independent clones of the same remote produce DIFFERENT ids because the
 * canonical root path is part of the identity tuple — the remote URL is a fingerprint input, not the anchor.
 *
 * Linked worktrees yield a DISTINCT id (the worktree root differs from the main repo root); always resolve
 * from the main repo path for project-scoped ledger rows. A moved repo root also yields a new id; alias
 * reconciliation is a persistence-layer concern handled by a later task, not this pure module.
 *
 * Returns `{ kind: "unscopable" }` — never throws — when `cwd` is not inside a git work tree, is not its own
 * git toplevel (ancestor-repo guard), does not exist, or when git cannot be invoked.
 *
 * @param cwd - the project's OWN repo root whose project identity to resolve
 * @returns ProjectScope discriminated union
 * @throws never — spawn errors, non-git paths, and ancestor-only toplevels all return `{ kind: "unscopable" }`
 * @example
 * const scope = await resolveProjectId("/path/to/repo");
 * if (scope.kind === "scoped") console.log(scope.projectId);
 */
export async function resolveProjectId(cwd: string): Promise<ProjectScope> {
  const rawRoot = await gitQuery(["rev-parse", "--show-toplevel"], cwd);
  if (rawRoot === null) {
    return { kind: "unscopable", reason: `${cwd} is not inside a git work tree or does not exist` };
  }

  // G2 OWN-TOPLEVEL GUARD (structure#1): git silently walks UP to an ancestor repo when `cwd` is not itself
  // a repo root, so a non-repo folder sitting under an unrelated ancestor repo would otherwise bind its
  // memory/evidence to the ANCESTOR's project id — the known home-dir/temp-dir contamination class. Refuse a
  // toplevel that is not `cwd`'s own (canonical comparison via the shared owner). Every production caller
  // passes the project's own repo root, whose toplevel IS itself, so this scopes them unchanged; only an
  // ancestor-inherited toplevel is refused.
  if (!isOwnToplevel(rawRoot, cwd)) {
    return {
      kind: "unscopable",
      reason: `${cwd} is not its own git toplevel — its git root resolves to an ancestor repo (${rawRoot})`,
    };
  }

  const rawCommonDir = await gitQuery(["rev-parse", "--git-common-dir"], cwd);
  if (rawCommonDir === null) {
    return { kind: "unscopable", reason: `could not resolve --git-common-dir in ${cwd}` };
  }

  // --git-common-dir is relative to the cwd used in the git call (not to root).
  // From a subdir "nested/", git returns "../.git". Resolve against cwd, not root.
  // When git returns an absolute path (linked worktree), resolve() is a no-op.
  const root = normalizePath(rawRoot);
  const commonDir = normalizePath(resolve(cwd, rawCommonDir));
  const remoteFingerprint = await fetchRemoteFingerprint(rawRoot);
  const projectId = hashTuple(root, commonDir, remoteFingerprint);

  return { kind: "scoped", projectId, root, commonDir, remoteFingerprint };
}
