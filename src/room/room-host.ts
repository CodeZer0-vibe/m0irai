/**
 * @file src/room/room-host.ts
 * @purpose Own durable room sessions, headless lanes, and room event publication.
 * @exports AliveRoomHost, room host request types.
 * @depends ../chat/*, ./room-boot-stages, ./room-engine, ./room-host-recovery, ./room-process-drain
 * @size-justified: Cohesive room ownership joins lifecycle, persistence, and carrier policy.
 */
import path from "node:path";
import { resolveBootLiveness } from "../chat/boot-liveness.js";
import { createUserMessage } from "../chat/commands.js";
import type { ChatEventBus } from "../chat/events.js";
import { recordChatMessage } from "../chat/evidence.js";
import { laneOutcomeMessage, runHeadlessTurn } from "../chat/headless-turn.js";
import { releaseLaneCarrierLock } from "../chat/lane-carrier.js";
import {
  persistenceOwnerFor,
  resetCarrierDecider,
  resetCarrierRuntime,
  setCarrierDecider,
} from "../chat/lane-transport.js";
import {
  createOperatorPermissionDecider,
  resetPermissionAskRegistry,
  resolveAsk,
  resolveAskOption,
} from "../chat/permission-ask.js";
import { appendMessage, persistSession } from "../chat/session-store.js";
import { bootSimulatedExhausted } from "../chat/simulate-exhausted.js";
import type { AgentName, ChatMessage, ChatSession } from "../chat/types.js";
import { closeDb, openDb } from "../evidence/db.js";
import type { DigestLock } from "../memory/digest-failsafe.js";
import { getSeqForMessage } from "../memory/ledger.js";
import { CHAT_GRANT } from "../shared/agent-grant.js";
import { bootProgressSteps, evidenceMigrationDetail, highestTurn } from "./room-boot-stages.js";
import { RoomEagerSessions } from "./room-eager-sessions.js";
import { assertRoomEventTextFits, boundRoomEventText } from "./room-engine-primitives.js";
import {
  MAX_ROOM_JOURNAL_BYTES,
  MAX_ROOM_JOURNAL_EVENTS,
  RoomEngine,
  type RoomEvent,
  type RoomLane,
  type RoomLaneResult,
  type RoomResyncPage,
  roomLaneIdentity,
} from "./room-engine.js";
import { type RoomHandoff, extractRoomHandoff } from "./room-handoff.js";
import type {
  RoomControl,
  RoomHostOptions,
  RoomModeCycle,
  RoomSubmit,
} from "./room-host-contract.js";
import {
  type RoomLaneOutcome,
  buildSettledRoomLaneResult,
  resolveSettledRoomMessage,
} from "./room-host-outcome.js";
import { roomPermissionDeciderFactory } from "./room-host-permissions.js";
import { reconcileRoomRecovery } from "./room-host-recovery.js";
import {
  type ActivePermissionContext,
  appendJournalLine,
  asError,
  beforeDeadline,
  createRoomBus,
  dropCancelledLaneHold,
  initializeRoomSession,
  loadRoomJournal,
  parseRoomInput,
} from "./room-host-support.js";
import { RoomModeController } from "./room-mode.js";
import { type RoomModelCatalog, RoomModelController } from "./room-models.js";
import { type ProcessDrainResult, drainProcessOwnedTransports } from "./room-process-drain.js";
import { RoomReadinessService } from "./room-readiness-service.js";
import { RoomUsageFold } from "./room-usage-fold.js";

export { parseRoomInput } from "./room-host-support.js";
export type { RoomControl, RoomHostOptions, RoomModeCycle, RoomSubmit };

export class AliveRoomHost {
  private readonly engine: RoomEngine;
  private readonly modes: RoomModeController;
  private session!: ChatSession;
  private turn = 0;
  private sessionWrites: Promise<void> = Promise.resolve();
  private eventWrites: Promise<void> = Promise.resolve();
  private eventFailure: unknown;
  private readonly activePermissionContexts = new Map<AgentName, ActivePermissionContext>();
  private readonly usageCaptureAbort = new AbortController();
  private readonly usageFold = new RoomUsageFold();
  // Slice A: ONE owner of the boot readiness record, for the room's lifetime. Nothing else caches it.
  private readonly readiness = new RoomReadinessService();
  private readonly eagerSessions: RoomEagerSessions;
  private models!: RoomModelController;
  // Resolved ONCE at create(); re-resolving shells git and can disagree with the id this session was written under.
  private resolvedProjectId!: string;
  private livenessLock: DigestLock | undefined;
  private modesBooted = false;
  private released = false;
  private shuttingDown = false;

