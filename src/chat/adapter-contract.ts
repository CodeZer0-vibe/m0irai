/**
 * @file src/chat/adapter-contract.ts
 * @purpose [moved out of the tower's types module — plan v5 Phase 3.1 seam: the room's carrier/lane code (tower-bridge-lane) depends on this contract; the tower itself left in 3.6 own it] Shared in-memory protocol types for the control tower's native-agent transport. Defines the single `NativeAgentAdapter` interface every per-agent lane (codex/gemini/claude, LATER tasks) implements, plus the `AdapterEvent`/`Proposal`/`Decision` shapes the tower reads and writes. NO DB, NO per-agent sequences, NO transport code — types only.
 * @exports Verdict, ProposalKind, Proposal, Decision, AdapterEventKind, AdapterEvent, StartOpts, NativeAgentAdapter
 * @depends (none)
 */

/**
 * Operator verdict for a single proposal.
 * - `allow`: run the proposed tool/command/edit (optionally with `modifiedInput`).
 * - `deny_continue`: reject this proposal but let the agent keep its turn.
 * - `deny_interrupt`: reject and interrupt the agent's current turn.
 */
export type Verdict = "allow" | "deny_continue" | "deny_interrupt";

/**
 * Category of an action awaiting a decision. `tool` covers a native tool call,
 * `command` a shell/command execution, `edit` a file mutation.
 */
export type ProposalKind = "tool" | "command" | "edit";

/**
 * One action the native agent wants to take, surfaced to the operator for a
 * verdict. `correlationId` is the join key: the tower's `decide(correlationId, …)`
 * resolves exactly this proposal, exactly once (INV-5).
 */
export interface Proposal {
  /** Unique id joining this proposal to its eventual decision. */
  readonly correlationId: string;
  /** Whether the proposed action is a tool call, command, or edit. */
  readonly kind: ProposalKind;
  /** Human-facing label (e.g. the tool name) for the operator surface. */
  readonly title: string;
  /** Raw, agent-native request payload (e.g. tool input) — opaque to the tower. */
  readonly payload: unknown;
}

/**
 * The operator's verdict for ONE proposal. `modifiedInput`, when present on an
 * `allow`, replaces the agent's proposed input; `reason` annotates a denial.
 */
export interface Decision {
  /** Allow / deny-continue / deny-interrupt. */
  readonly verdict: Verdict;
  /** On allow, an edited input that replaces the proposed payload. */
  readonly modifiedInput?: unknown;
  /** On deny, an operator-facing explanation forwarded to the agent. */
  readonly reason?: string;
}

/**
 * A single event read from one agent lane. `proposal` carries a {@link Proposal}
 * awaiting `decide`; `output` carries streamed agent text; `turn_end` marks the
 * end of an agent turn; `status` carries a lifecycle note; `error` carries a
 * fatal/transport failure for the lane.
 */
export type AdapterEvent =
  | { readonly kind: "proposal"; readonly proposal: Proposal }
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "turn_end" }
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Discriminant for the events a lane emits on its stream. Derived from
 * {@link AdapterEvent} so the kind set can never drift from the union.
 *
 * @public Tower/lane protocol surface consumed by the per-agent adapters (T4–T6).
 */
export type AdapterEventKind = AdapterEvent["kind"];

/**
 * Options handed to {@link NativeAgentAdapter.start}. Generic across agents;
 * per-agent launch flags are NOT modeled here (those live in each lane, LATER).
 */
export interface StartOpts {
  /** Working directory for the spawned native agent. */
  readonly cwd: string;
  /** The first instruction/prompt to drive the agent. */
  readonly prompt: string;
}

/**
 * The one interface a supervisor uses to drive a single native agent lane: spawn
 * it (mediated / fail-closed), read its event stream, decide each proposal
 * exactly once, steer a follow-up, and tear down its whole process tree.
 *
 * Implementations are per-agent (codex/gemini/claude) and are OUT OF SCOPE here.
 *
 * @public The shared contract the per-agent lanes (T4–T6) implement; this is the
 * cross-task public API surface of the tower transport core.
 */
export interface NativeAgentAdapter {
  /**
   * Spawns the native agent under mediation. Resolves once the lane is live and
   * the event stream is readable; rejects (fail-closed) if the child cannot be
   * spawned mediated.
   */
  start(opts: StartOpts): Promise<void>;

  /**
   * The lane's event stream. At minimum yields `proposal`, `output`, `turn_end`,
   * `status`, and `error` events for the tower to render.
   */
  events(): AsyncIterable<AdapterEvent>;

  /**
   * Sends the operator's verdict for ONE proposal. MUST resolve a given
   * `correlationId` EXACTLY ONCE (INV-5): a second `decide` for the same id is
   * rejected and never double-sent to the agent.
   */
  decide(correlationId: string, decision: Decision): void | Promise<void>;

  /** Injects a follow-up instruction into the live agent turn. */
  steer(text: string): Promise<void>;

  /**
   * Terminates the child's whole PID tree. Idempotent; leaves no orphan
   * grandchild process behind.
   */
  close(): Promise<void>;
}
