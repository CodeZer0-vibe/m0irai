/**
 * @file src/chat/agent-readiness.ts
 * @purpose The room's boot answer to "can this agent work?", as a pure decision over probe outcomes.
 * @exports AgentReadiness, RoomReadiness, ProbeOutcome, UNKNOWN_READINESS, readinessFrom, roomReadinessFrom, isUnusable
 * @depends ./types
 *
 * PURE, AND DELIBERATELY SO. Every spawn, resolve and stat lives in the sibling
 * agent-readiness-probe.ts; this file turns their outcomes into a record and can be tested with no I/O
 * at all. That split is the repo's own (lane-availability.ts pure ⟷ lane-availability-store.ts I/O,
 * stated in that file's header) and it exists because the interesting mistakes here are decisions, not
 * syscalls.
 *
 * ⚠ `unknown` RENDERS AS READY, and that is a standing operator ruling rather than a default. From
 * 2026-07-27, quoted in eager-session-boot.ts: "how about we just say it's online, and if we send a
 * message and it doesn't go through we say offline, and that's it." A probe that timed out is a true
 * statement about OUR INSTRUMENT and says nothing about the agent — the operator watched
 * `◇ gemini offline` and then gemini answered them normally. Only a real failed attempt earns offline.
 */
import type { AgentName } from "./types.js";

/**
 * What the room can say about one agent at boot. Four states, and the two that carry strings carry them
 * because the operator has to be able to act: a chip that says "needs sign-in" without the command is a
 * dead end 26 columns wide.
 */
export type AgentReadiness =
  | { readonly state: "ready" }
  | { readonly state: "needs_login"; readonly command: string }
  | { readonly state: "unusable"; readonly reason: string; readonly remedy: string }
  | { readonly state: "unknown" };

export interface RoomReadiness {
  readonly claude: AgentReadiness;
  readonly codex: AgentReadiness;
  readonly gemini: AgentReadiness;
}

/**
 * What one agent's probes found. Split into the two questions that have different answers and different
 * remedies: an agent can be installed and signed out, or signed in and broken.
 *
 * `installed: "unknown"` and `loggedIn: "unknown"` are first-class. gemini has no login probe at all
 * (agy 1.1.16's `--help` lists no `login`, no `auth`, no `status`), and inventing one would mean
 * spawning `agy models` — a ConPTY spawn budgeting 2.5 s idle and 30 s hard — whose timeout misread as
 * agent-down is the exact defect the 2026-07-27 ruling closed.
 */
export interface ProbeOutcome {
  readonly installed: "yes" | "no" | "unknown";
  readonly loggedIn: "yes" | "no" | "unknown";
  /** Why the install probe said no. Required when `installed` is "no" — see the assertion in readinessFrom. */
  readonly installReason?: string;
  /** How to fix a missing install. Required when `installed` is "no". */
  readonly installRemedy?: string;
  /** The exact sign-in command. Required when `loggedIn` is "no". */
  readonly loginCommand?: string;
}

/** The record every room starts with, before any probe has answered. Frozen: the service replaces the
 *  whole object rather than mutating fields, so a reader sees the old record or the new one and never a
 *  half-written one. */
export const UNKNOWN_READINESS: RoomReadiness = Object.freeze({
  claude: Object.freeze({ state: "unknown" }) as AgentReadiness,
  codex: Object.freeze({ state: "unknown" }) as AgentReadiness,
  gemini: Object.freeze({ state: "unknown" }) as AgentReadiness,
});

/**
 * One agent's probe outcome → its readiness. Install is decided first: an agent that is not there cannot
 * be signed out, and telling an operator to run a sign-in command for a binary they do not have sends
 * them somewhere with no fix at the end of it.
 *
 * PRECONDITIONS, asserted rather than assumed, because both failures are silent at the render: a
 * `needs_login` with no command and an `unusable` with no remedy both paint a chip that states a problem
 * and offers nothing.
 */
export function readinessFrom(outcome: ProbeOutcome): AgentReadiness {
  if (outcome.installed === "no") {
    const reason = requireText(outcome.installReason, "an unusable agent must carry a reason");
    const remedy = requireText(outcome.installRemedy, "an unusable agent must carry a remedy");
    return { state: "unusable", reason, remedy };
  }
  if (outcome.loggedIn === "no") {
    const command = requireText(outcome.loginCommand, "a needs_login agent must carry a command");
    return { state: "needs_login", command };
  }
  // Installed-unknown with a good login answer still reads ready: the login probe ran, which means the
  // binary ran, which is a stronger fact about installation than the resolve probe could have produced.
  if (outcome.loggedIn === "yes") return { state: "ready" };
  return outcome.installed === "yes" ? { state: "ready" } : { state: "unknown" };
}

/** The whole room's record, frozen at every level. */
export function roomReadinessFrom(
  outcomes: Readonly<Record<AgentName, ProbeOutcome>>,
): RoomReadiness {
  return Object.freeze({
    claude: Object.freeze(readinessFrom(outcomes.claude)),
    codex: Object.freeze(readinessFrom(outcomes.codex)),
    gemini: Object.freeze(readinessFrom(outcomes.gemini)),
  });
}

/**
 * The routing predicate, and the ONE place `@all` narrows.
 *
 * ⚠ RULED BY THE OPERATOR (wave spec §14 Q8): `@all` expands to the agents that are not `unusable`.
 * `unknown` and `needs_login` stay IN. `unknown` because we do not act on a probe we did not get — and
 * because a submit that beats the boot probe reads exactly this record, so excluding `unknown` would
 * mean the room silently refused every agent for the first second of its life. `needs_login` because
 * the failure is then real, immediate, and carries its remedy in the row.
 */
export function isUnusable(readiness: AgentReadiness): boolean {
  return readiness.state === "unusable";
}

function requireText(value: string | undefined, message: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(message);
  return value;
}
