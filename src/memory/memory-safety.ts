/**
 * @file src/memory/memory-safety.ts
 * @purpose Keep transcript control prompts and prompt-injection text out of reusable project memory.
 * @exports isSafeSharedMemoryBody
 * @depends (none)
 */

const UNSAFE_MEMORY_PATTERNS: readonly RegExp[] = [
  /\breal[-_\s]?(?:boot|zer0)\b/iu,
  /\b(?:reply|respond|answer)\s+(?:with\s+)?exactly\b/iu,
  /\b(?:output|return|print|emit)\s+(?:only|exactly)\b/iu,
  /\b(?:do not|don't|never)\s+(?:use|call|invoke)\s+(?:any\s+)?tools?\b/iu,
  /\bskip\s+(?:all\s+)?tools?\b/iu,
  /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+instructions?\b/iu,
];

/**
 * Derived memory is shared across agents and future conversations. Reject bodies that are shaped like
 * transcript-level response controls instead of durable project decisions. The original transcript remains
 * authoritative and untouched; this predicate only governs promotion and prompt re-injection.
 */
export function isSafeSharedMemoryBody(body: string): boolean {
  const normalized = body.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return (
    normalized.length > 0 && !UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
