/**
 * @file src/shared/child-env.test.ts
 * @purpose Falsifying tests for the env trust boundary (audit DISPATCH-SEC-3): childEnv must
 *   admit only non-secret allowlisted OS keys, never provider API keys or arbitrary parent
 *   secrets. Subscription-first — every provider key is excluded so CLIs use subscription auth.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "./child-env.js";

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;
const TOUCHED_KEYS = [...PROVIDER_KEYS, "SECRET_LEAK_CANARY", "PATH", "CODEX_HOME"] as const;

describe("childEnv (subscription-first env trust boundary)", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED_KEYS) saved.set(key, process.env[key]);
    process.env.PATH = process.env.PATH ?? "/usr/bin";
    for (const key of PROVIDER_KEYS) process.env[key] = `set-${key}`;
    process.env.SECRET_LEAK_CANARY = "leak-me";
  });

  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  });

  it("includes the non-secret OS allowlist (PATH)", () => {
    expect(childEnv().PATH).toBeDefined();
  });

  it("excludes EVERY provider API-key var (subscription-first)", () => {
    const env = childEnv();
    for (const key of PROVIDER_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("excludes arbitrary parent secrets", () => {
    expect(childEnv().SECRET_LEAK_CANARY).toBeUndefined();
  });

  // Trust-bloat isolation seam: the harness's isolated codex home must SURVIVE the allowlist to
  // reach grandchild spawns (zer0 CLI → adapter → codex) — and stay absent when nobody set it.
  it("passes CODEX_HOME through when set and omits it when unset", () => {
    process.env.CODEX_HOME = "C:/tmp/isolated-codex-home";
    expect(childEnv().CODEX_HOME).toBe("C:/tmp/isolated-codex-home");
    delete process.env.CODEX_HOME;
    expect(childEnv().CODEX_HOME).toBeUndefined();
  });
});

// H2 item 2: Windows environment variables are OS-level case-insensitive, so process.env.PATH and
// process.env.Path always resolve to the SAME underlying slot on this box (confirmed live: writing
// process.env.Path here overwrites process.env.PATH — there is no way to make them diverge). Listing
// both spellings in CHILD_ENV_KEYS therefore wrote the identical value into the output object twice,
// under two literal JS property keys — an object shape a case-sensitive consumer could read either way
// of, for no reason. On POSIX this assertion holds trivially (process.env.Path is simply absent).
describe("childEnv (PATH case-spelling, FL-173's mirror case)", () => {
  it("never emits two case-spellings of PATH — one canonical key only", () => {
    const env = childEnv();
    const pathSpellings = Object.keys(env).filter((k) => k.toLowerCase() === "path");
    expect(pathSpellings).toEqual(["PATH"]);
  });
});
