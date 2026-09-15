/**
 * @file src/adapters/agy-mode-probe-store.ts
 * @purpose W4-R REFIT R3: a GLOBAL (~/.zer0, mirrors trust-store.ts) persisted cache for a completed
 *   agy --mode probe outcome, keyed on binary path + version — a good result survives reboots (re-
 *   probing only on a path/version change; referee FALSIFIED env-construction as the slow-boot cause).
 *   Only supported/unsupported are cache-worthy; probe-failed (a transient stall) is never persisted.
 * @exports AgyProbeCacheEntry, readCachedProbeOutcome, persistProbeOutcome, defaultProbeCachePath
 * @depends node:fs, node:os, node:path, node:process
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const CACHE_VERSION = 1;

/** The cache entry shape: which binary + version this outcome was PROBED against, and the completed
 *  (never probe-failed) outcome itself. */
export interface AgyProbeCacheEntry {
  readonly agyPath: string;
  readonly agyVersion: string;
  readonly outcome: "supported" | "unsupported";
}

interface CacheFileV1 extends AgyProbeCacheEntry {
  readonly version: 1;
}

/** Mirrors trust-store.ts's own INV-T1 precedent: a GLOBAL, homedir-anchored path — the agy binary's
 *  supported-flags fact is a MACHINE property, not a per-project one, so every zer0 project on this
 *  machine shares the SAME cache rather than each re-probing after every reboot. */
export function defaultProbeCachePath(): string {
  return join(homedir(), ".zer0", "agy-mode-probe-cache.json");
}

function readCacheFile(cachePath: string): CacheFileV1 | undefined {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return undefined; // missing file — no cache yet, never a throw
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidCacheShape(parsed)) {
      return parsed;
    }
  } catch {
    // malformed JSON — fall through to "no usable cache"
  }
  return undefined;
}

// STRICT shape validation (mirrors trust-store.ts's own fail-closed INV-T2): a corrupt or foreign-
// shaped file is never partially trusted — the whole entry is discarded, forcing a fresh probe.
function isValidCacheShape(value: unknown): value is CacheFileV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === CACHE_VERSION &&
    typeof v.agyPath === "string" &&
    typeof v.agyVersion === "string" &&
    (v.outcome === "supported" || v.outcome === "unsupported")
  );
}

/** A cached outcome, but ONLY when it was probed against the EXACT SAME binary path + version — a
 *  path change (a different agy install) or a version change (an upgrade) invalidates the cache
 *  implicitly (the stored entry simply no longer matches the key), forcing a fresh probe. Never
 *  throws — a missing/corrupt/mismatched cache all return undefined uniformly. */
export function readCachedProbeOutcome(
  agyPath: string,
  agyVersion: string,
  cachePath: string = defaultProbeCachePath(),
): AgyProbeCacheEntry["outcome"] | undefined {
  const entry = readCacheFile(cachePath);
  if (entry === undefined || entry.agyPath !== agyPath || entry.agyVersion !== agyVersion) {
    return undefined;
  }
  return entry.outcome;
}

/** Atomic write (temp + rename, mirrors trust-store.ts's own writeStore) — a crash mid-write never
 *  leaves a truncated cache; a fresh write always REPLACES (never merges) the prior entry, since only
 *  ONE binary path + version pair is ever meaningful at a time. */
export function persistProbeOutcome(
  agyPath: string,
  agyVersion: string,
  outcome: AgyProbeCacheEntry["outcome"],
  cachePath: string = defaultProbeCachePath(),
): void {
  const entry: CacheFileV1 = { version: CACHE_VERSION, agyPath, agyVersion, outcome };
  mkdirSync(dirname(cachePath), { recursive: true }); // ~/.zer0 may not exist on first run
  const tmp = `${cachePath}.zer0-${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  renameSync(tmp, cachePath);
}
