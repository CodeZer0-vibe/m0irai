/**
 * @file src/room/room-host-contract.ts
 * @purpose Defines the public configuration and command contracts for AliveRoomHost.
 * @exports RoomHostOptions, RoomSubmit, RoomControl, RoomModeCycle
 * @depends ../chat/headless-turn, ../chat/lane-transport, ../chat/types, ./room-boot-progress, ./room-engine-contract
 */
import type { EagerBootResult, StartEagerSessionBootInput } from "../chat/eager-session-boot.js";
import type { runHeadlessTurn } from "../chat/headless-turn.js";
import type { CarrierRuntimeConfig } from "../chat/lane-transport.js";
import type { AgentName } from "../chat/types.js";
import type { BootProgressReporter } from "./room-boot-progress.js";
import type {
  RoomCancelScope,
  RoomEvent,
  RoomLane,
  RoomLaneResult,
} from "./room-engine-contract.js";

export interface RoomHostOptions {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly blobRoot: string;
  readonly continueSessionId?: `chat-${string}`;
  readonly runLane?: (lane: RoomLane) => Promise<RoomLaneResult>;
  readonly runHeadlessTurn?: typeof runHeadlessTurn;
  readonly appendJournal?: (journalPath: string, line: string) => Promise<void>;
  readonly permissionTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly openConnection?: NonNullable<CarrierRuntimeConfig["openConnection"]>;
  /** Test-only eager-session composition seam; production uses startEagerSessionBoot. */
  readonly startEagerSessionBoot?: (input: StartEagerSessionBootInput) => EagerBootResult;
  readonly onEvent?: (event: RoomEvent) => Promise<void> | void;
  /**
   * Reports which startup stage `AliveRoomHost.create` is inside, so the terminal waiting on
   * `session/new` can renew its deadline on progress instead of guessing a wall clock.
   *
   * Awaited at every stage boundary, and DELIBERATELY not wrapped in a catch here: a reporter that
   * cannot write is a dead stdout, which is a dead terminal, and continuing a boot nobody can see is
   * worse than failing it. The production reporter is the one in `zer0-v2-host.ts`; absent (every
   * unit test that builds a host directly) the boot runs exactly as it did before.
   */
  readonly onBootProgress?: BootProgressReporter;
}

export interface RoomSubmit {
  readonly requestId: string;
  readonly text: string;
}

export interface RoomControl {
  readonly requestId: string;
  readonly command: "pause" | "resume" | "cancel";
  readonly scope?: RoomCancelScope;
  readonly agent?: AgentName;
}

export interface RoomModeCycle {
  readonly requestId: string;
  readonly text: string;
}
