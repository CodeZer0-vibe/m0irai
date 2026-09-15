# User Advocate Critique: Diff Review vs. Premium Flow

## 1. Picture-by-Picture Analysis

1. **`Cursor_wj0GkpWbWN.png` (The Navigation Trap)**
   - **User Experience:** The user feels stuck, powerless, and confused. They attempt standard navigation (arrow keys) and fail, concluding they "can't move or do anything" because there are no on-screen hints teaching them the `j/k` bindings.
   - **Principle Violated:** Discoverability & Affordance. A UI should never trap a user without visible exit or interaction cues.

2. **`Cursor_RLjKy5eOiO.png` (The Scrollback Spam)**
   - **User Experience:** The user feels the UI is broken and messy. Every `j/k` keystroke dumps a duplicate "Diff review" header into the terminal history, polluting the screen with ~20 copies.
   - **Principle Violated:** Screen Pollution & Transient State. Navigation is a transient action; it should update in place, not litter the permanent scrollback log.

3. **`Cursor_4FvqBk7prf.png` (The Robot Garbage)**
   - **User Experience:** The user reads truncated, internal prompt machinery ("force-agent-to-chunk redirect ready...") and correctly judges it as completely useless for making a human decision.
   - **Principle Violated:** Human-Readable Signal-to-Noise. Internal system prompts and mechanical redirects should never leak into the UI; the system must summarize the situation in plain operator terms.

4. **`Cursor_FDb4B18PHi.png` (The Byte Soup)**
   - **User Experience:** The user dives into a changed image file and is presented with raw `+ ◆PNG\r` binary nonsense. It is safe, but entirely noise.
   - **Principle Violated:** Meaningful Representation. If a file cannot be rendered usefully (like binary assets), the UI should gracefully degrade to a plain-words summary (e.g., "Binary image changed"), rather than dumping unreadable bytes.

5. **`Cursor_oXQTDZdwwh.png` (The Premium Flow)**
   - **User Experience:** The user feels guided and in control. The UI is clean, responsive, and clearly explains what to do next without friction.
   - **Princi
<truncated 4649 bytes>
───────────────────────────────────────────────────────────╯
```

## 4. The User Needs Lifecycle

- **Change lands:** The card appears *inline* at the bottom of the scrollback, directly above the composer. It does not take over the screen.
- **Notice:** The bordered, colored card draws the eye naturally as part of the conversation flow.
- **Inspect:** For small diffs, the context is immediately visible inside the inline card. For large diffs, the user presses `[f]ull diff` to open a dedicated, paginated viewer.
- **Decide:** The user presses a single, clearly labeled key (`k`, `u`, `c`) directly on the active card without needing to guess the keymap.
- **Receipt:** Once a decision is made, the large card collapses permanently into a one-line tombstone in the scrollback (e.g., `✓ Kept 14 lines in src/theme.ts`), leaving the history clean and readable.
- **The DEFAULT (If ignored):** If the user ignores the card and simply types a new message in the chat, the system defaults to **Keep**. The changes are already applied to the disk; interrupting the user's thought process to demand a mandatory "Keep" click is hostile. The card collapses into the `✓ Kept (implied)` receipt automatically.

## 5. Overturning the First Critique

Based on the visual evidence and the core reality that changes are "already applied," I would **OVERTURN** the hypothesis of a **sticky "Pending reviews: N" viewport indicator**. 

**Reasoning:** Because the files are already physically changed on disk, this is a "Keep or Undo" state, not a strict permission gate. If the user continues chatting and ignores the review, they are implicitly accepting the current state of the workspace. Adding a sticky, persistent "unread badge" for pending reviews creates false anxiety, treats an already-applied change like an active blocker, and pollutes the screen. It should simply default to Keep and vanish when the conversation moves on.