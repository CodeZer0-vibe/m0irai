/**
 * @file src/room/room-boot-stages.ts
 * @purpose The host side of `zer0/room/boot_progress`: turns an optional reporter into the five stage
 *   calls `AliveRoomHost.create` makes, and derives the evidence stage's migration detail.
 * @exports BootProgressSteps, bootProgressSteps, evidenceMigrationDetail, highestTurn
 * @depends ../chat/types, ../evidence/db, ../evidence/migration-readiness, ./room-boot-progress
 *
 * SEPARATE FROM `room-boot-progress.ts` ON PURPOSE. That module is the wire shape and nothing else, and
 * the RPC writer imports it for the validator; this one reaches into the evidence layer to read a schema
 * version. Merging them would drag `src/evidence` into the import graph of every module that only wants
 * to validate a frame.
 */
import type { ChatSession } from "../chat/types.js";
import { type Db, LANE_TARGET_VERSION_KEY } from "../evidence/db.js";
import { validatedVersionKey } from "../evidence/migration-readiness.js";
import {
  type BootProgressReporter,
  type BootProgressStage,
  delaySimulatedSlowBoot,
} from "./room-boot-progress.js";

/** One call per stage, in the order the boot runs them. Naming them individually rather than passing a
 *  stage string at each site is what lets the compiler catch a stage that was renamed on one side. */
export interface BootProgressSteps {
  readonly evidence: () => Promise<void>;
  readonly liveness: () => Promise<void>;
  readonly migrate: (detail?: string) => Promise<void>;
  readonly session: () => Promise<void>;
  readonly journal: () => Promise<void>;
}

/**
 * Binds `reporter` to the five stages, or returns no-ops when there is no reporter.
 *
 * The no-op case is the majority: every unit test that constructs a host directly passes no reporter,
 * and those boots must behave exactly as they did before this existed — same order, same awaits, no
 * added microtask turn. So an absent reporter short-circuits to an already-resolved promise rather than
 * to an async function that awaits nothing.
 *
 * The simulated-slow-boot delay is applied HERE, once, rather than at each of the five call sites: a
 * seam that has to be remembered five times is a seam that will be forgotten once.
 */
export function bootProgressSteps(reporter: BootProgressReporter | undefined): BootProgressSteps {
  const step =
    reporter === undefined
      ? (): Promise<void> => Promise.resolve()
      : async (stage: BootProgressStage, detail?: string): Promise<void> => {
          await reporter(stage, detail);
          await delaySimulatedSlowBoot();
        };
  return {
    evidence: () => step("evidence"),
    liveness: () => step("liveness"),
    migrate: (detail?: string) => step("migrate", detail),
    session: () => step("session"),
    journal: () => step("journal"),
  };
}

/**
 * What the carrier open is about to do to the evidence database, as `<from> → <to>`.
 *
 * `from` is read from the handle the boot ALREADY holds, after the global tier has run and before the
 * carrier's lazy memory/lane tiers do — which is exactly the state a stalled operator is waiting on. On
 * a first open of a fresh project that reads `14` and the target reads `14,15,16,20,21`, so the stall
 * message names the real work rather than a guess at it.
 *
 * Returns undefined rather than throwing when the version cannot be read. A progress label is an aid;
 * failing a boot because the aid could not be composed would be the defect this lane exists to remove.
 * The failure is swallowed silently BY DESIGN and that is safe here because nothing downstream reads
 * the value: the caller reports the stage with no detail, and the open that follows validates the very
 * same versions properly and throws its own drift error if they are wrong.
 */
export function evidenceMigrationDetail(db: Db): string | undefined {
  try {
    const from = validatedVersionKey(db);
    if (from === LANE_TARGET_VERSION_KEY) return undefined;
    return `${from} → ${LANE_TARGET_VERSION_KEY}`;
  } catch {
    return undefined;
  }
}

/** The highest turn number the recovered session carries. Lives here so `AliveRoomHost.create` stays
 *  inside the function clamp; it is pure and has no other caller. */
export function highestTurn(session: ChatSession): number {
  return session.messages.reduce((maximum, message) => Math.max(maximum, message.turn), 0);
}
