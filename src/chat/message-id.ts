/**
 * @file src/chat/message-id.ts
 * @purpose Mint provably-unique, readable, time-sortable chat message ids.
 * @exports mintMessageId
 * @depends node:crypto
 */
import { randomUUID } from "node:crypto";

/**
 * Mint a chat message id of the form `msg-<epochMs>-<suffix>-<uuidv4>`.
 *
 * Uniqueness is carried by a FULL RFC-4122 v4 UUID (122 random bits — collision-negligible across
 * processes, restarts, and long sessions), NOT by `Date.now()`: two ids minted in the SAME
 * millisecond with the SAME `suffix` are still distinct. This is the invariant the per-agent merge
 * (controller-council.ts, dedup-by-id) depends on — two same-agent replies that race into
 * one millisecond must keep two distinct ids or one is silently dropped. (A truncated UUID would
 * weaken this to ~32 bits — provably-unique requires the full UUID.) The leading epoch keeps ids
 * readable + lexically time-sortable; `suffix` (agent name or `user`) keeps the origin legible.
 */
export function mintMessageId(suffix: string): string {
  return `msg-${Date.now()}-${suffix}-${randomUUID()}`;
}
