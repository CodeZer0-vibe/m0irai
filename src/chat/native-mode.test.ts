/**
 * @file src/chat/native-mode.test.ts
 * @purpose Falsifiers for the native-mode pure state model: each engine's own catalog cycles in its own
 *   native order and wraps; beginCycle/applyActive/applyFailed transitions match the W4-1 FAILURE
 *   CONTRACT (ack -> PENDING, not active; failure -> revert + visible error, never silently pending).
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./native-mode
 */
import { describe, expect, it } from "vitest";
import {
  MODE_CATALOG,
  applyActive,
  applyAdopted,
  applyCatalog,
  applyFailed,
  attachPersistWarning,
  beginCycle,
  effectiveCatalog,
  initialNativeModeState,
  modeToken,
  nextModeId,
} from "./native-mode.js";

describe("native-mode: per-engine catalogs (native vocabulary, never zer0-invented)", () => {
  it("claude, codex, and gemini each expose their OWN catalog, not a shared normalized list", () => {
    expect(MODE_CATALOG.claude).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "bypassPermissions",
    ]);
    expect(MODE_CATALOG.codex).toEqual(["read-only", "agent", "agent-full-access"]);
    expect(MODE_CATALOG.gemini).toEqual(["auto", "accept-edits", "plan"]);
  });

  it("initialNativeModeState seeds every engine on its catalog's FIRST entry, already active", () => {
    const state = initialNativeModeState();
    expect(state.claude).toEqual({ modeId: "default", status: "active" });
    expect(state.codex).toEqual({ modeId: "read-only", status: "active" });
    expect(state.gemini).toEqual({ modeId: "auto", status: "active" });
  });
});

describe("native-mode: nextModeId cycles each engine's own list and wraps", () => {
  it("advances one step through claude's 5-mode list", () => {
    expect(nextModeId("claude", "default")).toBe("acceptEdits");
    expect(nextModeId("claude", "acceptEdits")).toBe("plan");
    expect(nextModeId("claude", "plan")).toBe("dontAsk");
    expect(nextModeId("claude", "dontAsk")).toBe("bypassPermissions");
  });

  it("wraps from the LAST entry back to the FIRST", () => {
    expect(nextModeId("claude", "bypassPermissions")).toBe("default");
    expect(nextModeId("codex", "agent-full-access")).toBe("read-only");
    expect(nextModeId("gemini", "plan")).toBe("auto");
  });

  it("an unrecognized current id (stale persisted value) restarts at the catalog's first entry", () => {
    expect(nextModeId("codex", "some-removed-preset")).toBe("read-only");
  });
});