  private constructor(private readonly options: RoomHostOptions) {
    this.eagerSessions = new RoomEagerSessions(
      options.startEagerSessionBoot,
      options.continueSessionId === undefined,
    );
    this.engine = new RoomEngine({
      runLane: async (lane) => this.runLane(lane),
      onEvent: async (event) => this.publishEvent(event),
      onCancel: async (agent) =>
        dropCancelledLaneHold({
          agent,
          isShuttingDown: () => this.shuttingDown,
          report: (message) => this.engine.notify("room-cancel", "backend.failed", { message }),
        }),
    });
    this.modes = new RoomModeController({
      repoRoot: options.repoRoot,
      emit: (payload) => this.engine.notify("room-mode", "agent.mode", { ...payload }),
      setLaneMode: async (agent, modeId) => this.eagerSessions.setMode(agent, modeId),
    });
  }

  /**
   * HAZARD: every stage below is announced BEFORE it starts, never after. The terminal is waiting on
   * the stage that has NOT finished, so a report emitted on completion names the wrong thing at exactly
   * the moment the operator reads it — and a boot that dies in the last stage would name the one before.
   */
  public static async create(options: RoomHostOptions): Promise<AliveRoomHost> {
    const boot = bootProgressSteps(options.onBootProgress);
    await boot.evidence();
    const bootDb = openDb(options.dbPath);
    let lock: DigestLock | undefined;
    try {
      await boot.liveness();
      const liveness = await resolveBootLiveness(bootDb, options.repoRoot);
      if (liveness.conflict || liveness.projectId === undefined || liveness.lock === undefined) {
        throw new Error("room host requires an exclusive scoped project liveness lock");
      }
      lock = liveness.lock;
      const host = new AliveRoomHost(options);
      resetPermissionAskRegistry();
      host.livenessLock = lock;
      host.resolvedProjectId = liveness.projectId;
      await boot.migrate(evidenceMigrationDetail(bootDb));
      host.session = await initializeRoomSession(
        options,
        liveness.projectId,
        host.usageCaptureAbort.signal,
      );
      host.models = new RoomModelController({
        eager: host.eagerSessions,
        runDir: host.session.runDir,
      });
      await host.models.restore();
      host.engine.bindSession(host.session.id);
      await boot.journal();
      const journal = await host.reconcileRecovery(await host.loadJournal());
      host.usageFold.seed(journal);
      const projection = host.engine.rehydrate(journal);
      await host.engine.invalidateRecoveredRunningLanes(
        projection.lanes.values(),
        projection.terminal,
      );
      await host.engine.invalidateRecoveredPermissions(projection.pendingPermissions.values());
      host.turn = highestTurn(host.session);
      setCarrierDecider(roomPermissionDeciderFactory(host.activePermissionContexts));
      return host;
    } catch (error) {
      resetPermissionAskRegistry();
      resetCarrierDecider();
      resetCarrierRuntime();
      if (lock !== undefined) releaseLaneCarrierLock(lock);
      throw error;
    } finally {
      closeDb(bootDb);
    }
  }

  /** The readiness record, for the host's `zer0/room/agents` handler. One owner, one accessor. */
  public agentReadiness(): RoomReadinessService {
    return this.readiness;
  }

  public sessionId(): string {
    return this.session.id;
  }

  /** The canonical project identity this room was created under (resolved once, never re-derived). */
  public projectId(): string {
    return this.resolvedProjectId;
  }

  public eventsAfter(eventSeq: string): readonly RoomEvent[] {
    return this.engine.resync(eventSeq);
  }

  public eventsPageAfter(eventSeq: string): RoomResyncPage {
    return this.engine.resyncPage(eventSeq);
  }

  public activateRecovered(): Promise<void> {
    if (!this.modesBooted) {
      this.modesBooted = true;
      this.modes.boot();
      this.eagerSessions.start(this.createBus("room-boot"), this.usageCaptureAbort.signal);
      // ZER0_SIMULATE_EXHAUSTED, the operator's viewing aid: it retires a previous run's fake, then
      // paints this run's. Unset — every real run — both halves are no-ops. See the seam's own header.
      const journal = this.engine.events();
      bootSimulatedExhausted(this.createBus.bind(this), journal, this.options.repoRoot);
      // Detached, never awaited: the room paints its first frame without waiting for any subprocess.
      void this.readiness.start({ sink: { debug: () => undefined } });
    }
    return this.engine.activateRecovered();
  }

