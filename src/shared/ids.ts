/**
 * @file src/shared/ids.ts
 * @purpose ULID generation and branded identifier types for observability rows.
 * @exports ULID_REGEX, RunId, TaskId, DispatchId, EventId, ErrorId, FindingId, newId, newRunId, newTaskId, newDispatchId, newEventId, newErrorId, newFindingId, isUlid, seedMonotonicUlid
 * @depends ulid
 */
import { isValid, monotonicFactory, ulid } from "ulid";

export const ULID_REGEX: RegExp = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type RunId = string & { readonly __brand: "RunId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type DispatchId = string & { readonly __brand: "DispatchId" };
export type EventId = string & { readonly __brand: "EventId" };
export type ErrorId = string & { readonly __brand: "ErrorId" };
export type FindingId = string & { readonly __brand: "FindingId" };

/**
 * Generates one lexicographically sortable ULID.
 *
 * @returns unbranded ULID string
 */
export function newId(): string {
  return ulid();
}

/**
 * Generates one branded run ID.
 *
 * @returns run identifier
 */
export function newRunId(): RunId {
  return newId() as RunId;
}

/**
 * Generates one branded task ID.
 *
 * @returns task identifier
 */
export function newTaskId(): TaskId {
  return newId() as TaskId;
}

/**
 * Generates one branded dispatch ID.
 *
 * @returns dispatch identifier
 */
export function newDispatchId(): DispatchId {
  return newId() as DispatchId;
}

/**
 * Generates one branded event ID.
 *
 * @returns event identifier
 */
export function newEventId(): EventId {
  return newId() as EventId;
}

/**
 * Generates one branded error ID.
 *
 * @returns error identifier
 */
export function newErrorId(): ErrorId {
  return newId() as ErrorId;
}

/**
 * Generates one branded finding ID.
 *
 * @returns finding identifier
 */
export function newFindingId(): FindingId {
  return newId() as FindingId;
}

/**
 * Checks whether a string is a syntactically valid ULID.
 *
 * @param value - candidate identifier
 * @returns true when value is a valid ULID
 */
export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value) && isValid(value);
}

/**
 * Creates a deterministic monotonic ULID generator for tests.
 *
 * @param epochMs - timestamp encoded into generated IDs
 * @returns function yielding monotonic ULIDs at the supplied timestamp
 */
export function seedMonotonicUlid(epochMs: number): () => string {
  const factory = monotonicFactory((): number => 0.5);
  return (): string => factory(epochMs);
}
