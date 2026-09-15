# zer0 native per-agent session continuity

Repo: C:Users<user>VibeCodingzer0-agent-ci

## Per-turn invocation

Submit path (all agents):
cockpit-turn.ts:makeSmartTurnRunner
  -> cockpit-turn-exec.ts:runQueuedTurn (serialized tail, poison-proof)
  -> runSerializedTurn
  -> runSmartTurn
  -> runHeadlessTurn (headless-turn.ts:91)
  -> runOneLane (headless-turn.ts:165)
      composePrompt(session, prompt, agent, turn)   // headless-prompt.ts, 8-msg window
      writePromptFile(session, turn, agent, prompt) // -> .council/runs/<id>/prompts/<turn>-<agent>.md
      dispatch(laneDispatchInput(...))

Dispatch routing (dispatch-headless.ts:72-84):
  claude + codex, ACP ON (default, ZER0_ACP != 0): dispatchAcpHeadless -> dispatchAcpTurn
  claude, ACP OFF (ZER0_ACP=0): dispatchPty -> persistent pty registry
  codex, ACP OFF: dispatchPty (unless ZER0_CODEX_NO_PTY=1 -> sharedRegistry)
  gemini (always): sharedRegistry.dispatch -> dispatchAgy

## ACP session lifetime (claude/codex) --- PERSISTENT or FRESH?

VERDICT: FRESH per turn (ACP default path).

Evidence chain:
1. dispatch-acp.ts:60 - deps.dispatchAcpTurn({agent, cwd, promptText})
2. acp-turn.ts:97 - session = await open(input.agent, input.cwd) -> openTurnSession
3. acp-turn-session.ts:68-105 - openTurnSession: spawn(process.execPath, [spec.entry]) = NEW child + handshake
4. acp-turn.ts:113-114 - finally { session?.close(); } ALWAYS kills child after one prompt
5. No session cache keyed by (agent, chatSession) anywhere in src/adapters/acp/

dispatch-acp.ts:8 comment: "a fresh-per-turn ACP session keeps continuity"
= confirms this is intentional: the transcript-in-prompt IS the continuity mechanism.

CONTRAST - pty fallback (ZER0_ACP=0):
  pty-session-registry.ts:70,79-90: sessions = new Map<string, PtySession>()
  getOrSpawnPtySession: returns existing session for key "agent cwd"
  ONE persistent pty per (agent, cwd), reused across ALL turns.

## Gemini native continuity

headless-turn.ts:135: only gemini gets agyConversationDir: session.runDir in laneDispatchInput
agy.ts:91: readStoredConversationId reads <runDir>/.agy-conversation
agy.ts:207: buildAgyArgs includes ["--conversation", conversationId] when id is present

Turn 1 (no stored id):
  agy.ts:113: captureConversationId finds the brain id agy minted (readAgyConversationId)
  agy.ts:155-157: writes brain id to <runDir>/.agy-conversation

Turn 2+: reads stored id -> agy --conversation <id> -> resumes native brain

Isolation: id scoped to session.runDir = .council/runs/chat-<ts>-<uuid>/
New chat session = new runDir = no .agy-conversation = fresh (no cross-session bleed).

## Is the 20-msg injection redundant with native memory?

Two distinct prompt builders:
1. headless-prompt.ts::composePrompt (MAX_HISTORY_MESSAGES=8, MAX_PROMPT_CHARS=24_000)
   - Called at headless-turn.ts:172 for ALL agents on EVERY headless chat turn

2. prompt-builder.ts::buildPrompt (TRANSCRIPT_WINDOW=20 + git state + memory + ROLE_FILES)
   - Called ONLY by: run-debate.ts:190 (debate) and cli/commands/council.ts:58 (separate CLI)
   - NOT called on the standard headless chat turn path

Redundancy by agent:
  ACP claude/codex (default): child killed each turn -> 8-msg injection IS the sole continuity, NOT redundant
  pty claude/codex (ZER0_ACP=0): persistent pty retains context -> 8-msg injection re-feeds it (redundant)
  gemini: --conversation resumes agy brain -> 8-msg injection is additive (redundant)

## Durable files written today (who/when)

.council/runs/<id>/transcript.json
  Writer: zer0 (session-store.ts:76-79 persistSession)
  When: before dispatch (user msg appended) + after dispatch (agent reply merged in)

.council/runs/<id>/prompts/<turn>-<agent>.md
  Writer: zer0 (session-store.ts:114-119 writePromptFile)
  When: before each dispatch

.council/runs/<id>/responses/<turn>-<agent>.md
  Writer: zer0 (headless-turn.ts:190 writeResponseFile)
  When: after each agent lane

.council/runs/<id>/.agy-conversation
  Writer: zer0 (agy.ts:155-157 captureConversationId)
  When: after gemini's first turn only

SQLite evidence DB
  Writer: zer0 (evidence.ts recordChatDispatch + recordChatMessage)
  When: per dispatch (dispatch row + task row) and per message (message row + text blob)

HANDOFF-CHAT.md:
  NOT CALLED from production. writeHandoff (handoff.ts:15) only imported by handoff.test.ts.

CLAUDE.md / AGENTS.md / GEMINI.md:
  READ as ROLE_FILES by prompt-builder.ts:35-39 (debate path only). Not written by zer0 during chat.

docs/lessons/*:
  Temporal build-packet workflow only (build-packet.ts:129). Not the chat path.

## Observed evidence captured per turn

Per dispatch (evidence.ts::persistChatDispatch):
  promptContent blob, outputContent blob, stderrContent blob
  durationMs, exitCode
  tokensIn (estimated), tokensOut (estimated)
  repoCommit (HEAD SHA at dispatch time)
  SQLite: dispatch row + task row + run row

Per turn (cockpit-turn-persist.ts):
  Before dispatch: user message -> transcript.json + user message SQL row + text blob
  After dispatch: merged session -> transcript.json rewritten

No raw pty scrollback, no ANSI, no auto-captured git diff or test results in chat path.

## VERDICT: are we using their native memory, or rebuilding it?

ACP path (DEFAULT ON):
  claude, codex: REBUILDING each turn.
  New process spawned -> handshake -> one prompt -> process killed.
  8-message transcript window in the prompt IS the sole continuity.
  No native tool-use history, no memory-tool state, no prior file context beyond what the
  8-msg window carries. Every turn is a cold-start with a warm (but bounded) transcript.

pty fallback (ZER0_ACP=0):
  claude, codex: USING native memory + redundantly re-injecting.
  Persistent pty session retains full in-session context; 8-msg injection re-feeds it.

gemini (always registry):
  USING native memory (--conversation resumes agy brain turn 2+) + redundantly re-injecting.
  Gemini gets the recent history twice: from zer0 injection + from its own brain.

Design intent (dispatch-acp.ts:8): ACP is the intentional architecture. Conversation state
lives in zer0 transcript.json, not the agent process. The ACP child is a stateless executor.
Consequence: ACP claude/codex are amnesiac beyond the 8-message window per turn.
