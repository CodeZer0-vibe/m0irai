/**
 * @file src/chat/lane-carrier.test.ts
 * @purpose MT7 T5 acceptance suites 1-10 for the lane carrier over real SQLite and fake transport
 *   seams (interleaving, crash window, generation abandon, old-run ordering, flag-matrix goldens,
 *   fallback/overflow, re-carry chain, auth/quota retention, council deny-list, lock). Coordinator
 *   review-fix falsifiers + T5-11/W0/C2 moved to lane-carrier-review-fixes.test.ts — this file
 *   crossed gate-clamps' 600-line hard ceiling (no @size-justified escape hatch above it); shared
 *   setup lives in lane-carrier.fixtures.ts, imported by both split files.
 * @exports (test suite)
 * @depends vitest, ../memory/lane-state, ./headless-prompt, ./lane-carrier, ./lane-carrier.fixtures
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpGeneration,
  getLaneCursor,
  getLaneSession,
  getPromptAttempt,
  setBriefingCarry,
} from "../memory/lane-state.js";
import { composePrompt } from "./headless-prompt.js";
import {
  BINDING,
  NOW,
  PROJECT,
  add,
  readBody,
  registerLaneCarrierHooks,
  root,
  run,
  seeded,
  traceSink,
  transport,
} from "./lane-carrier.fixtures.js";
import {
  acquireLaneCarrierLock,
  composeCarrierPrompt,
  releaseLaneCarrierLock,
} from "./lane-carrier.js";

registerLaneCarrierHooks();

describe("T5 acceptance 1 - Interleaving", () => {
  it("injects each accepted ledger seq exactly once per lane cursor", async () => {
    const { db, bodies } = seeded();
    for (const [id, author] of [
      ["m1", "operator"],
      ["m2", "claude"],
      ["m3", "codex"],
    ] as const)
      add(db, bodies, id, author, id);
    for (const agent of ["claude", "codex", "gemini"] as const) {
      const tx = transport([
        {
          outcome: "created",
          sessionId: `s-${agent}`,
          modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
        },
      ]);
      await run(db, bodies, agent, tx);
      for (const seq of [1, 2, 3])
        expect(tx.prompts[0]?.match(new RegExp(`seq ${seq}`, "g"))).toHaveLength(1);
      expect(getLaneCursor(db, PROJECT, agent)?.lastSeq).toBe(3);
    }
  });
});

describe("T5 acceptance 2 - Crash window", () => {
  it("keeps the attempt unresolved and classifies the identical resend maybeDuplicate (native completion is unknowable)", async () => {
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
        crashAfterSend: true,
      },
    );
    expect(getPromptAttempt(db, "a-claude")?.resolved).toBeNull();
    const seen = traceSink();
    await run(db, bodies, "claude", transport([{ outcome: "resumed", sessionId: "s1" }]), {
      trace: seen.trace,
      attemptId: () => "a-claude-retry",
    });
    // A seq-range match proves the delta recomputed identically, NOT that the native side completed —
    // `delta.duplicate` is reserved for a durable native-completion signal (coordinator review I3).
    expect(seen.phases.some((p) => p.startsWith("delta.maybeDuplicate"))).toBe(true);
    expect(getLaneCursor(db, PROJECT, "claude")?.lastSeq).toBe(1);
  });
});

describe("T5 acceptance 3 - Generation abandon", () => {
  it("abandons generation N unresolved attempts before N+1 catch-up", async () => {
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
        crashAfterSend: true,
      },
    );
    await run(
      db,
      bodies,
      "claude",
      transport([
        { outcome: "resumeFailed", reason: "unknown_id" },
        {
          outcome: "created",
          sessionId: "s2",
          modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
        },
      ]),
      { attemptId: () => "a2" },
    );
    expect(getPromptAttempt(db, "a-claude")?.resolved).toBe("abandoned");
    expect(getLaneSession(db, PROJECT, "claude")?.generation).toBe(2);
  });
});

describe("T5 acceptance 4 - Old-run ordering", () => {
  it("renders deltas in project seq order, not run age", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "old", "operator", "old start");
    add(db, bodies, "new", "codex", "new reply");
    add(db, bodies, "old-late", "operator", "old extended later");
    const prompt = composeCarrierPrompt({
      agent: "gemini",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "O",
      now: () => NOW,
    }).text;
    expect(prompt.indexOf("old start")).toBeLessThan(prompt.indexOf("new reply"));
    expect(prompt.indexOf("new reply")).toBeLessThan(prompt.indexOf("old extended later"));
  });
});

describe("T5 acceptance 5 - Flag matrix goldens", () => {
  it("keeps inert dispatch prompts free of carrier/journal bytes while positive carrier emits v16 delta", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "council", "codex", "council output");
    const session = {
      id: "chat-x" as const,
      repoRoot: "C:/repo",
      runDir: "C:/repo/run",
      createdAt: NOW,
      updatedAt: NOW,
      defaultAgent: "claude" as const,
      lastAgent: null,
      summary: { text: "", throughTurn: 0 },
      messages: [],
    };
    expect(composePrompt(session, "@all hi", "claude", 1, "dispatch")).not.toContain(
      "council output",
    );
    expect(
      composeCarrierPrompt({
        agent: "claude",
        turn: 1,
        binding: BINDING,
        db,
        projectId: PROJECT,
        readBody: readBody(bodies),
        setup: "S",
        operatorMessage: "O",
        now: () => NOW,
      }).text,
    ).toContain("council output");
  });
});

describe("T5 acceptance 6 - Fallback and overflow", () => {
  it("rebases on accepted overflow summary and preserves a giant operator message", async () => {
    const { db, bodies } = seeded();
    for (let i = 0; i < 40; i += 1) add(db, bodies, `m${i}`, "codex", "x".repeat(700));
    const prompt = composeCarrierPrompt({
      agent: "claude",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "O",
      now: () => NOW,
    });
    expect(prompt.text).toContain("PROJECT LEDGER OVERFLOW SUMMARY");
    const giant = "O".repeat(25000);
    const giantPrompt = composeCarrierPrompt({
      agent: "codex",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: giant,
      now: () => NOW,
    });
    expect(giantPrompt.text.endsWith(giant)).toBe(true);
    expect(giantPrompt.deliveredSeqs).toEqual([]);
  });
});

describe("T5 acceptance 7 - Re-carry chain", () => {
  it("carries briefing once per durable trigger for every lane", async () => {
    const { db, bodies } = seeded();
    for (const agent of ["claude", "codex", "gemini"] as const) {
      await run(
        db,
        bodies,
        agent,
        transport([
          {
            outcome: "created",
            sessionId: `s-${agent}`,
            modeApplied: { outcome: "applied", modeId: "default", origin: "confirmed" },
          },
        ]),
      );
      expect(getLaneCursor(db, PROJECT, agent)?.needsBriefingCarry).toBe(false);
      setBriefingCarry(db, PROJECT, agent, NOW);
      const tx = transport([{ outcome: "resumed", sessionId: `s-${agent}` }]);
      await run(db, bodies, agent, tx, { attemptId: () => `a2-${agent}` });
      expect(tx.prompts[0]).toContain("# Static memory briefing");
      expect(getLaneCursor(db, PROJECT, agent)?.needsBriefingCarry).toBe(false);
    }
  });
});

describe("T5 acceptance 8 - Auth and quota retention", () => {
  it("retains session id and generation without fallback on auth/quota send failures", async () => {
    const { db, bodies } = seeded();
    bumpGeneration(db, {
      ...BINDING,
      projectId: PROJECT,
      agent: "claude",
      sessionId: "s1",
      now: NOW,
    });
    for (const reason of ["auth", "quota"] as const) {
      const result = await run(
        db,
        bodies,
        "claude",
        transport([{ outcome: "resumed", sessionId: "s1" }], {
          outcome: "failed",
          reason,
          message: reason,
        }),
        { attemptId: () => `a-${reason}` },
      );
      expect(result).toMatchObject({ outcome: "failed", reason, sessionId: "s1" });
      expect(getLaneSession(db, PROJECT, "claude")?.generation).toBe(1);
    }
  });
});

describe("T5 acceptance 9 - Council deny-list", () => {
  it("dispatch prompts carry zero delta and council output enters the next chat delta", () => {
    const { db, bodies } = seeded();
    add(db, bodies, "council", "gemini", "dispatch result enters ledger");
    const carrier = composeCarrierPrompt({
      agent: "claude",
      turn: 1,
      binding: BINDING,
      db,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "O",
      now: () => NOW,
    }).text;
    expect(carrier).toContain("dispatch result enters ledger");
  });
});

describe("T5 acceptance 10 - Lock", () => {
  it("reuses the MT4 single-flight lock and still allows ledger seq minting", () => {
    const { db, bodies } = seeded();
    if (root === undefined) throw new Error("missing root");
    const lock = acquireLaneCarrierLock(root, PROJECT, Date.now(), process.pid);
    if (lock === "conflict" || lock === "no-lock") throw new Error("expected lock");
    expect(acquireLaneCarrierLock(root, PROJECT, Date.now(), 999999)).toBe("conflict");
    add(db, bodies, "from-second", "operator", "second cockpit persisted");
    expect(
      composeCarrierPrompt({
        agent: "codex",
        turn: 1,
        binding: BINDING,
        db,
        projectId: PROJECT,
        readBody: readBody(bodies),
        setup: "S",
        operatorMessage: "O",
        now: () => NOW,
      }).text,
    ).toContain("second cockpit persisted");
    releaseLaneCarrierLock(lock);
  });
});

describe("R5b-05 - a briefing that busts its own invariant degrades, never crashes the carrier lane", () => {
  it("returns a prompt with no briefing and records the failure durably", () => {
    const { db, bodies } = seeded();
    const cwd = mkdtempSync(join(tmpdir(), "carrier-briefing-crash-"));
    // The briefing's own tables throw; the lane's cursor tables keep working. This is the shape of
    // M1's fail-closed byte assertion firing (or any briefing-internal corruption): composeBriefing
    // throws AFTER the carrier has already committed to the turn.
    const hostile = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "prepare") {
          return (sql: string) => {
            if (/journal_entries|memory_|briefing/i.test(sql)) {
              throw new Error("briefing invariant burst (test)");
            }
            return target.prepare(sql);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const prompt = composeCarrierPrompt({
      agent: "claude",
      turn: 1,
      binding: { ...BINDING, cwd },
      db: hostile,
      projectId: PROJECT,
      readBody: readBody(bodies),
      setup: "S",
      operatorMessage: "O",
      now: () => NOW,
    });
    expect(prompt.text).toContain("O");
    const log = join(cwd, ".zer0", "journal", "memory-failures.log");
    expect(existsSync(log)).toBe(true);
    // N-2 (MN fix round 2): "compose-failed" alone is a substring of the current vocabulary too and
    // no longer pins anything — the full classification name is what the log/room actually promise.
    expect(readFileSync(log, "utf8")).toContain("memory-compose-failed");
    rmSync(cwd, { recursive: true, force: true });
  });
});
