/**
 * @file src/room/room-eager-sessions.ts
 * @purpose Coordinate V2 background ACP warm-up behind a shared readiness barrier.
 * @exports RoomEagerSessions
 * @depends ../chat/eager-session-boot, ../chat/events, ../chat/lane-transport, ../memory/memory-flags, ../shared/hermetic
 */
import {
  type EagerAgentOutcome,
  type EagerBootResult,
  type StartEagerSessionBootInput,
  startEagerSessionBoot,
} from "../chat/eager-session-boot.js";
import type { ChatEventBus } from "../chat/events.js";
import { type SetLaneModeOutcome, carrierRuntime, setLaneMode } from "../chat/lane-transport.js";
import { carrierEnabled } from "../memory/memory-flags.js";
import { hermeticEnabled } from "../shared/hermetic.js";

type StartEagerBoot = (input: StartEagerSessionBootInput) => EagerBootResult;

export class RoomEagerSessions {
  private boot: EagerBootResult | undefined;

  public constructor(
    private readonly startBoot: StartEagerBoot = startEagerSessionBoot,
    private readonly forceFresh = false,
  ) {}

  public start(bus: ChatEventBus, signal: AbortSignal): void {
    if (this.boot !== undefined || !carrierEnabled() || hermeticEnabled()) return;
    const runtime = carrierRuntime();
    if (runtime === undefined || runtime.lanesEnabled !== true) return;
    this.boot = this.startBoot({
      db: runtime.db,
      projectId: runtime.projectId,
      ...(runtime.laneScopeId.length === 0 ? {} : { laneScopeId: runtime.laneScopeId }),
      repoRoot: runtime.repoRoot,
      cwd: runtime.cwd,
      bus,
      signal,
      ...(this.forceFresh ? { forceFresh: true } : {}),
    });
  }

  public async setMode(agent: "claude" | "codex", modeId: string): Promise<SetLaneModeOutcome> {
    const warmup = this.boot?.[agent];
    if (warmup !== undefined) {
      const outcome = await warmup;
      if (outcome.outcome === "unavailable") {
        const recovered = await setLaneMode(agent, modeId);
        return recovered.outcome === "noSession"
          ? { outcome: "failed", reason: outcome.reason }
          : recovered;
      }
    }
    return setLaneMode(agent, modeId);
  }

  public async wait(agent: "claude" | "codex"): Promise<EagerAgentOutcome> {
    const warmup = this.boot?.[agent];
    if (warmup === undefined)
      return { outcome: "unavailable", reason: `${agent} session is not warming up` };
    return warmup;
  }
}
