/**
 * @file src/chat/lane-carrier-review-fixes.test.ts
 * @purpose MT7 lane-carrier coordinator/retro review-fix falsifiers + T5 acceptance 11 + W0 + C2 —
 *   split out of lane-carrier.test.ts once its 11 T5 acceptance suites + these falsifiers crossed
 *   gate-clamps' 600-line hard ceiling (no @size-justified escape hatch above it). Shared setup
 *   lives in lane-carrier.fixtures.ts, imported by both split files.
 * @exports (test suite)
 * @depends vitest, ../memory/journal-store, ../memory/lane-state, ./lane-carrier, ./lane-carrier.fixtures
 */
import { describe, expect, it } from "vitest";
import { appendEntry } from "../memory/journal-store.js";
import {
  bumpGeneration,
  getLaneCursor,
  getLaneSession,
  getPromptAttempt,
  setBriefingCarry,
} from "../memory/lane-state.js";
import {
  BINDING,
  NOW,
  PROJECT,
  add,
  readBody,
  registerLaneCarrierHooks,
  run,
  seeded,
  textOutsideUntrustedFrames,
  traceSink,
  transport,
} from "./lane-carrier.fixtures.js";
import { composeCarrierPrompt } from "./lane-carrier.js";

registerLaneCarrierHooks();

describe("T5 coordinator review fixes (I3)", () => {
  it("briefing reasons follow the spec enum: coldstart, then recarry when re-armed, fallback on catch-up", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello");
    const { trace, phases } = traceSink();
    await run(db, bodies, "claude", transport([]), { trace });
    expect(phases.some((p) => p.startsWith("briefing.injected:reason=coldstart"))).toBe(true);

    add(db, bodies, "m2", "claude", "reply");
    setBriefingCarry(db, PROJECT, "claude", NOW);
    const rearmed = traceSink();
    await run(db, bodies, "claude", transport([{ outcome: "resumed", sessionId: "s-new" }]), {
      trace: rearmed.trace,
      attemptId: () => "a-recarry",
    });
    expect(rearmed.phases.some((p) => p.startsWith("briefing.injected:reason=recarry"))).toBe(true);

    add(db, bodies, "m3", "codex", "more");
    setBriefingCarry(db, PROJECT, "claude", NOW);
    const fallback = traceSink();
    await run(db, bodies, "claude", transport([{ outcome: "resumeFailed", reason: "expired" }]), {
      trace: fallback.trace,
      attemptId: () => "a-fallback",
    });
    expect(fallback.phases.some((p) => p.startsWith("briefing.injected:reason=fallback"))).toBe(
      true,
    );
  });
});

describe("retro review BLOCK-1: catch-up content", () => {
  it("a fresh generation's catch-up contains the PRE-CURSOR ledger tail, not just seqs after the dead session's cursor", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "alpha start");
    add(db, bodies, "m2", "claude", "bravo context");
    add(db, bodies, "m3", "operator", "charlie decision");
    await run(db, bodies, "claude", transport([])); // gen1 accepts through seq 3
    expect(getLaneCursor(db, PROJECT, "claude")?.lastSeq).toBe(3);

    // Session expires -> gen2. The NEW native process never saw seqs 1-3; its first prompt must carry
    // the bounded ledger SNAPSHOT (the tail), not "everything after 3" (which is NOTHING here).
    const tx = transport([{ outcome: "resumeFailed", reason: "expired" }]);
    const result = await run(db, bodies, "claude", tx, { attemptId: () => "a-catchup" });
    expect(result.outcome).toBe("accepted");
    const prompt = tx.prompts[0] ?? "";
    expect(prompt).toContain("charlie decision"); // the tail the fresh session never saw
    expect(prompt).toContain("bravo context");
  });
});

describe("T5 coordinator review fixes (I3) - overflow + binding", () => {
  it("6b degenerate giant-operator: cursor NEVER rebases past pending seqs (no summary block was carried) and operator bytes ride unmodified", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "start");
    await run(db, bodies, "claude", transport([])); // gen1 + cursor at seq 1, carry cleared
    const before = getLaneCursor(db, PROJECT, "claude");
    add(db, bodies, "m2", "claude", "context the giant turn will skip");
    add(db, bodies, "m3", "codex", "more skipped context");
    const giant = "X".repeat(24_001);
    const result = await run(
      db,
      bodies,
      "claude",
      transport([{ outcome: "resumed", sessionId: "s-new" }]),
      { operatorMessage: giant, attemptId: () => "a-giant" },
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.prompt).toContain(giant); // never cut
    }
    expect(getLaneCursor(db, PROJECT, "claude")?.lastSeq).toBe(before?.lastSeq); // pending stays pending
  });

  it("a stored session with a mismatched binding traces resume.fallback with a binding reason before the fresh generation", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello");
    bumpGeneration(db, {
      projectId: PROJECT,
      agent: "claude",
      sessionId: "s-old",
      adapterPkg: "pkg",
      adapterVersion: "1",
      cwd: "C:/ELSEWHERE",
      now: NOW,
    });
    const { trace, phases } = traceSink();
    const result = await run(db, bodies, "claude", transport([]), { trace });
    expect(result.outcome).toBe("accepted");
    expect(phases.some((p) => p.startsWith("resume.fallback:reason=binding_mismatch"))).toBe(true);
    expect(getLaneSession(db, PROJECT, "claude")?.generation).toBe(2);
  });
});