  public async submit(request: RoomSubmit): Promise<{
    readonly requestId: string;
    readonly turnId: string;
    readonly messageId: string;
    readonly ledgerSeq: string;
    readonly targets: readonly AgentName[];
  }> {
    if (request.text.trim().length === 0) throw new Error("room submit text must be non-empty");
    const parsed = parseRoomInput(request.text, this.session.defaultAgent);
    if (parsed.route.agents.length === 0) throw new Error("room command has no dispatch route");
    // Slice A: readiness narrows the ROUTE, here and nowhere else — one site, crossed by the room and
    // by a direct protocol client alike. The read is SYNCHRONOUS and never awaits a probe: a submit
    // that beats the boot probe reads a record in which every agent is `unknown`, and `unknown` is not
    // `unusable`, so it dispatches exactly the three agents it dispatches today.
    const resolved = this.readiness.resolveTargets(parsed.route.kind, parsed.route.agents);
    if (resolved.kind === "refused") throw new Error(resolved.reason);
    const targets = resolved.agents;
    assertRoomEventTextFits(parsed.text);
    const turn = this.turn + 1;
    const turnId = `turn-${turn}`;
    this.engine.reserveTurn(turnId, targets.length);
    this.turn = turn;
    let userMessage: ChatMessage;
    let ledgerSeq: string;
    try {
      ({ userMessage, ledgerSeq } = await this.persistOperatorMessage(turn, parsed.text, targets));
      await this.engine.submit({
        turnId,
        agents: targets,
        text: parsed.text,
        messageId: userMessage.id,
        ledgerSeq,
      });
    } catch (error) {
      this.engine.releaseTurnReservation(turnId);
      throw error;
    }
    return {
      requestId: request.requestId,
      turnId,
      messageId: userMessage.id,
      ledgerSeq: String(ledgerSeq),
      targets,
    };
  }

  public async control(control: RoomControl): Promise<{ readonly requestId: string }> {
    if (control.command === "pause") await this.engine.pause();
    if (control.command === "resume") await this.engine.resume();
    if (control.command === "cancel")
      await this.engine.cancel({
        scope: control.scope ?? "latest",
        ...(control.agent === undefined ? {} : { agent: control.agent }),
      });
    return { requestId: control.requestId };
  }

  public async cycleMode(request: RoomModeCycle): Promise<{ readonly requestId: string }> {
    await this.modes.cycle(request.text);
    return { requestId: request.requestId };
  }

  public listModels(agent: AgentName): Promise<RoomModelCatalog> {
    return this.models.list(agent);
  }

  public selectModel(agent: AgentName, modelId: string): Promise<RoomModelCatalog> {
    return this.models.select(agent, modelId);
  }

