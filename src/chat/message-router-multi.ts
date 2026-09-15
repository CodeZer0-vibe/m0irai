/**
 * @file src/chat/message-router-multi.ts
 * @purpose Detect which agents a message ADDRESSES and return one segment per DISTINCT addressed agent, each
 *   carrying the FULL message (the team-aware agent does its own part). Addressed = @-tagged / clause-boundary
 *   (,;.) / whitespace-run / and·then-joined; casual prose ("tell claude and gemini apart") + code tokens
 *   ("gemini.write", "obj.gemini") are NOT (the false-positive guard). WRITE-capable "build" mode requires an
 *   explicit @-tag on that agent (per-segment), so casual prose / pasted code can never dispatch a write-
 *   capable agent — the trust boundary. See writeCapableGrant.
 * @exports AddressSegment, parseMultiAddress
 * @depends ../shared/types, ./message-router-intent, ./types
 */
import { type AgentGrant, BUILD_GRANT, CHAT_GRANT, RESEARCH_GRANT } from "../shared/agent-grant.js";
import { detectIntent } from "./message-router-intent.js";
import type { AgentName, ChatIntent } from "./types.js";

/** One addressed agent + its task (full message) + grant + the prior teammates this task must run after. */
export interface AddressSegment {
  readonly agent: AgentName;
  readonly prompt: string;
  readonly grant: AgentGrant;
  /** Earlier-addressed teammates this segment must run AFTER — its clause names one or refers to prior work.
   *  Empty = independent → runs in the first parallel wave. The wave scheduler (headless-waves) reads this. */
  readonly dependsOn: readonly AgentName[];
}

// A clause that ACTS ON prior work — an action verb (review/audit/use/read/…) on a pronoun/"the" — or an
// explicit sequencing phrase. Signals this segment depends on a teammate's output. "write … about that" does
// NOT match (write creates; "about" is not an action-on-prior verb), so a fresh "research X and write an md"
// stays independent. The detector errs toward DEPENDENT (a missed dep = stale input; a spurious dep = only slower).
const REFERS_TO_PRIOR =
  /\b(?:review|audit|check|fix|improve|refine|use|read|extend|continue|critique|test|run|merge|apply|verify|validate|expand|polish|incorporate|address)\s+(?:it|its|that|this|them|those|these|the)\b/i;
const SEQUENCED = /\b(?:based on|when .{0,14}done|once .{0,10}done|after (?:that|it|this|the))\b/i;
// A sequencing cue in the GAP before a name ("… then codex", "once claude is done, codex", "when … codex",
// "after that, codex") → this segment runs AFTER the prior. Broad on purpose: a false match only over-
// serializes (safe); a miss dispatches with stale input (the W42 trap). "and"/"," gaps don't match, so a
// conjunction ("claude and codex") stays parallel.
const GAP_SEQUENCED = /\b(?:then|once|when|after)\b/i;

interface Occurrence {
  readonly agent: AgentName;
  readonly at: boolean;
  readonly start: number;
  readonly end: number;
}

