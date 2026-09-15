/**
 * @file src/evidence/db-identity.ts
 * @purpose W4-R3a RA-1: ONE canonical identity for an evidence DB file, so two spellings of one file can
 *   never read as two different stores. The defect this closes is identity-by-spelling: the carrier holds
 *   whatever string it was booted with (a cwd-relative `.zer0/evidence.db` from loadConfig's DEFAULT_DB_PATH,
 *   config.ts:17) while a caller may hold the absolutised form of the SAME file — a raw `===` then reports
 *   "different store", the writer silently falls back to its own handle, and the message row lands with no
 *   ledger seq minted. Canonicalising is the fix; comparing raw strings anywhere is the bug.
 * @exports canonicalDbIdentity
 * @depends node:fs, node:path, node:process
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The comparable identity of the file `dbPath` names. Absolutised against the CURRENT cwd (the same cwd
 * `openDb` would resolve it against, so a mid-run `process.chdir` legitimately yields a different identity
 * — those really are different files), then realpath'd so a symlink, a junction, or a Windows 8.3 short
 * name all collapse onto the one true path, then case-folded on win32 where the filesystem is itself
 * case-insensitive (`C:\repo` and `c:\Repo` are one file, and only the platform check keeps that from
 * corrupting identity on a case-SENSITIVE POSIX volume).
 *
 * Total: a path whose file does not exist yet is still given a stable identity by realpath'ing its deepest
 * EXISTING ancestor and re-joining the rest — the first writer to a fresh `.zer0/evidence.db` must compare
 * equal to the second, and the file is created only when someone actually opens it.
 */
export function canonicalDbIdentity(dbPath: string): string {
  const absolute = path.resolve(dbPath);
  return foldCase(realpathDeepest(absolute));
}

// realpath resolves only paths that EXIST, so walk up to the deepest existing ancestor, resolve THAT, and
// re-append the segments below it. A path with no existing ancestor at all (a detached drive) falls back to
// the already-absolute input — still stable, still comparable, which is what identity requires.
function realpathDeepest(absolute: string): string {
  const missing: string[] = []; // collected leaf-first; re-joined top-down below
  let current = absolute;
  for (;;) {
    const resolved = tryRealpath(current);
    if (resolved !== undefined) {
      return path.join(resolved, ...[...missing].reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute; // reached the root without resolving anything (e.g. a detached drive)
    }
    missing.push(path.basename(current));
    current = parent;
  }
}

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

function foldCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
