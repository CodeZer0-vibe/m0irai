/**
 * @file src/chat/headless-prompt.ts
 * @purpose Composes the prompt each headless agent receives: the zer0 "team setup" + the SHARED
 *   transcript (teammates' labelled replies = shared memory). Pure string composition — no I/O.
 * @exports LaneClass, ComposePromptOptions, composeHeadlessSetup, composeOperatorTask, composePrompt, countFramedInRecentWindow
 * @depends ../evidence/db, ../memory/briefing, ../memory/memory-flags, ../memory/request-files, ../memory/router, ../memory/untrusted-framing, ../shared/config, ../shared/room-notice, ./lane-carrier-briefing, ./session-store, ./types
 *
 * Split from headless-turn.ts so prompt-building and turn-execution stay separate concerns under the
 * line ceiling. T7 addition: composePrompt's 5th param accepts EITHER a bare LaneClass (every existing
 * call site, unchanged — the MAX_PARAMETERS=5 gate forbids a bare 6th `redirect` param, and rewriting
 * the ~20 call sites across memory/chat/Ink test files — several concurrently edited by other builders
 * in this same wave — would be a far larger, riskier footprint than this one injection warrants) OR a
 * {@link ComposePromptOptions} object carrying `{laneClass, redirect?}`. `redirect` (an already-
 * formatted, already-untrusted-framed block from review-redirect-delivery.ts's formatRedirectForPrompt)
 * is injected after the recent-window history and BEFORE the task, and BYPASSES MAX_PROMPT_CHARS
 * truncation — the history portion (setup+dialogue+briefing) is truncated on its OWN budget; the
 * redirect + task are appended afterward, untouched, matching the spec's "redirects bypass the 24k
 * recent-window truncation." Absent/empty `redirect` — output is byte-identical to the pre-T7 call.
 * @size-justified: one cohesive prompt-composition pipeline (setup + framed transcript window +
 *   memory briefing + redirect + task) sharing tightly-coupled internal state (recent, priorIds,
 *   fixedParts) — the BLOCK 1 frame-safe truncation fix (fitRecentWindow) had to live beside
 *   renderRecentWindow to reuse it in its own re-render loop; splitting would separate functions
 *   that must change together and duplicate the MAX_HISTORY_MESSAGES/priorIds computation.
 */
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { composeBriefing } from "../memory/briefing.js";
import { memoryEnabled } from "../memory/memory-flags.js";
import { extractRequestFiles } from "../memory/request-files.js";
import { selectBriefingPulls } from "../memory/router.js";
import { SESSION_BOUNDARY_STATEMENT, delimitUntrusted } from "../memory/untrusted-framing.js";
import { loadConfig } from "../shared/config.js";
import type { RoomNotice } from "../shared/room-notice.js";
// MN fix round 2 (I-2): reuses the carrier path's ONE degradation primitive rather than hand-rolling a
// second classify-record-fallback mechanism here — `safely` already does exactly what this file's four
// try/catch blocks were doing by hand (classify by call site, record durably, raise a
// `memory-failure-log-unwritable` notice when even the record fails), and this file sits at the same
// layer (src/chat) as lane-carrier-briefing.ts, so importing it is not a new dependency edge, just
// reuse of an existing one.
import { type RaisedNotice, safely } from "./lane-carrier-briefing.js";
import { canonicalTranscript } from "./session-store.js";
import type { AgentName, ChatMessage, ChatSession } from "./types.js";

// Recent-transcript window injected as shared context so each fresh CLI invocation sees the team's recent
// work (a real shared chat, not amnesiac single-shots). Bounded so a long session can't blow the adapter's
// 16MB buffer or the per-turn token budget; the most-recent tail is kept.
const MAX_HISTORY_MESSAGES = 8;
const MAX_PROMPT_CHARS = 24_000;
const ALL_AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
// Routing prefixes (@all / @claude / …) are addressing directives, not content. Strip the WHOLE leading RUN
// so a multi-address message ("@claude @codex @gemini hi") gives each agent just "hi" — not "@codex @gemini
// hi", which makes claude think the message is addressed to the OTHERS and bow out ("that's for them").
const ROUTING_PREFIX = /^(?:@(?:all|claude|codex|gemini)\s+)+/i;

