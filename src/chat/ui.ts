/**
 * @file src/chat/ui.ts
 * @purpose Terminal rendering for the chat cockpit: agent labels, streaming, status.
 * @exports attachTurnUi, printPick, printAgentLabel, printAgentChunk, printAgentError, printAgentDone, printAgentFailed, printChatStatus, printChatError, printCouncilDispatch, printCouncilProgress, printDebateEvent, printSessionInfo, printBuildCard, printBuildReviewed, printRouteDecision
 * @depends yoctocolors, figures, ../shared/screen-claim, ./events, ./types
 */
import figures from "figures";
import { blue, cyan, dim, green, magenta, red, yellow } from "yoctocolors";
import { screenClaimed } from "../shared/screen-claim.js";
import { appendTuiSuppressed } from "../shared/tui-suppressed-log.js";
import type {
  BuildCardEvent,
  BuildLaneStatus,
  BuildReviewAction,
  BuildReviewedEvent,
  ChatEvent,
  ChatEventBus,
  RouteClassifiedEvent,
  RouteDecisionEvent,
} from "./events.js";
import type { AgentName, ChatMode } from "./types.js";

const NEWLINE: string = "\n";
const NO_COLOR_ENV: string = "NO_COLOR";
const MS_PER_SECOND: number = 1000;
const DURATION_DECIMALS: number = 1;

const AGENT_COLORS: Record<AgentName, (s: string) => string> = {
  claude: blue,
  codex: green,
  gemini: magenta,
};
const TURN_UI_BUSES: WeakSet<ChatEventBus> = new WeakSet();

// Human label for each smart-router pick, rendered before dispatch (INV-6 / AC-5) so the operator
// sees WHY the turn was routed. Exhaustive over ChatMode — tsc fails if a mode is added unmapped.
const PICK_LABEL: Readonly<Record<ChatMode, string>> = {
  single: "[single]",
  all: "[asking all 3]",
  debate: "[debate]",
  research: "[research]",
  build: "[build]",
};

type DebateUiEvent = Extract<
  ChatEvent,
  { readonly kind: "debate.round-start" | "debate.agent-result" | "debate.round-complete" }
>;

// Color per lane status for the build card: captured=green (artifact ready), empty=yellow (nothing
// produced), failed/escaped=red (not acceptable). Exhaustive over BuildLaneStatus — tsc fails unmapped.
const LANE_STATUS_COLOR: Readonly<Record<BuildLaneStatus, (s: string) => string>> = {
  captured: green,
  empty: yellow,
  failed: red,
  escaped: red,
  "policy-rejected": red,
};

/**
 * Attaches the per-turn UI subscribers to a bus: the smart-router pick (route.classified) and the
 * read-only debate stream (debate.*). Idempotent via {@link TURN_UI_BUSES} so the cockpit can call
 * it once per session bus without risking a double-subscribe (which would double-render the pick).
 * Council/single output is NOT subscribed here — those paths print directly (see
 * controller-council.ts), so subscribing them would double-render.
 */
export function attachTurnUi(eventBus: ChatEventBus): void {
  if (TURN_UI_BUSES.has(eventBus)) return;
  eventBus.on("route.classified", (event) => printPick(event));
  eventBus.on("debate.round-start", (event) => printDebateEvent(event));
  eventBus.on("debate.agent-result", (event) => printDebateEvent(event));
  eventBus.on("debate.round-complete", (event) => printDebateEvent(event));
  eventBus.on("build.card", (event) => printBuildCard(event));
  eventBus.on("build.reviewed", (event) => printBuildReviewed(event));
  eventBus.on("route.decision", (event) => printRouteDecision(event));
  TURN_UI_BUSES.add(eventBus);
}

/**
 * Renders one routing-transparency line (`ℹ route → <verdict>: <reason>`) so every write-capable
 * routing DECISION is visible in the terminal too — not only in ZER0_CHAT_TRACE. This is ADDITIVE:
 * the reject paths still print their own dedicated error/status message (build-team-turn.ts); this is
 * the uniform one-line decision marker that pairs with the trace event the operator audits.
 */