describe("native-mode: beginCycle / applyActive / applyFailed — the W4-1 state machine", () => {
  it("beginCycle advances the targeted engine to PENDING, leaves the others untouched", () => {
    const state = initialNativeModeState();
    const next = beginCycle(state, "codex");
    expect(next.codex).toEqual({ modeId: "agent", status: "pending" });
    expect(next.claude).toBe(state.claude); // untouched reference — no other engine's slice changed
    expect(next.gemini).toBe(state.gemini);
  });

  it("applyActive confirms the pending mode as active and clears any prior error", () => {
    const pending = beginCycle(initialNativeModeState(), "claude");
    const failed = applyFailed(pending, "claude", "default", "rejected");
    const retried = beginCycle(failed, "claude");
    const active = applyActive(retried, "claude", retried.claude.modeId);
    expect(active.claude).toEqual({ modeId: "acceptEdits", status: "active" });
    expect(active.claude.error).toBeUndefined();
  });

  it("applyFailed REVERTS the selection to the pre-cycle mode and attaches a visible error — never left silently pending", () => {
    const state = initialNativeModeState();
    const pending = beginCycle(state, "claude"); // default -> acceptEdits, pending
    const reverted = applyFailed(pending, "claude", "default", "setSessionMode rejected: denied");
    expect(reverted.claude).toEqual({
      modeId: "default",
      status: "active",
      error: "setSessionMode rejected: denied",
    });
  });

  it("a cycle-begin-then-fail-then-cycle-again sequence never leaves a PENDING mode stuck forever", () => {
    let state = initialNativeModeState();
    state = beginCycle(state, "codex");
    state = applyFailed(state, "codex", "read-only", "timed out");
    expect(state.codex.status).toBe("active"); // reverted, not stuck pending
    state = beginCycle(state, "codex");
    expect(state.codex.status).toBe("pending");
    state = applyActive(state, "codex", state.codex.modeId);
    expect(state.codex).toEqual({ modeId: "agent", status: "active" });
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50
// lines) — mirrors this file's own established precedent for a describe block that outgrows it.
describe("native-mode: W4-R FIX-1 B3 — applyActive's staleness guard", () => {
  it("a STALE confirmation (modeId no longer matches the slice's current pending target) is ignored — never applied, never reverted", () => {
    // claude cycles default -> acceptEdits, pending (mirrors a boot-apply kickoff for "acceptEdits").
    const firstPending = beginCycle(initialNativeModeState(), "claude");
    // The operator Shift+Tabs AGAIN before that first confirmation lands — claude moves to "plan".
    const secondPending = beginCycle(firstPending, "claude");
    expect(secondPending.claude).toEqual({ modeId: "plan", status: "pending" });
    // The FIRST cycle's stale confirmation ("acceptEdits") now arrives late.
    const afterStaleAck = applyActive(secondPending, "claude", "acceptEdits");
    // Untouched — still pending on "plan", the target the operator actually left it on. A genuine
    // no-op, not a reconstructed-but-equal object: same reference, proving nothing was silently redone.
    expect(afterStaleAck).toBe(secondPending);
    expect(afterStaleAck.claude).toEqual({ modeId: "plan", status: "pending" });
  });
});

// W4-R FIX-1b ROUND 2 (MAX review BLOCK): applyAdopted is applyActive's SIBLING with a DELIBERATELY
// different guard — "any mismatch is stale" (applyActive) is wrong for a resume's adopted ground truth,
// which never made a live call the way a genuine confirmation did. The ONLY thing that outranks
// adoption is a local pending cycle already in flight.
describe("native-mode: applyAdopted — a resume's ground truth wins over a stale seed, but a local pending wins over adoption", () => {
  it("adopts the resumed session's modeId over a stale persisted/boot-seeded value when NO local pending exists", () => {
    const state = {
      ...initialNativeModeState(),
      claude: { modeId: "bypassPermissions", status: "active" as const }, // Y: the stale boot seed
    };
    const adopted = applyAdopted(state, "claude", "plan"); // X: the resumed session's own truth
    expect(adopted.claude).toEqual({ modeId: "plan", status: "active" });
  });

  it("a LOCAL PENDING cycle wins over an adoption — the adoption is silently dropped, never applied or reverted", () => {
    const state = {
      ...initialNativeModeState(),
      claude: { modeId: "dontAsk", status: "pending" as const }, // Z: the operator's own already-committed cycle
    };
    const adopted = applyAdopted(state, "claude", "plan"); // X arrives after Z was already requested
    expect(adopted.claude).toEqual({ modeId: "dontAsk", status: "pending" }); // untouched — Z still wins
  });

  it("clears a stale error left by an earlier failed cycle when adopting", () => {
    const state = {
      ...initialNativeModeState(),
      claude: { modeId: "default", status: "active" as const, error: "setMode rejected" },
    };
    const adopted = applyAdopted(state, "claude", "plan");
    expect(adopted.claude).toEqual({ modeId: "plan", status: "active" }); // no `error` key at all
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50
// lines) — same established precedent this file's own B3 describe block already uses.
describe("native-mode: applyAdopted — catalog preservation and per-engine parity", () => {
  it("preserves the slice's already-live catalog — adoption never wipes a session's own advertised list", () => {
    const state = {
      ...initialNativeModeState(),
      claude: { modeId: "default", status: "active" as const, catalog: ["default", "auto"] },
    };
    const adopted = applyAdopted(state, "claude", "auto");
    expect(adopted.claude).toEqual({
      modeId: "auto",
      status: "active",
      catalog: ["default", "auto"],
    });
  });

  it.each(["claude", "codex", "gemini"] as const)(
    "parity: %s adopts identically — the logic is engine-agnostic",
    (engine) => {
      const state = {
        ...initialNativeModeState(),
        [engine]: { modeId: "seed", status: "active" as const },
      };
      const adopted = applyAdopted(state, engine, "truth");
      expect(adopted[engine]).toEqual({ modeId: "truth", status: "active" });
    },
  );
});

describe("native-mode: modeToken — compact panel labels", () => {
  it("returns the known short token for each catalog entry", () => {
    expect(modeToken("claude", "acceptEdits")).toBe("edit");
    expect(modeToken("codex", "agent-full-access")).toBe("full");
    expect(modeToken("gemini", "accept-edits")).toBe("edit");
  });

  it("degrades to a truncated raw id for an unrecognized mode rather than a blank cell", () => {
    expect(modeToken("codex", "some-new-preset-name")).toBe("some-n");
  });
});

// B3 (MAX review fix round 1): a session's LIVE bridge-advertised catalog overrides MODE_CATALOG's
// static pre-session fallback for cycling — the mechanism that lets claude's gated "auto" (excluded
// from the static list) become reachable once a session actually confirms it is available.
describe("native-mode: effectiveCatalog/applyCatalog/nextModeId(catalog) — B3's live-catalog override", () => {
  it("effectiveCatalog falls back to MODE_CATALOG when no live catalog has been captured", () => {
    const state = initialNativeModeState();
    expect(effectiveCatalog("claude", state.claude)).toBe(MODE_CATALOG.claude);
  });

  it("applyCatalog records a live catalog WITHOUT touching modeId/status/error", () => {
    const pending = beginCycle(initialNativeModeState(), "claude");
    const withCatalog = applyCatalog(pending, "claude", ["default", "auto"]);
    expect(withCatalog.claude).toEqual({
      modeId: "acceptEdits",
      status: "pending",
      catalog: ["default", "auto"],
    });
  });

  it("effectiveCatalog returns the LIVE catalog once one has been captured, not the static fallback", () => {
    const state = applyCatalog(initialNativeModeState(), "claude", ["default", "auto"]);
    expect(effectiveCatalog("claude", state.claude)).toEqual(["default", "auto"]);
  });

  it("nextModeId cycles within an explicit catalog (including an entry the static fallback excludes)", () => {
    expect(nextModeId("claude", "default", ["default", "auto"])).toBe("auto");
    expect(nextModeId("claude", "auto", ["default", "auto"])).toBe("default"); // wraps within the LIVE list
  });

  it("nextModeId defaults to MODE_CATALOG when no catalog argument is given (backward-compatible)", () => {
    expect(nextModeId("claude", "default")).toBe("acceptEdits");
  });

  it("beginCycle reads the LIVE catalog via effectiveCatalog, not the static fallback", () => {
    const live = applyCatalog(initialNativeModeState(), "claude", ["default", "auto"]);
    const cycled = beginCycle(live, "claude");
    expect(cycled.claude.modeId).toBe("auto"); // NOT "acceptEdits" (the static catalog's next entry)
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50
// lines) — mirrors this file's own established precedent for a describe block that outgrows it.
describe("native-mode: B3's live-catalog override — applyActive/applyFailed preserve it", () => {
  it("applyActive and applyFailed both PRESERVE a previously captured live catalog", () => {
    const live = applyCatalog(beginCycle(initialNativeModeState(), "claude"), "claude", [
      "default",
      "auto",
    ]);
    expect(applyActive(live, "claude", live.claude.modeId).claude.catalog).toEqual([
      "default",
      "auto",
    ]);
    expect(applyFailed(live, "claude", "default", "rejected").claude.catalog).toEqual([
      "default",
      "auto",
    ]);
  });
});

// C6 (MAX review fix round 1 CONCERN): distinct from applyFailed — the live mode change already
// succeeded here (native-mode-store.ts's persistNativeMode failing is a NEXT-BOOT durability problem,
// not a live-application rejection), so attachPersistWarning must NEVER revert modeId/status the way
// applyFailed's FAILURE CONTRACT does.
describe("native-mode: attachPersistWarning — C6's persist-failure marker, distinct from applyFailed", () => {
  it("attaches the error while leaving modeId/status/catalog byte-identical to the live-applied slice", () => {
    const pendingClaude = beginCycle(initialNativeModeState(), "claude");
    const live = applyCatalog(
      applyActive(pendingClaude, "claude", pendingClaude.claude.modeId),
      "claude",
      ["default", "acceptEdits"],
    );
    const warned = attachPersistWarning(live, "claude", "rename ENOENT: .zer0/native-mode.json");
    expect(warned.claude).toEqual({
      modeId: "acceptEdits",
      status: "active",
      catalog: ["default", "acceptEdits"],
      error: "rename ENOENT: .zer0/native-mode.json",
    });
  });

  it("does NOT revert modeId — unlike applyFailed, the live mode already applied successfully", () => {
    const state = initialNativeModeState(); // claude at "default", active
    const warned = attachPersistWarning(state, "claude", "write EACCES");
    expect(warned.claude.modeId).toBe("default"); // the CURRENT (already-active) mode, never reverted
    expect(warned.claude.status).toBe("active");
    expect(warned.claude.error).toBe("write EACCES");
  });

  it("touches ONLY the targeted engine's slice", () => {
    const state = initialNativeModeState();
    const warned = attachPersistWarning(state, "codex", "temp write failed");
    expect(warned.claude).toBe(state.claude);
    expect(warned.gemini).toBe(state.gemini);
  });
});

// REMOVED (W4-R REFIT, R4): formatNativeModeBootLine's own describe block — the function itself is
// gone (see native-mode.ts's own header comment at the removal site).
