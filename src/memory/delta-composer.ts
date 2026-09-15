/**
 * @file src/memory/delta-composer.ts
 * @purpose Pure MT7 room-delta block composer from bounded ledger entries and overflow metadata.
 * @exports composeDelta, DeltaComposeInput, ComposedDelta, DeltaEntry, DeltaOverflowInfo
 * @depends ./untrusted-framing
 */
import { SESSION_BOUNDARY_STATEMENT, delimitUntrusted } from "./untrusted-framing.js";

export interface DeltaEntry {
  readonly seq: number;
  readonly messageId: string;
  readonly author: string;
  readonly body: string;
}

export type DeltaOverflowInfo =
  | {
      readonly pending: false;
      readonly skippedCount: 0;
      readonly deliveredCount: number;
      readonly deliveredFromSeq?: number;
      readonly deliveredToSeq?: number;
    }
  | {
      readonly pending: true;
      readonly skippedCount: number;
      readonly skippedFromSeq: number;
      readonly skippedToSeq: number;
      readonly deliveredCount: number;
      readonly deliveredFromSeq?: number;
      readonly deliveredToSeq?: number;
    };

export interface DeltaComposeInput {
  readonly entries: readonly DeltaEntry[];
  readonly overflow: DeltaOverflowInfo;
  /** The binding cap on the RETURNED block's rendered bytes (frames + headers + overflow summary
   *  included). REQUIRED: the composer is the only layer that knows rendered sizes — body-byte budgets
   *  upstream (ledgerAfter) are pre-filters, and an unenforced render can push the assembled prompt past
   *  the transport cap, whose tail-truncation would cut the operator message. */
  readonly budgetBytes: number;
  /** THE BOUNDARY WAVE: the ledger seq high-water-mark at THIS chat session's boot (live-derived,
   *  never persisted — see chat-tui-mount.ts's own computation). An entry with `seq <= this` predates
   *  the current session; REQUIRED (not defaulted here) so a caller can never silently forget to
   *  thread it — 0 (a project's first-ever session) frames nothing, byte-identical to before this
   *  field existed. */
  readonly sessionBoundarySeq: number;
}

export interface ComposedDelta {
  readonly block: string;
  readonly bytes: number;
  readonly deliveredSeqs: readonly number[];
  readonly overflow: DeltaOverflowInfo;
  /** THE BOUNDARY WAVE (B7 observability): count of entries in `block` reclassified from trusted to
   *  untrusted-framed by sessionBoundarySeq — never a non-operator entry's own unrelated framing (see
   *  renderEntry's framedPriorSession contract). 0 is the common case (nothing predates the boundary,
   *  or a project's first-ever session). The caller (lane-carrier.ts) emits this on the bus under
   *  ZER0_DEBUG=1 so boundary injection is traceable, never a silent transform. */
  readonly framedPriorSessionCount: number;
}

/**
 * Composes the room-delta block, GUARANTEEING bytes <= budgetBytes: oldest entries drop first and merge
 * into the overflow span (they become skipped seqs — the summary block reports them, so a drop is never
 * a silent context hole). The overflow summary itself is exempt from dropping (it IS the explanation);
 * the partition reserves `overflowHeadroom` for it, so a budget too small for the summary alone is a
 * caller arithmetic error and still returns the summary as the block.
 */
export function composeDelta(input: DeltaComposeInput): ComposedDelta {
  let entries = input.entries;
  let overflow = input.overflow;
  let rendered = renderBlock(entries, overflow, input.sessionBoundarySeq);
  while (Buffer.byteLength(rendered.text, "utf8") > input.budgetBytes && entries.length > 0) {
    const dropped = entries[0];
    if (dropped === undefined) {
      break;
    }
    entries = entries.slice(1);
    overflow = mergeDropIntoOverflow(overflow, dropped, entries);
    rendered = renderBlock(entries, overflow, input.sessionBoundarySeq);
  }
  if (Buffer.byteLength(rendered.text, "utf8") > input.budgetBytes) {
    // Every entry dropped and the overflow SUMMARY alone still exceeds the budget (retro BLOCK-4: a
    // zero-headroom caller). The byte guarantee is absolute: deliver NOTHING — the overflow stays
    // pending-but-UNCARRIED (bytes 0), so acceptance authorizes no rebase and the next turn retries.
    return { block: "", bytes: 0, deliveredSeqs: [], overflow, framedPriorSessionCount: 0 };
  }
  return {
    block: rendered.text,
    bytes: Buffer.byteLength(rendered.text, "utf8"),
    deliveredSeqs: entries.map((entry) => entry.seq),
    overflow,
    framedPriorSessionCount: rendered.framedCount,
  };
}