export function printRouteDecision(event: RouteDecisionEvent): void {
  const verdict = colorStdout(dim, event.verdict);
  writeStdout(
    `${colorStdout(dim, `${figures.info} route → `)}${verdict}: ${colorStdout(dim, event.reason)}${NEWLINE}`,
  );
}

// Color per review action: accepted=green (landed on main), rejected/acknowledged=dim (cleanly
// resolved), conflict/refused=red (operator must act). Exhaustive over BuildReviewAction — tsc fails unmapped.
const REVIEW_ACTION_COLOR: Readonly<Record<BuildReviewAction, (s: string) => string>> = {
  accepted: green,
  conflict: red,
  rejected: dim,
  acknowledged: dim,
  refused: red,
};

/**
 * Renders one operator-review outcome (T4): `[agent] <action>[ — <detail>]`. `accepted` means the
 * lane's patch landed on CURRENT main; `conflict`/`refused` carry a human-readable detail (why main
 * was left byte-untouched) so the operator knows the next move; `rejected`/`acknowledged` are clean.
 */
export function printBuildReviewed(event: BuildReviewedEvent): void {
  const label = colorStdout(AGENT_COLORS[event.agent], `[${event.agent}]`);
  const action = colorStdout(REVIEW_ACTION_COLOR[event.action], event.action);
  const detail = event.detail === undefined ? "" : colorStdout(dim, ` — ${event.detail}`);
  writeStdout(`${label} ${action}${detail}${NEWLINE}`);
}

/**
 * Renders one BUILD lane card (INV-5): `[agent] <status> · mergeable:<y/n> · on-task:<unverified>`.
 * The three fields are SEPARATELY sourced — `laneStatus` (process+artifact), `mergeable` (3-way
 * apply onto CURRENT main), `onTask` (always `unverified` in MVP) — never collapsed into one verdict.
 * For a gemini `.md` lane the card ALSO shows, when present, the exported artifact PATH (gate-PASS)
 * or the policy-violation string (policy-rejected) — never the `.md` CONTENT (INV-3d, untrusted). A
 * card without those optional fields renders the exact base line (code/THINK lanes are unchanged).
 */
export function printBuildCard(event: BuildCardEvent): void {
  const label = colorStdout(AGENT_COLORS[event.agent], `[${event.agent}]`);
  const status = colorStdout(LANE_STATUS_COLOR[event.laneStatus], event.laneStatus);
  const mergeable = event.mergeable ? "yes" : "no";
  const detail = colorStdout(dim, `mergeable:${mergeable} · on-task:${event.onTask}`);
  const artifact =
    event.artifactPath === undefined ? "" : colorStdout(dim, ` · artifact:${event.artifactPath}`);
  const policy =
    event.policyViolation === undefined
      ? ""
      : colorStdout(dim, ` · policy:${event.policyViolation}`);
  writeStdout(`${label} ${status} · ${detail}${artifact}${policy}${NEWLINE}`);
}

/** Renders the smart-router pick as `[mode-label] — <reason>` (AC-5). */
export function printPick(event: RouteClassifiedEvent): void {
  const label = colorStdout(cyan, PICK_LABEL[event.mode]);
  writeStdout(`${label} ${colorStdout(dim, `— ${event.reason}`)}${NEWLINE}`);
}

export function printAgentLabel(agent: AgentName, suffix?: string): void {
  const label = colorStdout(AGENT_COLORS[agent], `[${agent}]`);
  const extra = suffix !== undefined ? ` ${colorStdout(dim, suffix)}` : "";
  writeStdout(`${NEWLINE}${label}${extra}${NEWLINE}`);
}

export function printAgentChunk(_agent: AgentName, chunk: string): void {
  writeStdout(chunk);
}