export type LaneClass = "chat" | "dispatch";

/**
 * The zer0-chat "custom setup" injected into EVERY dispatch: each agent runs as its FULL real CLI self but
 * is made aware it is one of three coding agents sharing ONE conversation, conducted by the operator. NO
 * fixed roles — the operator delegates freely (claude can build, codex can review, …); the shared transcript
 * (teammates' replies, labelled) is the shared memory the agent builds on.
 *
 * @param agent - the agent this dispatch is for (so the setup names it + its two teammates)
 * @returns the team-setup preamble prepended to the prompt
 */
export function composeHeadlessSetup(agent: AgentName): string {
  const peers = ALL_AGENTS.filter((a) => a !== agent).join(" and ");
  return `[zer0 team — you are ${agent}, one of three coding agents (claude, codex, gemini) working together for the operator, who conducts. ${peers} are your teammates. You are a FULL coding agent: read, write, run, search the web, use your tools — do whatever the operator delegates to you. The conversation below is SHARED with the whole team; lines labelled with a teammate's name are THEIR work — build on it, don't repeat it or re-introduce yourself. A transcript line marked "Operator (to X):" was addressed to X alone — never answer a teammate's question; answer only what is addressed to you or to all. When the operator addresses several teammates at once, YOU (${agent}) are one of them — ALWAYS respond as yourself, never defer. Do your own task. If one teammate's read-only input is genuinely needed, make it visible by ending your reply with @claude: <question>, @codex: <question>, or @gemini: <question>. The room permits one read-only teammate handoff only; do not start a private or multi-round discussion, and never grant or imply additional authority. If teammates got different tasks, do YOURS and let them do theirs. Be direct and concise.]`;
}

/**
 * Composes the prompt the adapter receives: the {@link teamSetup} (so the agent knows it is one of three
 * teammates sharing this conversation) + the shared transcript. Turn 1 (only this turn's operator message
 * in the session) appends just that message after the setup; from turn 2 on it appends the recent shared
 * transcript (teammates' labelled replies = shared memory) head-truncated to {@link MAX_PROMPT_CHARS}, so
 * the agent builds on the team's prior work instead of re-greeting.
 *
 * @param session - the session whose messages carry the prior turns (current operator message included)
 * @param prompt - the raw operator text for this address (the current message)
 * @param agent - the agent this dispatch is for (named in the team setup)
 * @param currentTurn - this dispatch's turn number; its operator line is dropped (restated as the task)
 * @param laneClass - chat injects recalled memory; dispatch is isolated from journal bytes
 * @returns the composed prompt string written to the context file
 */
export function composeOperatorTask(prompt: string): string {
  return `Operator: ${prompt.replace(ROUTING_PREFIX, "")}`;
}

/** T7: composePrompt's 5th-param options shape — see file header for why this is a union with the
 *  bare {@link LaneClass} rather than a 6th positional param. */