const OCC_RE = /(@)?\b(claude|codex|gemini)\b/gi;
// A name immediately followed by one of these is a CODE/PATH token, not an address: gemini.write, gemini(,
// src/gemini, gemini-cli, gemini\x, gemini[0], gemini?.x (optional chaining). A space/comma/?-then-space/end
// after the name is fine. Paired with the whitespace-before guard in classify(), this rejects pasted code.
const CODE_FOLLOW = /^(?:[.(/\\[-]|\?[.([])/;

/**
 * Parses a message into one segment per DISTINCT addressed agent (in first-appearance order), each carrying
 * the full message; or null when no agent is addressed (→ the caller falls back to keyword routing). Every
 * addressed agent receives the same full task — being team-aware, each does only its own part.
 *
 * @param text - the operator's raw message
 * @returns the ordered distinct segments (≥1) or null
 */
export function parseMultiAddress(text: string): readonly AddressSegment[] | null {
  const trimmed = text.trim();
  const occ: Occurrence[] = [...trimmed.matchAll(OCC_RE)].map((m) => {
    const start = m.index ?? 0;
    return {
      agent: (m[2] ?? "").toLowerCase() as AgentName,
      at: m[1] === "@",
      start,
      end: start + m[0].length,
    };
  });
  if (occ.length === 0) {
    return null;
  }
  const reasons = computeAddressed(trimmed, occ);
  const addressed: AgentName[] = [];
  const idx: number[] = [];
  const seen = new Set<AgentName>();
  for (let i = 0; i < occ.length; i += 1) {
    const o = occ[i];
    if (o === undefined || reasons[i] === "no" || seen.has(o.agent)) {
      continue;
    }
    seen.add(o.agent);
    addressed.push(o.agent);
    idx.push(i);
  }
  if (addressed.length === 0) {
    return null;
  }
  const baseGrant = grantForIntent(detectIntent(trimmed));
  const grants = idx.map((i) => writeCapableGrant(baseGrant, reasons[i]));
  const dependsOn = computeDeps(trimmed, occ, idx, addressed);
  return addressed.map((agent, k) => ({
    agent,
    prompt: trimmed,
    grant: grants[k] ?? CHAT_GRANT,
    dependsOn: dependsOn[k] ?? [],
  }));
}

// Per-segment dependency = CAUSALITY only: the prior teammates a segment must run AFTER because its task needs
// their output — it NAMES a prior teammate in its clause, or REFERS_TO_PRIOR / is SEQUENCED ("based on the
// plan"). Independent (empty) → runs in the first parallel wave. NOTE: this does NOT serialize concurrent
// WRITES — two independent write tasks run in parallel in the shared cwd (fine for different files; worktree
// isolation is the future fix for same-file collisions). Errs toward DEPENDENT (a missed dep = stale input).
function computeDeps(
  text: string,
  occ: readonly Occurrence[],
  idx: readonly number[],
  addressed: readonly AgentName[],
): AgentName[][] {
  const addressedSet = new Set(addressed);
  const deps: AgentName[][] = [];
  for (let k = 0; k < addressed.length; k += 1) {
    const start = occ[idx[k] ?? -1]?.start ?? 0;
    const next = idx[k + 1];
    const end = next !== undefined ? (occ[next]?.start ?? text.length) : text.length;
    const me = addressed[k];
    const namesTeammate = occ.some(
      (o) => o.start > start && o.start < end && addressedSet.has(o.agent) && o.agent !== me,
    );
    // A sequencing cue in the gap BEFORE this name ("claude plan THEN codex", "once claude is done, codex")
    // sequences it after the prior — the cue lives between the names, not in this clause, so check the gap.
    // "and" is a conjunction (both act on the same external thing), NOT a dependency, so it does not match.
    const prevEnd = k > 0 ? (occ[idx[k - 1] ?? -1]?.end ?? 0) : 0;
    const sequenced = k > 0 && GAP_SEQUENCED.test(text.slice(prevEnd, start));
    const dependent = sequenced || namesTeammate || refersToPrior(text.slice(start, end));
    deps.push(dependent ? [...addressed.slice(0, k)] : []);
  }
  return deps;
}

// A clause that acts on prior work or is explicitly sequenced after it (see the REFERS_TO_PRIOR / SEQUENCED
// patterns). Extracted so computeDeps stays under the complexity ceiling.
function refersToPrior(clause: string): boolean {
  return REFERS_TO_PRIOR.test(clause) || SEQUENCED.test(clause);
}

// WHY an occurrence is (or isn't) an address. HARD anchors ("at" @-tag / "start" message-start / "punct"
// clause punctuation , ; .) signal DELIBERATE addressing; SOFT signals ("run" whitespace adjacency /
// "connector" and·then) are weaker. writeCapableMode uses the hard/soft split to gate write-capability.
type Reason = "no" | "at" | "start" | "punct" | "run" | "connector";

// Classifies each name occurrence left-to-right. `reasons` holds prior verdicts so the and/then connector can
// require an already-accepted predecessor (keeps "tell claude and gemini apart" a non-address).
function computeAddressed(text: string, occ: readonly Occurrence[]): readonly Reason[] {
  const reasons: Reason[] = [];
  for (let i = 0; i < occ.length; i += 1) {
    reasons.push(classify(text, occ, i, reasons));
  }
  return reasons;
}

function classify(
  text: string,
  occ: readonly Occurrence[],
  i: number,
  reasons: readonly Reason[],
): Reason {
  const here = occ[i];
  if (here === undefined || CODE_FOLLOW.test(text.slice(here.end, here.end + 2))) {
    return "no";
  }
  if (here.at) {
    return isTagBoundary(text, here.start) ? "at" : "no";
  }
  if (here.start === 0) {
    return "start";
  }
  // The name MUST be whitespace-separated from preceding text; a glued form (obj.gemini, x=gemini,
  // src/gemini) is a code/identifier token, never an address (closes the pasted-code → write-dispatch hole).
  if (!/\s/.test(text.charAt(here.start - 1))) {
    return "no";
  }
  const before = text.slice(0, here.start).replace(/\s+$/, "");
  // Clause boundary: message start or prior text ending in , ; . — a NEWLINE is NOT a boundary (multi-line
  // input is indistinguishable from pasted multi-line code, which would reopen the write-dispatch hole).
  if (before.length === 0 || /[,;.]$/.test(before)) {
    return "punct";
  }
  return softReason(text, occ, i, reasons, before);
}

// A literal "@" is a REAL tag only at message start or after whitespace/punctuation — never glued inside a
// token ("e@claude" / "user@codex" is an email, not an address). Otherwise an embedded @ would authorize
// write (round-5 edge): the @-tag is the sole write-capability grant downstream, so it must be boundary-real.
function isTagBoundary(text: string, atIndex: number): boolean {
  const before = atIndex === 0 ? "" : text.charAt(atIndex - 1);
  return before === "" || /[\s,;.]/.test(before);
}

// SOFT addressing for a non-anchored name: a whitespace-adjacent run ("codex claude gemini"), or "and"/"then"
// joined to an already-accepted name ("claude plan THEN codex build"). \b stops "command"/"strengthen"
// matching; the accepted-predecessor guard keeps "tell claude and gemini apart" a non-address.
function softReason(
  text: string,
  occ: readonly Occurrence[],
  i: number,
  reasons: readonly Reason[],
  before: string,
): Reason {
  const here = occ[i];
  if (here === undefined) {
    return "no";
  }
  const prev = occ[i - 1];
  const next = occ[i + 1];
  const pureWs = (from: number, to: number): boolean => /^\s*$/.test(text.slice(from, to));
  if (prev !== undefined && pureWs(prev.end, here.start)) {
    return "run";
  }
  if (next !== undefined && pureWs(here.end, next.start)) {
    return "run";
  }
  if (/\b(?:and|then)$/i.test(before) && reasons.some((r) => r !== "no")) {
    return "connector";
  }
  return "no";
}

// The worktree (build) grant is granted ONLY to an @-tagged agent (reason "at"). Bare/soft addressing
// (start/punct/run/connector) degrades a build grant to CHAT_GRANT, so NO prose or pasted code can dispatch a
// worktree-scoped build without the operator's explicit "@" — a literal token free text cannot fabricate (the
// trust boundary; X0-preserved from writeCapableMode). The operator mixes per-agent: "claude plan, @codex
// implement it" → claude reads, codex writes. research/chat grants (worktree false) pass through unchanged.
function writeCapableGrant(base: AgentGrant, reason: Reason | undefined): AgentGrant {
  return base.worktree && reason !== "at" ? CHAT_GRANT : base;
}

// The adapter grant the message's intent implies: build-family → BUILD_GRANT (worktree); research →
// RESEARCH_GRANT (web + max effort); everything else → CHAT_GRANT.
function grantForIntent(intent: ChatIntent): AgentGrant {
  if (intent === "build" || intent === "create" || intent === "fix") {
    return BUILD_GRANT;
  }
  if (intent === "research") {
    return RESEARCH_GRANT;
  }
  return CHAT_GRANT;
}