function renderBlock(
  entries: readonly DeltaEntry[],
  overflow: DeltaOverflowInfo,
  sessionBoundarySeq: number,
): { readonly text: string; readonly framedCount: number } {
  const parts = overflow.pending ? [renderOverflow(overflow)] : [];
  let framedCount = 0;
  for (const entry of entries) {
    const rendered = renderEntry(entry, sessionBoundarySeq);
    if (rendered.framedPriorSession) framedCount += 1;
    parts.push(rendered.text);
  }
  // THE BOUNDARY WAVE, B1(b): ONE statement per rendered block, never one per framed entry — added
  // only when this render actually reclassified an operator entry from trusted to framed (a
  // non-operator entry's OWN framing is unrelated to session boundaries and never triggers this).
  if (framedCount > 0) parts.push(SESSION_BOUNDARY_STATEMENT);
  return { text: parts.length === 0 ? "" : parts.join("\n"), framedCount };
}

// A dropped entry moves from delivered to skipped: the span's floor stays (or becomes the drop), the
// ceiling extends to the drop, counts shift by one, and the delivered bounds recompute from what's left.
function mergeDropIntoOverflow(
  overflow: DeltaOverflowInfo,
  dropped: DeltaEntry,
  remaining: readonly DeltaEntry[],
): DeltaOverflowInfo {
  const first = remaining[0];
  const last = remaining[remaining.length - 1];
  const bounds =
    first === undefined || last === undefined
      ? {}
      : { deliveredFromSeq: first.seq, deliveredToSeq: last.seq };
  return {
    pending: true,
    skippedCount: overflow.skippedCount + 1,
    skippedFromSeq: overflow.pending ? overflow.skippedFromSeq : dropped.seq,
    skippedToSeq: dropped.seq,
    deliveredCount: remaining.length,
    ...bounds,
  };
}

interface RenderedEntry {
  readonly text: string;
  /** True only for an operator entry reclassified prior-session->framed (drives the ONE boundary
   *  statement in renderBlock) — a non-operator entry is framed regardless of session and never
   *  sets this, since its framing carries no session-boundary meaning to explain. */
  readonly framedPriorSession: boolean;
}

function renderEntry(entry: DeltaEntry, sessionBoundarySeq: number): RenderedEntry {
  const content = `seq ${entry.seq} author ${entry.author}\n${entry.body}`;
  const provenance = `project-ledger seq=${entry.seq} author=${entry.author}`;
  if (entry.author !== "operator") {
    return { text: delimitUntrusted(content, provenance), framedPriorSession: false };
  }
  // THE BOUNDARY WAVE, B1(a): an operator entry minted before this session's boot watermark is no
  // longer unconditionally trusted just because author==="operator" — it gets the SAME untrusted
  // framing a non-operator entry already carries. seq > sessionBoundarySeq (this session, or the
  // project's first-ever session where the watermark is 0) is untouched — B3's mid-session contract.
  if (entry.seq <= sessionBoundarySeq) {
    return { text: delimitUntrusted(content, provenance), framedPriorSession: true };
  }
  return { text: content, framedPriorSession: false };
}

function renderOverflow(overflow: Extract<DeltaOverflowInfo, { readonly pending: true }>): string {
  return [
    "<<<BEGIN PROJECT LEDGER OVERFLOW SUMMARY>>>",
    `skipped_count: ${overflow.skippedCount}`,
    `skipped_seq_range: ${overflow.skippedFromSeq}-${overflow.skippedToSeq}`,
    "<<<END PROJECT LEDGER OVERFLOW SUMMARY>>>",
  ].join("\n");
}
