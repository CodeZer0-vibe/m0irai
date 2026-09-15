/**
 * @file src/chat/statusline-config.ts
 * @purpose Chat-layer re-export of the shared claude statusLine SSOT (src/shared/claude-statusline). The pty
 *   writer (pty-session-registry) and the post-turn reader (headless-turn) import the per-cwd paths + the
 *   `--settings` writer through this stable chat-local path, while the single construction lives in shared so
 *   the ACP clean-config (a feature-layer adapter that may not import chat) reuses the EXACT same statusLine
 *   shape — writer, reader, and both transports can never point at different payloads.
 * @exports claudeStatuslinePaths, writeClaudeStatuslineSettings
 * @depends ../shared/claude-statusline
 */
export {
  claudeStatuslinePaths,
  writeClaudeStatuslineSettings,
} from "../shared/claude-statusline.js";