describe("T5 coordinator review fixes (I3) - lifecycle honesty", () => {
  it("an ACCEPTED turn leaves the persistent transport OPEN (per-turn close is the respawn anti-target)", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello");
    let closes = 0;
    const tx = {
      ...transport([]),
      close: async () => {
        closes += 1;
        return { outcome: "closed" as const };
      },
    };
    const result = await run(db, bodies, "claude", tx);
    expect(result.outcome).toBe("accepted");
    expect(closes).toBe(0);
  });

  it("recovery classifies maybeDuplicate only — never a fabricated duplicate claim", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello");
    await run(db, bodies, "claude", transport([]), { crashAfterSend: true });
    const { trace, phases } = traceSink();
    await run(db, bodies, "claude", transport([{ outcome: "resumed", sessionId: "s-new" }]), {
      trace,
      attemptId: () => "a-retry",
    });
    expect(phases.some((p) => p.startsWith("delta.maybeDuplicate:"))).toBe(true);
    expect(phases.some((p) => p.startsWith("delta.duplicate:"))).toBe(false);
  });

  it("agy capture failure: attempt unresolved, cursor unadvanced, session + generation retained, capture trace emitted", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "hello");
    const { trace, phases } = traceSink();
    const result = await run(
      db,
      bodies,
      "gemini",
      transport([], { outcome: "failed", reason: "agyCapture", message: "id lost" }),
      { trace, attemptId: () => "a-agy" },
    );
    expect(result).toMatchObject({ outcome: "failed", reason: "agyCapture" });
    expect(getPromptAttempt(db, "a-agy")?.resolved).toBeNull();
    expect(getLaneCursor(db, PROJECT, "gemini")?.lastSeq ?? 0).toBe(0);
    expect(getLaneSession(db, PROJECT, "gemini")?.generation).toBe(1);
    expect(phases.some((p) => p.startsWith("resume.fallback:reason=agy_id_capture"))).toBe(true);
  });
});

describe("T5 acceptance 11 - Trace phase completeness", () => {
  it("emits scoped failure phases and briefing injection details", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "body");
    const seen = traceSink();
    const tx = transport(
      [
        {
          outcome: "created",
          sessionId: "s1",
          modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
        },
      ],
      {
        outcome: "failed",
        reason: "agyCapture",
        message: "no id",
      },
    );
    tx.close = async () => ({ outcome: "orphan", pid: 123 });
    await run(db, bodies, "gemini", tx, { trace: seen.trace });
    await run(
      db,
      bodies,
      "claude",
      transport([
        {
          outcome: "created",
          sessionId: "s-c",
          modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
        },
      ]),
      {
        trace: seen.trace,
      },
    );
    expect(seen.phases.some((p) => p.startsWith("briefing.injected:reason="))).toBe(true);
    expect(seen.phases.some((p) => p.includes("agy_id_capture"))).toBe(true);
    expect(seen.phases.some((p) => p.startsWith("delta.injected"))).toBe(true);
  });
});

// K1 (operator decision, 2026-08-18): this suite asserted the clamp — that a router pull could never reach a
// carrier prompt. It can now, and must, or the digest is written and never read. The falsifying power moves
// to WHERE it lands: the pull arrives attributed and inside the untrusted frame, never as instruction text.
// This is the carrier-path mirror of the buffered-path proof in compose-prompt-lanes.test.ts.
describe("K1 provider memory boundary: derived router pulls enter carrier prompts FRAMED", () => {
  it("an operator message naming a file pulls peer-authored memory in, inside the untrusted frame", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "run-1", "operator", "kickoff");
    // A peer's file-tagged SUMMARY (own-only bucket): reaches gemini's briefing ONLY via the router
    // pull, so the wiring probe cannot pass through the core rendering.
    appendEntry(db, {
      projectId: PROJECT,
      category: "summary",
      author: "agent",
      agent: "codex",
      body: "CARRIER-PULL-PROOF: src/live/carrier-target.ts owns the retry ladder.",
      createdAt: NOW,
      touchedFiles: ["src/live/carrier-target.ts"],
    });
    const prompt = composeCarrierPrompt({
      agent: "gemini",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "please adjust src/live/carrier-target.ts timeouts",
      now: () => NOW,
    }).text;
    expect(prompt).toContain("## Router pulls");
    expect(prompt).toContain("CARRIER-PULL-PROOF");
    // MT5 trust surface: attributed to codex and wrapped, so gemini reads it as context, never as orders.
    expect(prompt).toContain("BEGIN UNTRUSTED RECALLED MEMORY [journal:codex:");
    expect(textOutsideUntrustedFrames(prompt)).not.toContain("CARRIER-PULL-PROOF");
  });
});

describe("C2 (FIX WAVE Round A): carrier memory traces thread the real turn, never a hard-coded 0", () => {
  it("resume.attempted/resume.ok on a resumed lane carry the caller's turn number", async () => {
    const { db, bodies } = seeded();
    add(db, bodies, "m1", "operator", "first");
    await run(
      db,
      bodies,
      "claude",
      transport([
        {
          outcome: "created",
          sessionId: "s1",
          modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
        },
      ]),
      {
        turn: 3,
      },
    );
    const turns: number[] = [];
    const trace = {
      emit: (event: { phase: string; turn?: number }) => turns.push(event.turn ?? -1),
    };
    await run(db, bodies, "claude", transport([{ outcome: "resumed", sessionId: "s1" }]), {
      trace,
      turn: 7,
      attemptId: () => "a-c2",
    });
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t === 7)).toBe(true);
  });
});
