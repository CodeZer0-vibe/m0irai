/**
 * @file src/adapters/acp/acp-permission.test.ts
 * @purpose Falsifiers for both deciders' resolved PermissionDecision (W4-B fix round 1 CONCERN 2: the
 *   exact wire envelope, not a bare optionId). autoApproveDecider selects the "allow"-kind option (case-
 *   insensitive), falls back to the first option, then the protocol's {kind:"cancelled"} envelope —
 *   never a fabricated option ID. denyDecider picks an OFFERED reject_once/
 *   reject_always option ONLY — never fabricates an id; an allow-only (or empty) options list produces
 *   the protocol's own {kind:"cancelled"} shape instead.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-permission
 */
import { describe, expect, it } from "vitest";
import { autoApproveDecider, denyDecider } from "./acp-permission.js";

it("selects the allow-kind option (not the deny)", async () => {
  const chosen = await autoApproveDecider({
    options: [
      { kind: "deny", optionId: "no" },
      { kind: "allow_once", optionId: "yes" },
    ],
  });
  expect(chosen).toEqual({ kind: "selected", optionId: "yes" });
});

it("is case-insensitive on kind", async () => {
  expect(await autoApproveDecider({ options: [{ kind: "ALLOW", optionId: "ok" }] })).toEqual({
    kind: "selected",
    optionId: "ok",
  });
});

it("falls back to the FIRST option when no allow-kind exists", async () => {
  const chosen = await autoApproveDecider({
    options: [
      { kind: "reject", optionId: "first" },
      { kind: "cancel", optionId: "second" },
    ],
  });
  expect(chosen).toEqual({ kind: "selected", optionId: "first" });
});

it("cancels when there are no offered options", async () => {
  expect(await autoApproveDecider({})).toEqual({ kind: "cancelled" });
  expect(await autoApproveDecider({ options: [] })).toEqual({ kind: "cancelled" });
});

// W4-3 / W4-B fix round 1 CONCERN 2: denyDecider is the FAIL-CLOSED default acp-lane-connection.ts's
// resolveDecider reaches for when no operator decider is wired in — the referee's named trap (a live
// interactive lane silently auto-approving) is closed here at the option-selection level too. CONCERN 2
// closed the SECOND gap: "reject" was a FABRICATED optionId the bridge never offered (wire-valid, but
// non-conformant — ACP semantics require selecting an OFFERED option). The ladder is now EXACT-kind,
// ordered (reject_once, else reject_always), never a substring/case-insensitive match, and never a
// fallback to "the first option" — an allow-only options list produces the protocol's own not-approved
// {kind:"cancelled"} envelope (schema.json's RequestPermissionOutcome) instead.
describe("denyDecider (W4-B fix round 1 CONCERN 2: kind-based, offered-option-only, cancelled fallback)", () => {
  it("picks the OFFERED reject_once option by its exact id — asserting the exact wire envelope", async () => {
    const chosen = await denyDecider({
      options: [
        { kind: "allow_once", optionId: "yes" },
        { kind: "reject_once", optionId: "no" },
      ],
    });
    expect(chosen).toEqual({ kind: "selected", optionId: "no" });
  });

  it("prefers reject_once over reject_always when BOTH are offered", async () => {
    const chosen = await denyDecider({
      options: [
        { kind: "reject_always", optionId: "no-forever" },
        { kind: "reject_once", optionId: "no-once" },
      ],
    });
    expect(chosen).toEqual({ kind: "selected", optionId: "no-once" });
  });

  it("falls back to reject_always when reject_once is NOT offered", async () => {
    const chosen = await denyDecider({
      options: [
        { kind: "allow_once", optionId: "yes" },
        { kind: "reject_always", optionId: "no-forever" },
      ],
    });
    expect(chosen).toEqual({ kind: "selected", optionId: "no-forever" });
  });
});

// Split from the describe block above to stay under the function-length clamp (gate-clamps.mjs, 50
// lines) — the {kind:"cancelled"} fallback cases (no offered reject-kind option to select).
describe("denyDecider: the {kind:'cancelled'} fallback (no offered reject option)", () => {
  it("an ALLOW-ONLY options list produces the protocol's {kind:'cancelled'} envelope — never a fabricated id", async () => {
    const chosen = await denyDecider({
      options: [
        { kind: "allow_once", optionId: "yes" },
        { kind: "allow_always", optionId: "yes-forever" },
      ],
    });
    expect(chosen).toEqual({ kind: "cancelled" });
  });

  it("no options at all ALSO produces {kind:'cancelled'} — never the literal 'reject'", async () => {
    expect(await denyDecider({})).toEqual({ kind: "cancelled" });
    expect(await denyDecider({ options: [] })).toEqual({ kind: "cancelled" });
  });

  it("exact-kind match ONLY — a kind that merely CONTAINS 'reject' (not the real enum value) is never picked", async () => {
    // ACP's PermissionOptionKind enum has exactly 4 values (schema.json): allow_once/allow_always/
    // reject_once/reject_always. A future/unknown kind string must never false-match via substring —
    // this is why denyDecider uses exact equality, not the /reject|deny/i pattern pickOptionByKind uses.
    const chosen = await denyDecider({
      options: [{ kind: "reject_once_extended_hypothetical", optionId: "should-not-match" }],
    });
    expect(chosen).toEqual({ kind: "cancelled" });
  });
});