export function printAgentError(_agent: AgentName, chunk: string): void {
  writeStderr(colorStderr(dim, chunk));
}

export function printAgentDone(agent: AgentName, durationMs: number): void {
  const secs = (durationMs / MS_PER_SECOND).toFixed(DURATION_DECIMALS);
  writeStdout(
    `${NEWLINE}${colorStdout(dim, `${figures.tick} ${agent} done (${secs}s)`)}${NEWLINE}`,
  );
}

export function printAgentFailed(agent: AgentName, exitCode: number): void {
  writeStdout(
    `${NEWLINE}${colorStdout(red, `${figures.cross} ${agent} failed (exit ${exitCode})`)}${NEWLINE}`,
  );
}

export function printChatStatus(message: string): void {
  writeStdout(`${colorStdout(dim, `${figures.info} ${message}`)}${NEWLINE}`);
}

export function printChatError(message: string): void {
  writeStderr(`${colorStderr(red, `${figures.cross} ${message}`)}${NEWLINE}`);
}

export function printCouncilDispatch(agents: readonly AgentName[]): void {
  writeStdout(
    `${NEWLINE}${colorStdout(yellow, "[council]")} ${String(agents.length)} agents dispatched...${NEWLINE}`,
  );
}

export function printCouncilProgress(
  agent: AgentName,
  status: "running" | "done" | "failed",
): void {
  const icon =
    status === "done" ? figures.tick : status === "failed" ? figures.cross : figures.ellipsis;
  const color = status === "done" ? green : status === "failed" ? red : dim;
  writeStdout(`${colorStdout(dim, "├─")} ${colorStdout(color, `${icon} ${agent}`)}${NEWLINE}`);
}

export function printDebateEvent(event: DebateUiEvent): void {
  if (event.kind === "debate.round-start") {
    writeStdout(`${NEWLINE}${colorStdout(yellow, "[debate]")} ${event.label}${NEWLINE}`);
    return;
  }
  if (event.kind === "debate.round-complete") {
    writeStdout(`${colorStdout(dim, `${figures.tick} ${event.label} complete`)}${NEWLINE}`);
    return;
  }
  writeStdout(debateAgentLine(event));
}

export function printSessionInfo(sessionId: string, messageCount: number): void {
  writeStdout(
    `${colorStdout(dim, `Session: ${sessionId} (${String(messageCount)} messages)`)}${NEWLINE}`,
  );
}

function colorStdout(format: (value: string) => string, value: string): string {
  return shouldColor(process.stdout) ? format(value) : value;
}

function debateAgentLine(
  event: Extract<DebateUiEvent, { readonly kind: "debate.agent-result" }>,
): string {
  const badge = `[${event.outcome}]`;
  const summary = event.summary === undefined ? "" : ` - ${event.summary}`;
  return `${colorStdout(dim, "├─")} ${event.agent} · ${colorOutcome(event.outcome, badge)}${summary}${NEWLINE}`;
}

function colorOutcome(outcome: string, value: string): string {
  if (outcome === "ok") return colorStdout(green, value);
  if (outcome === "empty") return colorStdout(yellow, value);
  return colorStdout(red, value);
}

function colorStderr(format: (value: string) => string, value: string): string {
  return shouldColor(process.stderr) ? format(value) : value;
}

function shouldColor(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true && process.env[NO_COLOR_ENV] === undefined;
}

function writeStdout(value: string): void {
  if (screenClaimed()) {
    // the Ink cockpit owns the screen — a raw write would corrupt its frame; tee to the sink so the
    // suppressed line survives for diagnostics instead of vanishing.
    appendTuiSuppressed(value);
    return;
  }
  process.stdout.write(value);
}

function writeStderr(value: string): void {
  if (screenClaimed()) {
    // same guard as writeStdout: raw stderr bytes scroll the viewport behind Ink's back (ghost frames).
    appendTuiSuppressed(value);
    return;
  }
  process.stderr.write(value);
}
