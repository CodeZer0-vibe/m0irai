/**
 * @file src/chat/boot-liveness.ts
 * @exports BootLivenessResult, resolveBootProjectId, resolveBootLiveness
 * @depends ../evidence/db, ../memory/digest-failsafe, ../memory/project-scope, ./lane-carrier
 * @purpose W3 (THE GREAT DELETION, 2026-07-17) split of review-boot.ts: the pid-verified project
 *   LIVENESS LOCK (THE LIVENESS PROMISE) is a completely separate concern from the 4-stage
 *   write-queue/checkpoint/review-redirect recovery orchestration the rest of review-boot.ts owned
 *   -- it prevents two zer0 processes from colliding on the same repo's carrier/lane state, and has
 *   nothing to do with review/capture. review-boot.ts itself (the recovery orchestrator) is DELETED
 *   with the rest of the capture apparatus; this module is the ONLY part of it that survives,
 *   relocated verbatim. Both of review-boot.ts's real production callers -- chat-tui-boot.ts's
 *   prepareBoot (the ONE resolveBootLiveness call per boot) and loop-boot.ts's runLoopBoot (the
 *   LIVE-RIVAL GUARD, consuming the SAME already-resolved BootLivenessResult by reference, never a
 *   second acquisition) -- now import from here instead.
 *
 * THE LIVENESS PROMISE (unchanged from review-boot.ts's own original design decision): the
 * pid-verified carrier lock's underlying primitive (digest-failsafe.ts's acquireDigestLock, reached
 * via lane-carrier.ts's acquireLaneCarrierLock) is memory-agnostic -- a bare filesystem pid-verified
 * lock keyed on an opaque string. resolveBootProjectId resolves the project id UNCONDITIONALLY
 * (regardless of ZER0_MEMORY; INSERT OR IGNORE into `projects`, a v13 always-applied table);
 * resolveBootLiveness then acquires the SAME acquireLaneCarrierLock primitive unconditionally too.
 * ONE acquisition per boot, no double-lock, no second lock file -- callers thread the result into
 * every consumer that needs to know "is another zer0 process alive for this repo."
 */
import type { Db } from "../evidence/db.js";
import type { DigestLock } from "../memory/digest-failsafe.js";
import { type ProjectScope, resolveProjectId } from "../memory/project-scope.js";
import { acquireLaneCarrierLock } from "./lane-carrier.js";

function ensureProjectRow(
  db: Db,
  scope: Extract<ProjectScope, { kind: "scoped" }>,
  now: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, remote_fingerprint, created_at) VALUES (?,?,?,?,?)",
  ).run(scope.projectId, scope.root, scope.commonDir, scope.remoteFingerprint, now);
}

/**
 * Resolves this repo's project id UNCONDITIONALLY (regardless of ZER0_MEMORY) — see file header's
 * THE LIVENESS PROMISE. Ensures the `projects` row exists (INSERT OR IGNORE, idempotent) so a later
 * FK against it always holds. undefined for a non-git folder (resolveProjectId's own "unscoped" kind)
 * — never a fabricated id.
 */
export async function resolveBootProjectId(db: Db, repoRoot: string): Promise<string | undefined> {
  const scope = await resolveProjectId(repoRoot);
  if (scope.kind !== "scoped") {
    return undefined;
  }
  ensureProjectRow(db, scope, new Date().toISOString());
  return scope.projectId;
}

/** REQUIRED result shape for the unconditional liveness lock — see file header. `isLive` is the
 *  SAME predicate every consumer of a boot-time liveness signal shares. */
export interface BootLivenessResult {
  readonly projectId: string | undefined;
  readonly lock: DigestLock | undefined;
  readonly conflict: boolean;
  readonly isLive: (repoRoot: string) => boolean;
}

function livenessResult(
  projectId: string | undefined,
  lock: DigestLock | undefined,
  conflict: boolean,
): BootLivenessResult {
  // WE hold the lock (no conflict, lock defined) means no rival is alive -> isLive FALSE. Fail-safe
  // default otherwise (a live conflicting holder, OR no lock at all — unresolvable projectId or an
  // indeterminate lock-file read): "assume live, never guess."
  return { projectId, lock, conflict, isLive: () => conflict === true || lock === undefined };
}

/**
 * Resolves the project id and acquires the pid-verified project lock UNCONDITIONALLY (see file
 * header's THE LIVENESS PROMISE) — the ONE acquisition callers thread into every consumer that needs
 * "is another zer0 process alive for this repo" (never a second acquireLaneCarrierLock call, never a
 * second lock file). Callers own releasing `.lock` (mirrors acquireLaneCarrierLock's own
 * caller-releases contract) — this function only acquires.
 */
export async function resolveBootLiveness(
  db: Db,
  repoRoot: string,
  now: number = Date.now(),
): Promise<BootLivenessResult> {
  const projectId = await resolveBootProjectId(db, repoRoot);
  if (projectId === undefined) {
    return livenessResult(undefined, undefined, false);
  }
  const acquired = acquireLaneCarrierLock(repoRoot, projectId, now);
  if (acquired === "conflict") {
    return livenessResult(projectId, undefined, true);
  }
  if (acquired === "no-lock") {
    return livenessResult(projectId, undefined, false);
  }
  return livenessResult(projectId, acquired, false);
}
