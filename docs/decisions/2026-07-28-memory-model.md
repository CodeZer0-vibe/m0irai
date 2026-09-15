# THE MEMORY MODEL — how continuity actually works (verified in code, 2026-07-28)

**Status: AUTHORITATIVE.** This is the substrate S2 (memory for sure), S3 (live work), S4
(event-driven re-prompt), and S5 (call-each-other) are specified against. It was traced through the
code on 2026-07-28 at `decd341` — every mechanism below was READ, not remembered. It supersedes the
2026-06-29 research memory's "claude/codex stateless cold-start every turn" claim, which described
the pre-MT7 world and is no longer true on the default path.

## The shape: THREE PRIVATE NATIVE MEMORIES + ONE SHARED ROOM LEDGER

**Private native memory (per agent, vendor-held, cannot be merged):**

- **claude** — a persistent ACP lane session held open by a live bridge process
  (`lane-transport.ts` / `lane-hold.ts`). Native memory = everything zer0 ever sent it + its own
  replies. Across app restarts, the session id persists in the `lane_sessions` table
  (`memory/lane-state.ts`) and the SAME native session is resumed (`resumeSession`,
  `lane-hold.ts:332-339`).
- **codex** — identical mechanism over its own ACP bridge.
- **gemini** — NO held process (vendor design; per-turn spawn), but real native continuity: every
  dispatch passes `--conversation <id>` (`adapters/agy.ts:50`), the id is captured from the turn
  and persisted in `<dir>/.agy-conversation` (`agy.ts:25,325`), so each spawn rejoins its own
  native conversation. The cost is process spin-up per message, not memory.

**The shared room ledger (ours, SQLite):**

- Every conversation-role message (operator + agent replies) gets a monotonically minted **seq** in
  `ledger_seq` (`memory/ledger.ts`), written atomically WITH the message row when the carrier
  runtime is present (`evidence.ts` `recordChatMessage` / `recordLaneTurnEvidence` — one
  transaction, message + mint together).
- Each lane holds a **cursor** (its bookmark) in the ledger (`memory/lane-cursor.ts`); a turn's
  prompt = `setup + (briefing when carried) + ledger entries AFTER the cursor (the delta) +
  operator message` (`lane-carrier.ts composeCarrierPrompt`). **This delta is the ONLY way agents
  see each other** — never a vendor channel.
- The cursor advances only on an ACCEPTED send (`advanceCursorOnAccept`).

**Death and rebirth (generations):** when a lane's native session dies (crash, timeout, the 8s
interactive budget, binding mismatch), `bumpGeneration` records the new session; the fresh process
has seen NOTHING, so the next prompt runs in **catch-up**: cursor floored to 0, a full **briefing**
(`memory/briefing.ts`) + the bounded ledger TAIL with an overflow summary
(`lane-carrier.ts:221-236`). Trace signatures: `briefing.injected reason=coldstart|fallback|recarry`,
`delta.injected`, `delta.overflow`, `boundary.framed`.

**The long-term layer:** the digest pass (`memory/digest.ts`) reads the TRANSCRIPT as its
authority (a message absent from the DB mirror is still digested + traced), extracts facts via the
seamed CLI, and writes journal entries + watermarks atomically. The journal/map feed briefings.

**Memory OFF (`ZER0_MEMORY=0`):** all of the above is inert; every agent instead gets the last-8-
message transcript window re-pasted per turn, capped 24k chars (`headless-prompt.ts`,
`MAX_HISTORY_MESSAGES=8`). Same visibility effect, cruder, no native anything for claude/codex.

## The known defect this model carries (S2's core)

In the operator's 2026-07-28 trace, ALL THREE agent replies were `absent from DB mirror`
(digest trace) and `recordChatMessage` demonstrably took the per-message `openDb` fallback instead
of the carrier's handle. The fallback path writes the message row but **never mints the ledger
seq** — so those replies never entered the room ledger, and the agents could not see each other's
answers from that session. SUSPECTED cause (not yet proven): the `viaLedger` guard compares
`carrier.dbPath === input.dbPath` as strings — a relative-vs-absolute spelling of the SAME file
fails it. S2's gate: one un-forkable recording path, the trace scenario replayed green, mirror
zero-absent, and a LIVE continuity proof on the operator's machine (restart → resume → agent B
recalls agent A).

## What each future slice leans on

- **S3 (live work):** the held bridge connections are where ACP activity updates arrive — capture
  real payloads before rendering.
- **S4 (re-prompt):** "an agent sends a message later" = zer0 re-prompts that agent's lane on a
  tracked completion event; the reply rides the normal ledger path. No new memory machinery.
- **S5 (call-each-other):** a hop is a normal dispatch whose prompt is composed from the SAME
  ledger — the hopped-to agent is automatically fully briefed. The taught syntax is routed by
  `parseMultiAddress` over agent replies.
