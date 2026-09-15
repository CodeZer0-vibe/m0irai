/**
 * @file src/memory/file-key.ts
 * @purpose THE canonical repo-relative file key (MT6a-review W1): one normalization shared by the
 *   journal WRITE edge (appendEntry canonicalizes every touchedFiles producer) and the live-request
 *   READ edge (extractRequestFiles), so the router's exact-match intersection can never die on
 *   spelling — backslashes, ./ prefixes, duplicate spellings. Non-file shapes (absolute, drive,
 *   dot-dot, empty, directory) canonicalize to undefined.
 * @exports canonicalRepoRelativeFile, canonicalFileSet
 * @depends (none — pure)
 */

/**
 * Canonicalizes one raw path to the repo-relative slash-form key, or undefined when the shape is
 * not a repo-relative file: absolute (`/x`), drive-prefixed (`C:`), any `.`/`..`/empty segment, a
 * trailing separator (a directory, not a file), or an empty string. Case is PRESERVED (git path
 * identity owns case semantics, never this key).
 */
export function canonicalRepoRelativeFile(raw: string): string | undefined {
  let path = raw.trim().replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || /^[A-Za-z]:/.test(path)) {
    return undefined;
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  return path;
}

/**
 * Canonicalizes a list: each entry through {@link canonicalRepoRelativeFile}, invalid shapes
 * dropped, duplicates (post-canonicalization) removed in first-mention order. Returns undefined
 * when nothing survives — the journal stores NULL, never an empty array.
 */
export function canonicalFileSet(files: readonly string[]): readonly string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    const key = canonicalRepoRelativeFile(raw);
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out.length > 0 ? out : undefined;
}
