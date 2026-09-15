/**
 * @file src/shared/tui-suppressed-log.ts
 * @purpose Fail-soft file sink for terminal output that is SUPPRESSED while a full-screen TUI owns the
 *   screen (screenClaimed). Legacy stdout/stderr writers and the stderr logger must not paint raw bytes
 *   into Ink's frame — but dropping them SILENTLY hid real diagnostics for weeks. They append here
 *   instead, so the record survives. Append-only, best-effort: a sink write failure is swallowed and
 *   MUST NEVER throw into a render or a log call. shared/ only (no chat/ or tui/ imports — acyclic).
 * @exports appendTuiSuppressed, TUI_SUPPRESSED_LOG_PATH, bridgeSuppressedFallback
 * @depends node:fs, node:path, ./debug-mode
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { DebugSession } from "./debug-mode.js";
import { debugSession } from "./debug-mode.js";

/** The default cwd-relative sink path — mirrors use-flicker-detector's `.zer0/flicker.log`. */
export const TUI_SUPPRESSED_LOG_PATH: string = ".zer0/tui-suppressed.log";

/**
 * The default sink path: while a ZER0_DEBUG session is active the suppressed capture MOVES into the session
 * folder (gathered with the other debug artifacts — the operator opens one place); with no session active it
 * stays at the cwd default, byte-identical to today. An explicit `logPath` argument still overrides both.
 */
function defaultSuppressedPath(): string {
  return debugSession()?.suppressedPath ?? TUI_SUPPRESSED_LOG_PATH;
}

/**
 * Appends `text` VERBATIM (no added timestamp/newline — a faithful tee of the bytes that WOULD have hit
 * the terminal) to the suppressed-output sink. Total try/catch: a missing dir, a permission error, or a
 * race is intentionally ignored so an observability write can never crash the caller. `logPath` is
 * injectable for tests; production callers use the default (which routes into the debug session when on).
 */
export function appendTuiSuppressed(text: string, logPath: string = defaultSuppressedPath()): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, text);
  } catch {
    // fail-soft: a sink write failure is intentionally ignored (see function contract).
    return;
  }
}

// sol r2 BLOCK 2: distinguishes "nothing there" (ENOENT) from "something there we couldn't read" —
// Node's fs errors carry `.code` as a string (EACCES, EISDIR, ...) when they're ErrnoExceptions.
function readErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

/**
 * sol BLOCK 1 DECISION: boot-window suppressed lines (everything written before THIS process's first
 * activateDebugSession call — the trust gate, prepareBoot's db opens, mountReviewBoot's own db open)
 * land in the CWD FALLBACK (TUI_SUPPRESSED_LOG_PATH), never in a per-session folder, since no session
 * exists yet at write time. A session that registers afterward writes to its OWN suppressed.log instead
 * — an operator who opens only the session folder would see nothing about those earlier lines. Called
 * once per activation (chat-tui.ts's buildMount, right after activateDebugSession): if the fallback file
 * exists and carries real bytes, appends ONE plain pointer line to the session's OWN suppressed.log — a
 * POINTER only, never a copy/move of the fallback's bytes, which stay exactly where they landed. A no-op
 * when the fallback is absent or empty (nothing boot-window ever wrote there this run) — never invents a
 * pointer to nothing. sol r2 BLOCK 2: an absent fallback (ENOENT) stays quiet, but any OTHER read
 * failure (EACCES, EISDIR, ...) gets a classified line instead — see readErrorCode above.
 */
export function bridgeSuppressedFallback(session: DebugSession): void {
  let fallback: string;
  try {
    fallback = readFileSync(TUI_SUPPRESSED_LOG_PATH, "utf8");
  } catch (error) {
    // ENOENT is the ORDINARY case (nothing wrote to the fallback this run) — stays quiet, same as
    // before. Anything else (EACCES, EISDIR, ...) means the path IS occupied but couldn't be read — a
    // real failure this module's own purpose forbids dropping silently.
    const code = readErrorCode(error);
    if (code !== "ENOENT") {
      appendTuiSuppressed(
        `boot-window fallback exists but could not be read (${code ?? "unknown error"}) — see ${TUI_SUPPRESSED_LOG_PATH} directly\n`,
        session.suppressedPath,
      );
    }
    return;
  }
  if (fallback.length === 0) {
    return;
  }
  // Forward-slash-normalized (path.relative returns native separators — backslash on Windows): a
  // plain-text pointer read by a human should be deterministic regardless of platform, not vary the
  // exact bytes this function emits by OS.
  const pointerPath = relative(dirname(session.suppressedPath), resolve(TUI_SUPPRESSED_LOG_PATH))
    .split(sep)
    .join("/");
  appendTuiSuppressed(`earlier boot-window lines: see ${pointerPath}\n`, session.suppressedPath);
}