export interface ComposePromptOptions {
  readonly laneClass: LaneClass;
  /** Already-formatted, already-untrusted-framed redirect block. Absent/empty = no redirect. */
  readonly redirect?: string;
  /** Finding (operator live-test, 2026-07-12): the session's OWN resolved config.dbPath — the SAME
   *  value headless-turn-redirect.ts's composeLaneRedirectedPrompt already carries in scope, one call
   *  up. Threaded so the memory-briefing DB open (laneClass "chat" only) targets the SAME db the rest
   *  of this turn's machinery (checkpoint/review capture) is using, rather than openSessionMemoryDb
   *  independently re-deriving via a bare loadConfig() call (process.cwd()-relative — correct only
   *  when cwd happens to equal repoRoot, which every OTHER caller in this turn already has resolved
   *  and this one silently didn't). Absent = the OLD loadConfig()-based resolution, byte-identical to
   *  before this fix — every existing bare-LaneClass call site (and any other caller that hasn't
   *  threaded this yet) is unaffected. */
  readonly dbPath?: string;
  /** THE BOUNDARY WAVE: count of session.messages present at THIS chat session's boot (live-derived,
   *  never persisted — see chat-tui-mount.ts). A recent-window message at array index below this count
   *  predates the current session — composePrompt frames it untrusted (untrusted-framing.ts's own
   *  convention, matching prompt-builder.ts's buildTranscript). Absent/0 = a fresh session; frames
   *  nothing, byte-identical to before this option existed. This is a SEPARATE rendering path from
   *  prompt-builder.ts's own transcript (used by /debate + council-synthesis only) — single-lane,
   *  segment, and non-carrier council dispatch all render through THIS function instead. */
  readonly priorSessionMessageCount?: number;
  /** MN fix round 2 (I-2): every memory-briefing failure this call classified, mirroring
   *  lane-carrier-briefing.ts's `safely` primitive on the carrier path. Mutated in place (never
   *  replaced), so a caller passes an array it already owns rather than reading a return value this
   *  function never had. Absent = the notices are still classified and durably logged exactly as
   *  before (byte-identical for every existing caller) but simply not collected anywhere — nothing
   *  currently wired up to this option publishes them onward to the room's bus (see this lane's
   *  build report for the declared seam in headless-turn.ts's runNonCarrierLane, the only room-
   *  reachable call site that has a bus in hand). */
  readonly notices?: RoomNotice[];
}

function normalizeComposeOptions(options: LaneClass | ComposePromptOptions): ComposePromptOptions {
  return typeof options === "string" ? { laneClass: options } : options;
}

export function composePrompt(
  session: ChatSession,
  prompt: string,
  agent: AgentName,
  currentTurn: number,
  options: LaneClass | ComposePromptOptions,
): string {
  const { laneClass, redirect, dbPath, priorSessionMessageCount, notices } =
    normalizeComposeOptions(options);
  const setup = composeHeadlessSetup(agent);
  const task = composeOperatorTask(prompt);
  const sink: MemoryNoticeSink = { agent, raised: [] };
  const briefing = memoryBriefing(session, laneClass, prompt, dbPath, sink);
  // Mutate the CALLER's array (never replace it) so a caller that passed one in owns whatever this
  // call classified; absent means nobody asked, and `sink.raised` is simply discarded.
  notices?.push(...sink.raised);
  // Prior shared context = the conversation MINUS this turn's operator line (restated as `task` below so the
  // agent's OWN instruction is explicit + last — for a chain segment the task is the full delegated line).
  // Dropping by TURN (not "trailing user") removes it wherever it sits — including when a prior sequential
  // agent's reply is already the last message — without erasing a prior unanswered operator turn. The
  // threaded agent replies from THIS turn (the hand-off) remain: teammates' work to build on.
  // BLOCK-2: window the ASK-ORDER view (canonicalTranscript), not raw arrival order — a slow reply that
  // persisted out of turn order must not render as if it were newest.
  const recent = dropCurrentOperatorTurn(canonicalTranscript(session.messages), currentTurn).slice(
    -MAX_HISTORY_MESSAGES,
  );
  const priorIds = priorMessageIds(session.messages, priorSessionMessageCount ?? 0);
  // BLOCK 1 fix (codex sol MAX review round 1): the pre-fix truncateHead sliced the FINAL joined
  // string character-wise, keeping the tail — a frame straddling the cutoff could lose its opening
  // delimiter while keeping its content + closing delimiter, leaving stale prior-session text that
  // reads as unframed/trusted. fitRecentWindow drops the OLDEST message WHOLE instead (never a
  // partial slice) until [setup, window, briefing(, task)] together fit MAX_PROMPT_CHARS — a frame is
  // included WHOLE or dropped WHOLE, never split. T7: a redirect BYPASSES the recent-window budget
  // entirely — the window's OWN budget excludes `task` when a redirect is present (matching the
  // pre-fix contract exactly: historyParts alone got the full budget; redirect + task were appended
  // untouched afterward).
  const hasRedirect = redirect !== undefined && redirect.length > 0;
  const windowFixedParts = hasRedirect ? [setup, briefing] : [setup, briefing, task];
  const windowText = fitRecentWindow(recent, priorIds, windowFixedParts, MAX_PROMPT_CHARS);
  const historyParts = windowText.length === 0 ? [setup, briefing] : [setup, windowText, briefing];
  if (!hasRedirect) {
    return joinPromptParts([...historyParts, task]);
  }
  return joinPromptParts([joinPromptParts(historyParts), redirect, task]);
}