  public permissionResponse(
    response:
      | Readonly<{ askId: string; optionId: string }>
      | Readonly<{ askId: string; decision: "deny" }>,
  ): boolean {
    return "optionId" in response
      ? resolveAskOption(response.askId, response.optionId)
      : resolveAsk(response.askId, false);
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.usageCaptureAbort.abort();
    const deadline = Date.now() + (this.options.shutdownTimeoutMs ?? 4_000);
    // Every process the host may own: ACP lane transports + persistent PTY sessions (room-process-drain).
    const transportCleanup: Promise<ProcessDrainResult> = drainProcessOwnedTransports();
    let failure: Error | undefined;
    try {
      await beforeDeadline(this.engine.quiesce(), deadline, "room lanes did not terminate");
      await beforeDeadline(this.eventWrites, deadline, "room event journal did not flush");
      if (this.eventFailure !== undefined) throw this.eventFailure;
    } catch (error) {
      failure = asError(error);
    } finally {
      try {
        const cleanup = await beforeDeadline(
          transportCleanup,
          deadline,
          "lane transport cleanup did not finish",
        );
        failure ??= cleanup.failure;
        if (cleanup.orphans.length > 0)
          failure ??= new Error(`unconfirmed descendant agent PIDs: ${cleanup.orphans.join(", ")}`);
      } catch (error) {
        failure ??= asError(error);
      }
      resetCarrierDecider();
      resetPermissionAskRegistry();
      resetCarrierRuntime();
      if (!this.released && this.livenessLock !== undefined) {
        this.released = true;
        releaseLaneCarrierLock(this.livenessLock);
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async runLane(lane: RoomLane): Promise<RoomLaneResult> {
    if (this.options.runLane !== undefined) return this.options.runLane(lane);
    const bus = this.createBus(lane.turnId, lane);
    const permissionContext: ActivePermissionContext = {
      lane,
      bus,
      ...(lane.origin === "operator"
        ? {
            decider: createOperatorPermissionDecider(
              lane.agent,
              bus,
              this.options.permissionTimeoutMs,
            ),
          }
        : {}),
    };
    this.activePermissionContexts.set(lane.agent, permissionContext);
    let settledMessage: ChatMessage | undefined;
    let settledHandoff: RoomHandoff | undefined;
    let outcomes: readonly RoomLaneOutcome[];
    try {
      outcomes = await this.executeHeadlessLane(lane, bus, (message, handoff) => {
        settledMessage = message;
        settledHandoff = handoff;
      });
    } finally {
      if (this.activePermissionContexts.get(lane.agent) === permissionContext)
        this.activePermissionContexts.delete(lane.agent);
    }
    const outcome = outcomes[0];
    if (outcome === undefined) throw new Error(`room lane ${lane.agent} did not settle`);
    const message = await resolveSettledRoomMessage({
      outcome,
      lane,
      ...(settledMessage === undefined ? {} : { settledMessage }),
      persistFailure: () => this.persistOutcome(outcome, lane, true),
    });
    const owner = persistenceOwnerFor(this.options.dbPath);
    const ledgerSeq =
      owner === undefined ? undefined : getSeqForMessage(owner.db, owner.projectId, message.id);
    return buildSettledRoomLaneResult({
      outcome,
      lane,
      message,
      ...(ledgerSeq === undefined ? {} : { ledgerSeq: String(ledgerSeq) }),
      ...(settledHandoff === undefined ? {} : { handoff: settledHandoff }),
    });
  }

  private async persistOperatorMessage(turn: number, text: string, agents: readonly AgentName[]) {
    const userMessage = createUserMessage(turn, text, agents);
    const written = await recordChatMessage({
      dbPath: this.options.dbPath,
      blobRoot: this.options.blobRoot,
      sessionId: this.session.id,
      messageId: userMessage.id,
      turn,
      role: "user",
      agent: "user",
      text: userMessage.text,
      createdAt: userMessage.createdAt,
      status: userMessage.status,
      tokenEstimate: userMessage.tokenEstimate,
      dispatchedAgents: agents,
    });
    const owner = persistenceOwnerFor(this.options.dbPath);
    const ledgerSeq =
      owner === undefined ? undefined : getSeqForMessage(owner.db, owner.projectId, userMessage.id);
    if (written !== userMessage.id || ledgerSeq === undefined)
      throw new Error("operator message was not durably committed to the room ledger");
    await this.writeSession(async () => {
      this.session = appendMessage(this.session, userMessage);
      await persistSession(this.session);
    });
    return { userMessage, ledgerSeq: String(ledgerSeq) };
  }

  private executeHeadlessLane(
    lane: RoomLane,
    bus: ChatEventBus,
    settled: (message: ChatMessage, handoff: RoomHandoff | undefined) => void,
  ) {
    let handoff: RoomHandoff | undefined;
    return (this.options.runHeadlessTurn ?? runHeadlessTurn)({
      session: this.session,
      addresses: [
        {
          agent: lane.agent,
          prompt: lane.text,
          ...(lane.origin === "operator" ? { grant: CHAT_GRANT } : {}),
        },
      ],
      bus,
      turn: Number(lane.turnId.slice("turn-".length)),
      laneClass: "chat",
      ...(lane.expectedMessageId === undefined ? {} : { messageId: lane.expectedMessageId }),
      ...(lane.origin === "operator" ? { grant: CHAT_GRANT } : {}),
      config: this.options,
      signal: lane.signal,
      usagePoll: { signal: this.usageCaptureAbort.signal },
      canonicalizeLaneText: (agent, text) => {
        const roomOutcome = extractRoomHandoff(agent, text);
        handoff = roomOutcome.handoff;
        return boundRoomEventText(roomOutcome.text);
      },
      onLaneActivity: (agent, activity) =>
        this.engine.notify(lane.turnId, "lane.activity", {
          agent,
          ...roomLaneIdentity(lane),
          ...activity,
        }),
      onLaneSettled: async (_agent, outcome) => {
        const message = await this.persistOutcome(outcome, lane);
        settled(message, handoff);
        return message;
      },
    });
  }

  private async persistOutcome(
    outcome: RoomLaneOutcome,
    lane: RoomLane,
    allowUnfinalizedFailure = false,
  ) {
    const canonicalOutcome =
      allowUnfinalizedFailure &&
      outcome.messageId === undefined &&
      lane.expectedMessageId !== undefined
        ? { ...outcome, messageId: lane.expectedMessageId }
        : outcome;
    const message = {
      ...laneOutcomeMessage(Number(lane.turnId.slice("turn-".length)), canonicalOutcome),
      roomProvenance: {
        origin: lane.origin === "agent" ? ("agent-hop" as const) : ("operator" as const),
        ...(lane.replyTo === undefined ? {} : { replyTo: lane.replyTo }),
        rootTurnId: lane.turnId,
        ...(lane.origin === "agent"
          ? {
              hopId: lane.hopId,
              fromAgent: lane.fromAgent,
              toAgent: lane.agent,
            }
          : {}),
        hopIndex: lane.hopIndex,
        hopBudget: 1,
      },
    };
    if (lane.expectedMessageId !== undefined && message.id !== lane.expectedMessageId) {
      throw new Error(`room lane ${lane.agent} persisted an unexpected message id`);
    }
    await this.requireDurableLaneSequence(message, lane, allowUnfinalizedFailure);
    await this.writeSession(async () => {
      if (!this.session.messages.some((existing) => existing.id === message.id)) {
        this.session = appendMessage(this.session, message);
        await persistSession(this.session);
      }
    });
    return message;
  }

  private async requireDurableLaneSequence(
    message: ChatMessage,
    lane: RoomLane,
    allowUnfinalizedFailure: boolean,
  ): Promise<number> {
    const owner = persistenceOwnerFor(this.options.dbPath);
    let ledgerSeq =
      owner === undefined ? undefined : getSeqForMessage(owner.db, owner.projectId, message.id);
    if (ledgerSeq === undefined && allowUnfinalizedFailure) {
      const written = await recordChatMessage({
        dbPath: this.options.dbPath,
        blobRoot: this.options.blobRoot,
        sessionId: this.session.id,
        messageId: message.id,
        turn: message.turn,
        role: "agent",
        agent: message.agent,
        text: message.text,
        createdAt: message.createdAt,
        status: message.status,
        tokenEstimate: message.tokenEstimate,
      });
      ledgerSeq =
        owner === undefined ? undefined : getSeqForMessage(owner.db, owner.projectId, message.id);
      if (written !== message.id || ledgerSeq === undefined)
        throw new Error(`room lane ${lane.agent} failed outcome was not durably committed`);
    }
    if (ledgerSeq === undefined) {
      throw new Error(`room lane ${lane.agent} has no durable ledger sequence`);
    }
    return ledgerSeq;
  }

  private createBus(turnId: string, lane?: RoomLane): ChatEventBus {
    return createRoomBus({
      turnId,
      ...(lane === undefined ? {} : { lane }),
      isShuttingDown: () => this.shuttingDown,
      notify: (eventTurnId, type, payload) => this.engine.notify(eventTurnId, type, payload),
      notice: (eventTurnId, notice) => this.engine.notice(eventTurnId, notice),
      onMode: (event) => this.modes.onModeSession(event),
      usageFold: this.usageFold,
    });
  }

  private async writeSession(operation: () => Promise<void>): Promise<void> {
    const write = this.sessionWrites.then(operation);
    this.sessionWrites = write.catch(() => undefined);
    return write;
  }

  private async loadJournal(): Promise<RoomEvent[]> {
    const journalPath = path.join(this.session.runDir, "room-events.jsonl");
    return loadRoomJournal(journalPath, MAX_ROOM_JOURNAL_BYTES, MAX_ROOM_JOURNAL_EVENTS);
  }

  private reconcileRecovery(journal: readonly RoomEvent[]): Promise<readonly RoomEvent[]> {
    return reconcileRoomRecovery({
      dbPath: this.options.dbPath,
      blobRoot: this.options.blobRoot,
      session: this.session,
      journal,
      persistSession: (repaired) =>
        this.writeSession(async () => {
          this.session = repaired;
          await persistSession(this.session);
        }),
      appendEvent: (event) => this.appendRecoveryEvent(event),
    });
  }

  private async appendRecoveryEvent(event: RoomEvent): Promise<void> {
    const journalPath = path.join(this.session.runDir, "room-events.jsonl");
    await (this.options.appendJournal ?? appendJournalLine)(
      journalPath,
      `${JSON.stringify(event)}\n`,
    );
  }

  private async publishEvent(event: RoomEvent): Promise<void> {
    const journalPath = path.join(this.session.runDir, "room-events.jsonl");
    const write = this.eventWrites.then(async () => {
      await (this.options.appendJournal ?? appendJournalLine)(
        journalPath,
        `${JSON.stringify(event)}\n`,
      );
      await this.options.onEvent?.(event);
    });
    this.eventWrites = write.catch((error: unknown) => {
      this.eventFailure ??= error;
    });
    await write;
  }
}
