/**
 * @file src/room/room-mode.ts
 * @purpose Own the room's real native-mode cycle: provider calls, durable intent, and strict room events.
 * @exports RoomModeController, RoomModeEventPayload
 * @depends existing chat native-mode, mode-tier, lane-transport, AGY mode, and room protocol owners
 */
import { setAgentMode } from "../adapters/agent-mode-store.js";
import type { ModeSessionEvent } from "../chat/events.js";
import { type SetLaneModeOutcome, setLaneMode } from "../chat/lane-transport.js";
import {
  type StanceTier,
  TIER_ANCHORS,
  nextTier,
  seedUnifiedTier,
  tierOf,
} from "../chat/mode-tier.js";
import { bootNativeModeState, persistNativeMode } from "../chat/native-mode-store.js";
import {
  MODE_CATALOG,
  type NativeModeState,
  applyActive,
  applyAdopted,
  applyCatalog,
  applyFailed,
  effectiveCatalog,
  nextModeId,
} from "../chat/native-mode.js";
import { ALL_ENGINE_TARGETS, resolveModeTargets } from "../chat/resolve-mode-targets.js";
import type { AgentName } from "../chat/types.js";
import { escapeUntrusted } from "../shared/render-escape.js";
import { isSafeRoomWireText } from "./room-protocol.js";
import { type ModeWord, modeWord } from "./status-mode-language.js";

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
const MAX_MODE_ID_LENGTH = 128;
const MAX_MODE_ERROR_LENGTH = 240;
const MAX_MODE_CATALOG_ITEMS = 32;

export interface RoomModeEventPayload {
  readonly agent: AgentName;
  readonly modeId: string;
  readonly status: "active" | "pending" | "failed";
  readonly word?: ModeWord;
  readonly error?: string;
  readonly availableModeIds?: readonly string[];
}

interface RoomModeControllerOptions {
  readonly repoRoot: string;
  readonly emit: (payload: RoomModeEventPayload) => void;
  readonly boot?: typeof bootNativeModeState;
  readonly persist?: typeof persistNativeMode;
  readonly setLaneMode?: (agent: "claude" | "codex", modeId: string) => Promise<SetLaneModeOutcome>;
  readonly setAgentMode?: typeof setAgentMode;
}

/**
 * The Node host is the only owner allowed to alter provider modes. Rust sends a text-bearing cycle
 * command and renders these events; it never carries a shadow provider catalog.
 */
export class RoomModeController {
  private state: NativeModeState;
  private lastUnifiedTier: StanceTier;
  private readonly persisted: boolean;
  /** The known working mode before an ACP no-session request waits for its later `mode.session`. */
  private readonly pendingPrior = new Map<"claude" | "codex", string>();
  private readonly emit: (payload: RoomModeEventPayload) => void;
  private readonly persist: typeof persistNativeMode;
  private readonly setLaneMode: (
    agent: "claude" | "codex",
    modeId: string,
  ) => Promise<SetLaneModeOutcome>;
  private readonly setAgentMode: typeof setAgentMode;

  public constructor(private readonly options: RoomModeControllerOptions) {
    const boot = (options.boot ?? bootNativeModeState)(options.repoRoot);
    this.state = boot.state;
    this.persisted = boot.persisted;
    this.lastUnifiedTier = seedUnifiedTier(this.state);
    this.emit = options.emit;
    this.persist = options.persist ?? persistNativeMode;
    this.setLaneMode = options.setLaneMode ?? setLaneMode;
    this.setAgentMode = options.setAgentMode ?? setAgentMode;
  }

  /** Apply AGY's selected mode at boot; Gemini's local mode is authoritative even when fresh. */
  public boot(): void {
    try {
      this.setAgentMode("gemini", this.state.gemini.modeId);
      this.emitMode("gemini", "active");
    } catch (error) {
      this.emitMode("gemini", "failed", safeReason(error));
    }
    if (this.persisted)
      for (const agent of ["claude", "codex"] as const) this.emitMode(agent, "active");
  }

  /** Shift+Tab entrypoint. It always resolves after recording success, pending intent, or failure. */
  public async cycle(composerText: string): Promise<void> {
    const targets = resolveModeTargets(composerText);
    if (targets === ALL_ENGINE_TARGETS) {
      const targetTier = nextTier(this.lastUnifiedTier);
      await Promise.all(
        AGENTS.map((agent) => this.cycleOne(agent, TIER_ANCHORS[targetTier][agent])),
      );
      return;
    }
    const planned = targets.map((agent) => {
      const slice = this.state[agent];
      return [agent, nextModeId(agent, slice.modeId, effectiveCatalog(agent, slice))] as const;
    });
    await Promise.all(planned.map(([agent, modeId]) => this.cycleOne(agent, modeId)));
  }

