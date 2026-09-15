# RESEARCH — What real users say about reviewing AI-agent code changes (terminal-first)

Scope: primary user voices (GitHub issues, forums, HN, named engineers, 2 academic studies) +
canonical terminal-UX guidelines. All claims sourced; trust marked HIGH/MED/LOW. 2024–2026.
Collected 2026-07-12 by the uxresearch lane for the inline-review redesign.

## ANSWER FIRST — the load-bearing finding

The operator's instinct ("inline in the chat, not full-screen") is correct, but the real
lesson from the evidence is sharper: **presentation quality — not inline-vs-fullscreen —
decides whether review actually happens.** A badly-presented diff (raw, too long, no
change-highlighting) trains users to STOP reviewing, wherever it lives. The single
best-sourced user voice: an aider user — the diff format "is training me to ignore the LLM
output because there's just too much of it… I am training myself to mostly ignore those as
they scroll by." Full-screen fails via mode-switch/lost context; a raw unified-diff dumped
inline fails via noise. The win is a **progressive-disclosure card in the conversation
flow**: plain-language summary of what/why/risk first, the actual diff on demand, arrow-key
accept/reject, friction calibrated to risk.

## Q1 — Claude Code inline permission/diff cards

PRAISE: the overlay card "shows the command or a diff of the change, and lets you approve or
deny with a single keystroke, then hands keyboard focus straight back to your terminal.
Risky commands get a red warning and a press-and-hold confirm."
(claudefa.st/blog/guide/development/permission-management · MED)
"Claude Code edits files directly… and lets you review before accepting, with no automatic
commits… wins when you want to describe a goal and walk away."
(zenvanriel.com/ai-engineer-blog/aider-vs-claude-code · MED)

COMPLAINTS: Anthropic's own data — users approve **93% of permission prompts** unchanged →
"approval fatigue, where people stop paying close attention to what they're approving."
(anthropic.com/engineering/claude-code-auto-mode · HIGH)
The terminal diff is hard to read: "A single stream of colored text is just not as clear as
a side-by-side visual comparison… way too easy to miss a small but important change."
(eesel.ai/blog/ide-diff-viewer-claude-code · MED) Anthropic's fix direction: ↑/↓ browse
files, syntax highlighting, dual line numbers, or pop to the IDE viewer.
(wmedia.es/en/tips/claude-code-diff-changes-per-turn · MED)
Design tension named by Anthropic: the agent "sits between the tool and the user, silently
deciding on their behalf" is the anti-pattern; "surface it to the user through its existing
UI, similar to how AskUserQuestion works." (github.com/anthropics/claude-code#27294 · HIGH)

## Q2 — Aider

Primitive = git commits, not accept/reject: every edit auto-commits; review via git diff;
/undo = git reset, "instantly undo any AI changes you don't like." (aider.chat/docs/git.html
· HIGH) Trust model = REVERSIBILITY, not pre-approval.
THE WARNING (direct user, HIGH): the diff "is training me to ignore the LLM output because
there's just too much of it… if modifying a method, it seems to show the entire old method
body, then the entire new method body. There is no visual indication of which of those lines
changed… I am training myself to mostly ignore those as they scroll by."
(slinkp.com/programming-with-aider-20250725.html) Also: auto-commit "puts too much into a
single commit," "commit message quality… inconsistent."

## Q3 — Cursor / Windsurf (GUI)

Removing the accept/reject gate causes a revolt: "the agent applies changes directly to the
files. This makes it impossible to partially accept or verify changes before they are
finalized"; "Cursor is unusable." Users demand "the inline diff view with 'Accept' and
'Reject' buttons for all file modifications." (forum.cursor.com/t/154887 · HIGH)
Windsurf, same: losing per-change accept/reject = "Loss of granular control… especially when
Cascade makes partially incorrect changes that need adjustment – which happens a lot!"
(github.com/Exafunction/codeium#131 · HIGH)
Translates to terminal: granular per-file/per-change gate. Doesn't translate: side-by-side
split panes — compensate with change-highlighting + progressive disclosure.

## Q4 — Non-coders / vibe coding

Karpathy (coined the term): "I 'Accept All' always, I don't read the diffs anymore" —
explicitly fine only for throwaway projects. (Wikipedia: Vibe coding · HIGH)
Academic: most common QA practice among vibe coders = SKIPPED QA, accept without validation
(36%); manual testing second (29%). (arXiv 2510.00328 · HIGH)
Non-coders review at the level of intent/behavior/risk, not syntax: "Rather than trying to
understand every line of code…"; "Ask engineers to assess risk levels." (sonary.com,
vybe.build founder guides · MED) They need plain-language summaries — "technical jargon
translated into plain English that an 8th grader could understand." (MED)
The cost of no review: the "vibe coding hangover" — Replit's AI "deleted a live production
database — even after being told not to." (dev.to/paulthedev · MED)
Accountability (Simon Willison, HIGH): "a computer can never be held accountable — that's
your job as the human in the loop"; unreviewed AI code is "a dereliction of duty."
(simonwillison.net/2025/Dec/18)
Review fatigue (arXiv 2509.12491, HIGH): "I'm more mentally exhausted… I'm working so damn
fast and am in constant code review mode" (P-R43); trust calibrated to risk — vibe for
"weekend projects," caution for "safety critical systems or sensitive data."

## Q5 — Terminal conventions

clig.dev (HIGH): confirm by risk tier (mild/moderate/severe — severe = "make it hard to
confirm by accident," type-the-name); only prompt on a TTY, never REQUIRE a prompt; show
what will change (--dry-run); "explain what has just happened"; respond <100ms; Ctrl-C
exits fast; "concise by default," detail on demand.
Destructive default: [y/N] — Enter = the SAFE option. (commandinline.com · MED)
lazygit norms (HIGH): arrow keys AND j/k; space acts; keybinding hints always visible in a
footer; ? opens full keys; / filters.
Inline vs full-screen: full-screen = the alternate buffer (vim/htop) = a mode switch hiding
the conversation; inline "consume[s] the least amount of space required." Claude Code's
permission card stays an INLINE OVERLAY that hands focus back. (prompt_toolkit docs, Claude
Code fullscreen docs · HIGH)

## Q6 — THE 8 EVIDENCE-BACKED PRINCIPLES

1. Review IN the conversation flow — overlay/inline card, not a full-screen mode switch.
2. Presentation quality determines whether review happens — never dump a raw diff
   (change-highlighting, syntax color, only changed lines).
3. Progressive disclosure: plain-language summary first (what/why/risk), the raw diff on
   demand.
4. The accept/reject gate is sacred — keep it, granular (per-file/per-group).
5. Earn trust through cheap, VISIBLE undo — reversibility lowers the stakes of every
   approval.
6. Calibrate friction to risk — auto-flow low-risk; hard stops (red, press-and-hold) only
   for destructive/high-blast-radius; Enter = the safe default.
7. Match terminal norms: arrows AND j/k; single-keystroke actions; always-visible key hints
   - ? for help; <100ms response; Ctrl-C escapes.
8. Protect flow: one card per coherent logical change, never N micro-interruptions.

HONEST TENSION: "inline like Claude Code" is directionally right, but inline must mean a
DESIGNED CARD (summary → expandable highlighted diff → one-key actions → visible undo), not
a raw unified diff printed into chat — the evidence shows a raw inline diff fails the
non-coder exactly as badly as a full-screen one, just differently.

Confidence: HIGH on Q1/Q3/Q4/Q5 + the synthesis; MED where marked. Gap: no large-N
quantitative study on NON-CODER terminal review behavior specifically — the non-coder
specifics are strong-anecdote grade, not survey grade.
