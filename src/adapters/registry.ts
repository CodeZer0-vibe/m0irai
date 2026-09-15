/**
 * @file src/adapters/registry.ts
 * @purpose Adapter registry keyed by agent name; failover chain on transient errors.
 * @exports getAdapter, AdapterRegistry
 * @depends ./claude, ./codex, ./agy, ./types, ../shared/types, ../shared/errors
 */
import { dispatchModeToGrant } from "../shared/agent-grant.js";
import { DispatchError } from "../shared/errors.js";
import type {
  AgentAdapter,
  AgentHealth,
  AgentName,
  AgentResult,
  DispatchMode,
} from "../shared/types.js";
import { dispatchAgy } from "./agy.js";
import { dispatchClaude } from "./claude.js";
import { dispatchCodex } from "./codex.js";
import { AdapterCommand, type AgentInput } from "./types.js";

type DispatchFunction = {
  (input: AgentInput): Promise<AgentResult>;
  buildCommand(input: AgentInput): AdapterCommand;
  parseOutput(raw: string): AgentResult;
  healthCheck(signal: AbortSignal): Promise<AgentHealth>;
};

// claude removed from failover: its registry dispatch is RETIRED (below) — failing over INTO a
// retired lane would turn a codex/gemini hiccup into a hard error for no benefit.
const DEFAULT_FAILOVER_CHAIN: readonly AgentName[] = ["codex", "gemini"];
const TRANSIENT_EXIT_CODES: ReadonlySet<number> = new Set([124, 130, 143]);
const FAILURE_EXIT_CODE: number = 1;

// RETIRED-2026-06-15 (W1-T0): `claude -p` bills to the API credit pool from 2026-06-15; product
// chat routes claude through the interactive pty (src/chat/dispatch-pty.ts) on the flat
// subscription, and build-pillar reviews ride the dispatch.sh tooling lane. dispatch/buildCommand
// fail LOUD so no path can silently spawn a metered `-p` child; healthCheck (doctor) and
// parseOutput (transcript parsing) remain live. Guarded by scripts/gate-no-claude-p.mjs.
const CLAUDE_RETIRED_MESSAGE: string =
  "claude registry dispatch RETIRED-2026-06-15: `claude -p` is API-credit billed. Chat uses the interactive pty path (dispatch-pty); reviews use the dispatch.sh tooling lane.";

const retiredClaude: DispatchFunction = Object.assign(
  (_input: AgentInput): Promise<AgentResult> =>
    Promise.reject(new DispatchError(CLAUDE_RETIRED_MESSAGE, "claude", FAILURE_EXIT_CODE)),
  {
    buildCommand: (_input: AgentInput): AdapterCommand => {
      throw new DispatchError(CLAUDE_RETIRED_MESSAGE, "claude", FAILURE_EXIT_CODE);
    },
    healthCheck: dispatchClaude.healthCheck,
    parseOutput: dispatchClaude.parseOutput,
  },
);

const DEFAULT_DISPATCHERS: Record<AgentName, DispatchFunction> = {
  claude: retiredClaude,
  codex: dispatchCodex,
  gemini: dispatchAgy,
};

/**
 * Registry facade for resolving agent adapters.
 */
export class AdapterRegistry {
  private readonly dispatchers: Record<AgentName, DispatchFunction>;

  /**
   * Creates an adapter registry with the production CLI dispatchers.
   */
  public constructor() {
    this.dispatchers = DEFAULT_DISPATCHERS;
  }

  /**
   * Resolves an adapter by agent name.
   *
   * @param name - agent family to resolve
   * @returns shared AgentAdapter compatibility wrapper for the agent
   */
  public getAdapter(name: AgentName): AgentAdapter {
    const dispatch = this.dispatchers[name];
    return {
      buildCommand: (contextFile: string, worktreePath: string, mode: DispatchMode): string =>
        serializeCommand(
          dispatch.buildCommand(inputFor(name, contextFile, worktreePath, inertSignal(), mode)),
        ),
      healthCheck: (): Promise<AgentHealth> => dispatch.healthCheck(inertSignal()),
      name,
      parseOutput: dispatch.parseOutput,
    };
  }

  /**
   * Dispatches the input through the exact requested agent.
   *
   * @param input - agent dispatch input containing the caller AbortSignal
   * @returns parsed agent result
   */
  public async dispatch(input: AgentInput): Promise<AgentResult> {
    return this.dispatchers[input.agent](input);
  }

  /**
   * Dispatches through a deterministic failover chain for transient failures.
   *
   * @param input - dispatch input used as the base for each attempted agent
   * @param chain - ordered agent names to try
   * @returns first successful parsed agent result
   * @throws DispatchError when every candidate fails transiently or a non-transient error occurs
   */
  public async dispatchWithFailover(
    input: AgentInput,
    chain: readonly AgentName[] = DEFAULT_FAILOVER_CHAIN,
  ): Promise<AgentResult> {
    let lastError: DispatchError | undefined;
    for (const agent of orderedAgents(input.agent, chain)) {
      try {
        return await this.dispatch({ ...input, agent });
      } catch (error) {
        const dispatchError = toDispatchError(error, agent);
        if (!isTransient(dispatchError)) {
          throw dispatchError;
        }
        lastError = dispatchError;
      }
    }
    throw (
      lastError ??
      new DispatchError("No adapter was available for failover", input.agent, FAILURE_EXIT_CODE)
    );
  }

  /**
   * Runs a signal-aware health check for a registered adapter.
   *
   * @param name - agent family to check
   * @param signal - caller cancellation signal passed into execa
   * @returns health status for the requested CLI
   */
  public async healthCheck(name: AgentName, signal: AbortSignal): Promise<AgentHealth> {
    return this.dispatchers[name].healthCheck(signal);
  }
}

/**
 * Resolves a registered adapter by agent name.
 *
 * @param name - agent family to resolve
 * @returns shared AgentAdapter compatibility wrapper for the agent
 */
export function getAdapter(name: AgentName): AgentAdapter {
  return new AdapterRegistry().getAdapter(name);
}

function serializeCommand(command: AdapterCommand): string {
  return JSON.stringify(AdapterCommand.parse(command));
}

function inputFor(
  agent: AgentName,
  contextFile: string,
  worktreePath: string,
  signal: AbortSignal,
  mode: DispatchMode,
): AgentInput {
  // The build-pillar's DispatchMode (buildCommand's public contract) is converted to the adapter-owned
  // grant HERE, at the boundary — the adapters no longer read a chat/research/build lane class (X0).
  // mode is always defined ⇒ a defined grant, but the spread keeps exactOptionalPropertyTypes happy.
  const grant = dispatchModeToGrant(mode);
  return { agent, contextFile, signal, worktreePath, ...(grant !== undefined ? { grant } : {}) };
}

function inertSignal(): AbortSignal {
  return new AbortController().signal;
}

function orderedAgents(primary: AgentName, chain: readonly AgentName[]): readonly AgentName[] {
  return [primary, ...chain.filter((agent) => agent !== primary)];
}

function toDispatchError(error: unknown, agent: AgentName): DispatchError {
  if (error instanceof DispatchError) {
    return error;
  }
  return new DispatchError(
    `Adapter ${agent} failed without typed dispatch context`,
    agent,
    FAILURE_EXIT_CODE,
    "",
    {
      cause: error,
    },
  );
}

function isTransient(error: DispatchError): boolean {
  return TRANSIENT_EXIT_CODES.has(error.exitCode);
}