  /** Reconcile the actual ACP session notification without inventing an AGY session equivalent. */
  public onModeSession(event: ModeSessionEvent): void {
    if (event.agent === "gemini") return;
    const available = safeCatalog(event.availableModeIds);
    if (available !== undefined) this.state = applyCatalog(this.state, event.agent, available);
    const currentModeId = safeModeId(event.modeId);
    if (currentModeId === undefined) {
      const reason = "provider reported an unsafe mode id";
      const priorModeId = this.pendingPrior.get(event.agent);
      this.pendingPrior.delete(event.agent);
      this.state = applyFailed(
        this.state,
        event.agent,
        priorModeId ?? MODE_CATALOG[event.agent][0] ?? "default",
        reason,
      );
      this.updateTierMemory();
      this.emitMode(event.agent, "failed", reason);
      return;
    }
    if (event.outcome === "failed") {
      const priorModeId = this.pendingPrior.get(event.agent);
      this.pendingPrior.delete(event.agent);
      this.state = applyFailed(
        this.state,
        event.agent,
        priorModeId ?? MODE_CATALOG[event.agent][0] ?? "default",
        safeReason(event.reason ?? "setMode failed"),
      );
      this.updateTierMemory();
      this.emitMode(event.agent, "failed", safeReason(event.reason ?? "setMode failed"));
      return;
    }
    const prior = this.state[event.agent];
    this.pendingPrior.delete(event.agent);
    this.state =
      prior.status === "pending" || prior.modeId === currentModeId
        ? applyActive(this.state, event.agent, currentModeId)
        : applyAdopted(this.state, event.agent, currentModeId);
    this.updateTierMemory();
    this.emitMode(event.agent, this.state[event.agent].status === "pending" ? "pending" : "active");
  }

  private async cycleOne(agent: AgentName, targetModeId: string): Promise<void> {
    const priorModeId = this.state[agent].modeId;
    this.state = {
      ...this.state,
      [agent]: { ...this.state[agent], modeId: targetModeId, status: "pending" },
    };
    this.updateTierMemory();
    this.emitMode(agent, "pending");
    if (agent === "gemini") {
      try {
        this.setAgentMode("gemini", targetModeId);
        this.state = applyActive(this.state, agent, targetModeId);
        this.updateTierMemory();
        this.emitMode(agent, "active", this.persistWarning());
      } catch (error) {
        const reason = safeReason(error);
        this.state = applyFailed(this.state, agent, priorModeId, reason);
        this.updateTierMemory();
        this.emitMode(agent, "failed", reason);
      }
      return;
    }
    try {
      const outcome = await this.setLaneMode(agent, targetModeId);
      if (outcome.outcome === "failed") {
        const reason = safeReason(outcome.reason);
        this.state = applyFailed(this.state, agent, priorModeId, reason);
        this.updateTierMemory();
        this.emitMode(agent, "failed", reason);
        return;
      }
      if (outcome.outcome === "applied") {
        this.pendingPrior.delete(agent);
        this.state = applyActive(this.state, agent, targetModeId);
      } else {
        this.pendingPrior.set(agent, priorModeId);
      }
      this.updateTierMemory();
      this.emitMode(
        agent,
        outcome.outcome === "noSession" ? "pending" : "active",
        this.persistWarning(),
      );
    } catch (error) {
      const reason = safeReason(error);
      this.state = applyFailed(this.state, agent, priorModeId, reason);
      this.updateTierMemory();
      this.emitMode(agent, "failed", reason);
    }
  }

  private persistWarning(): string | undefined {
    const outcome = this.persist(this.options.repoRoot, this.state);
    return outcome.outcome === "failed" ? safeReason(outcome.reason) : undefined;
  }

  private emitMode(
    agent: AgentName,
    status: "active" | "pending" | "failed",
    error?: string,
  ): void {
    const slice = this.state[agent];
    const catalog = safeCatalog(slice.catalog);
    const word = modeWord(agent, slice.modeId);
    const payload = {
      agent,
      modeId: slice.modeId,
      status,
    };
    this.emit({
      ...payload,
      ...(word === undefined ? {} : { word }),
      ...(error === undefined ? {} : { error }),
      ...(catalog === undefined ? {} : { availableModeIds: catalog }),
    });
  }

  private updateTierMemory(): void {
    const tier = tierOf(this.state);
    if (tier !== "mixed") this.lastUnifiedTier = tier;
  }
}

function safeCatalog(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    value.length > MAX_MODE_CATALOG_ITEMS ||
    !value.every((modeId) => safeModeId(modeId) !== undefined) ||
    new Set(value).size !== value.length
  )
    return undefined;
  return value;
}

function safeModeId(value: string): string | undefined {
  return isSafeRoomWireText(value, MAX_MODE_ID_LENGTH) ? value : undefined;
}

function safeReason(value: unknown): string {
  const escaped = escapeUntrusted(value instanceof Error ? value.message : String(value), {
    maxLen: MAX_MODE_ERROR_LENGTH,
  });
  return escaped.length > 0 ? escaped : "mode update failed";
}
