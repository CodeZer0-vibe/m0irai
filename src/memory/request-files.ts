/**
 * @file src/memory/request-files.ts
 * @purpose Extract repo-relative file paths from live operator text — the requestFiles input the
 *   MT6a router intersects with journal touchedFiles. Conservative: letter-led extensions only;
 *   ROOT-LEVEL files (package.json) match too (MT6a-review W0 — the old pattern demanded a slash,
 *   so root files never pulled). Validation delegates to the shared canonical file key
 *   (file-key.ts) — the SAME normalization the journal write edge applies (review W1).
 * @exports extractRequestFiles, MAX_REQUEST_FILES
 * @depends ./file-key
 */
import { canonicalRepoRelativeFile } from "./file-key.js";

export const MAX_REQUEST_FILES = 16;

// A repo-relative path: zero or more segments then a filename with a LETTER-LED extension, slash
// separators (matches the repo's real naming; digit extensions like "v0.21" stay prose). Root-level
// files (no slash) match — false positives are harmless (they intersect nothing) and bounded by
// MAX_REQUEST_FILES. A leading boundary keeps prose intact.
const PATH_PATTERN = /(?:^|[\s"'`(\[<])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*)/g;

/**
 * Pulls candidate repo-relative paths out of free operator text, deduped in first-mention order,
 * capped at {@link MAX_REQUEST_FILES}. Windows-style separators are normalized to slashes BEFORE
 * matching so `src\chat\a.ts` and `src/chat/a.ts` extract identically; `..` segments, absolute and
 * drive-prefixed shapes never survive the canonical key (the file-key.ts contract).
 */
export function extractRequestFiles(text: string): readonly string[] {
  const normalized = text.replaceAll("\\", "/");
  const seen = new Set<string>();
  // Sol wave-review r2 residual: root tokens are the false-positive-prone class (api.get-style
  // prose), so slash paths take CAP PRIORITY — a real nested path can never be truncated out by
  // prose noise; root tokens fill whatever cap budget remains, in first-mention order.
  const slashed: string[] = [];
  const rooted: string[] = [];
  for (const match of normalized.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const candidate = canonicalRepoRelativeFile(raw);
    if (candidate === undefined || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    (candidate.includes("/") ? slashed : rooted).push(candidate);
    if (slashed.length >= MAX_REQUEST_FILES) {
      break;
    }
  }
  return [...slashed, ...rooted].slice(0, MAX_REQUEST_FILES);
}