function joinPromptParts(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** MN fix round 2 (I-2): `agent` and `raised` travel together at every step of the memory-briefing
 *  chain below (six call sites) — bundled so adding the notice-collection param does not push any of
 *  them over the 5-parameter clamp. `raised` is mutated in place, same convention as `RaisedNotice`
 *  everywhere else in this codebase. */
interface MemoryNoticeSink {
  readonly agent: AgentName;
  readonly raised: RaisedNotice;
}

function memoryBriefing(
  session: ChatSession,
  laneClass: LaneClass,
  liveText: string,
  dbPath: string | undefined,
  sink: MemoryNoticeSink,
): string {
  switch (laneClass) {
    case "chat":
      return memoryEnabled() ? composeSessionBriefing(session, liveText, dbPath, sink) : "";
    case "dispatch":
      return "";
    default: {
      const unreachable: never = laneClass;
      throw new Error(`unknown laneClass ${String(unreachable)}`);
    }
  }
}

function composeSessionBriefing(
  session: ChatSession,
  liveText: string,
  dbPath: string | undefined,
  sink: MemoryNoticeSink,
): string {
  const db = openSessionMemoryDb(session.repoRoot, dbPath, sink);
  if (db === undefined) {
    return "";
  }
  try {
    const projectId = resolveSessionProject(db, session, sink);
    if (projectId === undefined) {
      return "";
    }
    return composeSessionMemory(db, session, projectId, liveText, sink);
  } finally {
    closeSessionMemoryDb(db, session.repoRoot, sink);
  }
}

function openSessionMemoryDb(
  repoRoot: string,
  dbPath: string | undefined,
  sink: MemoryNoticeSink,
): Db | undefined {
  return safely(
    { agent: sink.agent, binding: { cwd: repoRoot } },
    sink.raised,
    "memory-db-open-failed",
    () => openMemoryDb(dbPath ?? loadConfig().dbPath),
    undefined,
  );
}

function resolveSessionProject(
  db: Db,
  session: ChatSession,
  sink: MemoryNoticeSink,
): string | undefined {
  return safely(
    { agent: sink.agent, binding: { cwd: session.repoRoot } },
    sink.raised,
    "memory-project-resolve-failed",
    () => projectIdForSession(db, session),
    undefined,
  );
}

function composeSessionMemory(
  db: Db,
  session: ChatSession,
  projectId: string,
  liveText: string,
  sink: MemoryNoticeSink,
): string {
  const agent = sink.agent;
  return safely(
    { agent, binding: { cwd: session.repoRoot } },
    sink.raised,
    "memory-compose-failed",
    () => {
      // MT6a-completion W0 (the unwired-router gap): the live operator text names the files the turn
      // concerns; the router pulls OTHER agents' + ledger decisions touching them into the briefing.
      const requestFiles = extractRequestFiles(liveText);
      const pulls =
        requestFiles.length > 0
          ? selectBriefingPulls({ db, projectId, forAgent: agent, requestFiles })
          : [];
      return composeBriefing({
        db,
        projectId,
        agent,
        now: session.updatedAt,
        // K1 (operator decision, 2026-08-18): framed recall is restored, so derived memory reaches the
        // prompt again. Explicit rather than omitted: this is the provider prompt boundary, and it is
        // the line that was wrong. Two guards remain and are NOT relaxed — isSafeSharedMemoryBody
        // screens every non-operator row, and what survives is rendered inside the untrusted frame.
        operatorOnly: false,
        pulls,
      }).text;
    },
    "",
  );
}

function closeSessionMemoryDb(db: Db, repoRoot: string, sink: MemoryNoticeSink): void {
  safely(
    { agent: sink.agent, binding: { cwd: repoRoot } },
    sink.raised,
    "memory-compose-failed",
    () => closeDb(db),
    undefined,
  );
}

function projectIdForSession(db: Db, session: ChatSession): string | undefined {
  return sessionProjectId(db, session.id) ?? rootProjectId(db, session.repoRoot);
}

function sessionProjectId(db: Db, sessionId: string): string | undefined {
  const row = db
    .prepare(
      "SELECT project_id AS projectId FROM chat_sessions WHERE id = ? AND project_id IS NOT NULL AND trim(project_id) <> '' LIMIT 1",
    )
    .get(sessionId) as { readonly projectId?: unknown } | undefined;
  return typeof row?.projectId === "string" ? row.projectId : undefined;
}

function rootProjectId(db: Db, repoRoot: string): string | undefined {
  const row = db
    .prepare(
      "SELECT project_id AS projectId FROM projects WHERE canonical_root = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(repoRoot) as { readonly projectId?: unknown } | undefined;
  return typeof row?.projectId === "string" ? row.projectId : undefined;
}

// Removes the CURRENT turn's operator (user) message(s) wherever they sit — matched by turn, not position —
// so the task restated as the last line is not duplicated (esp. for the 2nd+ agent in a sequential chain,
// where a prior agent reply is already the last message). Prior turns + this turn's agent replies survive.
function dropCurrentOperatorTurn(
  messages: readonly ChatMessage[],
  currentTurn: number,
): readonly ChatMessage[] {
  return messages.filter((m) => !(m.role === "user" && m.turn === currentTurn));
}

// HISTORY lines keep their addressing as attribution (#a825): stripping it entirely made every prior
// question read as team-wide, so agents "helpfully" answered questions that were never theirs (gemini
// volunteered its model+effort when asked only about links). The CURRENT task line (composePrompt's
// `task`) stays bare — stripping THERE is the bow-out fix and is untouched. "(to all)" for @all,
// deduped names joined with "and" for a multi-address run.
function renderMessage(message: ChatMessage): string {
  if (message.role === "user") {
    const run = message.text.match(ROUTING_PREFIX)?.[0];
    const rest = run === undefined ? message.text : message.text.slice(run.length);
    return `Operator${attribution(run)}: ${rest}`;
  }
  return `${message.agent}: ${message.text}`;
}

// THE BOUNDARY WAVE: `messages` is append-only (session-store.ts's appendMessage), so an array index
// below `priorSessionMessageCount` predates this chat session's boot regardless of the recent-window's
// own trailing slice — identified by id (not index), since the window itself is a suffix slice of a
// DIFFERENT (ask-order) ordering than the raw array this count was captured against.
function priorMessageIds(
  messages: readonly ChatMessage[],
  priorSessionMessageCount: number,
): ReadonlySet<string> {
  return new Set(messages.slice(0, priorSessionMessageCount).map((m) => m.id));
}

// Renders the recent-window messages, framing any that predate this session's boot as untrusted
// recalled memory (untrusted-framing.ts's shared convention — matches prompt-builder.ts's own
// buildTranscript exactly) and appending ONE boundary statement per window, never once per framed
// message. priorIds empty (a fresh session, or priorSessionMessageCount absent) frames nothing —
// byte-identical to the pre-boundary-wave `recent.map(renderMessage).join("\n\n")`.
function renderRecentWindow(recent: readonly ChatMessage[], priorIds: ReadonlySet<string>): string {
  let framedPriorSession = false;
  const lines = recent.map((message) => {
    const rendered = renderMessage(message);
    if (!priorIds.has(message.id)) {
      return rendered;
    }
    framedPriorSession = true;
    const label = message.role === "user" ? "[user]" : `[${message.agent}]`;
    return delimitUntrusted(rendered, `transcript ${label}`);
  });
  if (framedPriorSession) {
    lines.push(SESSION_BOUNDARY_STATEMENT);
  }
  return lines.join("\n\n");
}

// BLOCK 1 fix (codex sol MAX review round 1): drops the OLDEST recent-window message WHOLE (never a
// character-level slice) until `fixedParts` + the rendered window together fit `maxChars` — mirrors
// delta-composer.ts's composeDelta (drop oldest, re-render, recheck, repeat). Framing is atomic: a
// message survives WHOLE (with its frame, if any) or is dropped WHOLE, never split — the only way to
// guarantee a frame's opening delimiter can never be separated from its content or closing delimiter.
// A leading ellipsis marks the elision, mirroring the pre-fix truncateHead's own UX convention.
function fitRecentWindow(
  recent: readonly ChatMessage[],
  priorIds: ReadonlySet<string>,
  fixedParts: readonly string[],
  maxChars: number,
): string {
  let window = recent;
  let windowText = renderRecentWindow(window, priorIds);
  let dropped = false;
  while (window.length > 0 && joinPromptParts([...fixedParts, windowText]).length > maxChars) {
    window = window.slice(1);
    dropped = true;
    windowText = renderRecentWindow(window, priorIds);
  }
  if (!dropped) {
    return windowText;
  }
  // Even a fully-emptied window (every message dropped whole) still surfaces the ellipsis marker —
  // an operator/agent reading the prompt sees SOMETHING was truncated, never a silent gap (matches
  // the pre-fix truncateHead's own always-visible-marker contract).
  return windowText.length === 0 ? "…" : `…\n${windowText}`;
}

/**
 * THE BOUNDARY WAVE (B7 observability): the count of composePrompt's OWN recent-window messages that
 * WOULD be framed as prior-session for this exact (session, currentTurn, priorSessionMessageCount)
 * triple — the SAME window computation composePrompt performs internally (dropCurrentOperatorTurn +
 * canonicalTranscript + the MAX_HISTORY_MESSAGES tail slice), exposed read-only so a caller with bus
 * access (headless-turn.ts's runOneLane) can emit an ACCURATE debug trace without composePrompt
 * itself needing I/O (it stays pure — see file header). Deliberately window-scoped, not a raw
 * watermark comparison: a boundary far outside the actual rendered window must never over-report.
 *
 * @param session - the session whose messages carry the prior turns
 * @param currentTurn - this dispatch's turn number (excluded, same as composePrompt's own `task`)
 * @param priorSessionMessageCount - count of session.messages present at this chat session's boot
 * @returns how many of the ACTUALLY-rendered recent-window messages predate the boundary
 */
export function countFramedInRecentWindow(
  session: ChatSession,
  currentTurn: number,
  priorSessionMessageCount: number,
): number {
  const recent = dropCurrentOperatorTurn(canonicalTranscript(session.messages), currentTurn).slice(
    -MAX_HISTORY_MESSAGES,
  );
  const priorIds = priorMessageIds(session.messages, priorSessionMessageCount);
  return recent.filter((message) => priorIds.has(message.id)).length;
}

function attribution(run: string | undefined): string {
  if (run === undefined) {
    return "";
  }
  const names = [...run.matchAll(/@(all|claude|codex|gemini)/gi)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
  const unique = [...new Set(names)].filter((n) => n.length > 0);
  if (unique.length === 0) {
    return "";
  }
  return unique.includes("all") ? " (to all)" : ` (to ${unique.join(" and ")})`;
}
