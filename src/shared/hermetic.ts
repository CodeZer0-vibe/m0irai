/**
 * @file src/shared/hermetic.ts
 * @purpose ZER0_HERMETIC=1 — the standalone oracle's switch. Persistence, migrations and digest scheduling stay
 *   exactly as in production; the ONLY effect is that every agent-process spawn (ACP bridge, PTY/ConPTY agent,
 *   agent CLI probe, digest extractor) refuses with one deterministic, test-only error, and eager provider
 *   warm-up never starts. Never set in a real run — read on every call so a test can toggle it. Documented next
 *   to ZER0_DIGEST_FAKE (plan v5 §5). A spawn site that forgets this seam is exactly what the oracle's
 *   "submit under hermetic must be refused" proof exists to catch.
 * @exports HERMETIC_ENV, HermeticSpawnRefused, hermeticEnabled, assertNotHermetic
 * @depends (none)
 */

export const HERMETIC_ENV = "ZER0_HERMETIC";

/** Thrown by {@link assertNotHermetic}; `site` names the spawn seam that refused. */
export class HermeticSpawnRefused extends Error {
  public readonly site: string;
  public constructor(site: string) {
    super(`hermetic mode (${HERMETIC_ENV}=1): refusing to spawn an agent process at ${site}`);
    this.name = "HermeticSpawnRefused";
    this.site = site;
  }
}

/** True only for the exact value "1" — any other value (including "true") is NOT hermetic. */
export function hermeticEnabled(): boolean {
  return process.env[HERMETIC_ENV] === "1";
}

/** Call at every agent-process spawn seam, before the process is created. */
export function assertNotHermetic(site: string): void {
  if (hermeticEnabled()) throw new HermeticSpawnRefused(site);
}
