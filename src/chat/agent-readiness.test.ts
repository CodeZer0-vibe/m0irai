/**
 * @file src/chat/agent-readiness.test.ts
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./agent-readiness
 * @purpose The PURE readiness record — what a probe outcome decides, and what the room starts from.
 *   No I/O at all: the interesting mistakes at this layer are decisions, not syscalls, and the two
 *   assertions here that would cost an operator something are the precondition refusals — a chip that
 *   states a problem and offers no way to fix it is silent at the render.
 *
 *   The probes that FEED this are contracted next door, in agent-readiness-probe.test.ts.
 */
import { expect, it } from "vitest";
import { UNKNOWN_READINESS, isUnusable, readinessFrom } from "./agent-readiness.js";
it("PIN: the record a room starts with is every agent unknown, and it is frozen", () => {
  // A submit that beats the probe reads this record. `unknown` is not `unusable`, so the filter removes
  // nothing and the room dispatches exactly the three agents it dispatches today.
  expect(UNKNOWN_READINESS).toEqual({
    claude: { state: "unknown" },
    codex: { state: "unknown" },
    gemini: { state: "unknown" },
  });
  expect(Object.isFrozen(UNKNOWN_READINESS)).toBe(true);
  expect(Object.isFrozen(UNKNOWN_READINESS.claude)).toBe(true);
  expect(isUnusable(UNKNOWN_READINESS.claude)).toBe(false);
});

it("FALSIFIER: a state that cannot be acted on is refused at construction", () => {
  // Both of these paint a chip that states a problem and offers nothing, and both are silent at the
  // render — the operator sees "needs sign-in" and no way to do it.
  expect(() => readinessFrom({ installed: "yes", loggedIn: "no" })).toThrow(
    "a needs_login agent must carry a command",
  );
  expect(() =>
    readinessFrom({ installed: "no", loggedIn: "unknown", installReason: "gone" }),
  ).toThrow("an unusable agent must carry a remedy");
  expect(() => readinessFrom({ installed: "no", loggedIn: "unknown" })).toThrow(
    "an unusable agent must carry a reason",
  );
  // Whitespace is not a command. A blank string satisfies `!== undefined` and renders as nothing.
  expect(() => readinessFrom({ installed: "yes", loggedIn: "no", loginCommand: "   " })).toThrow(
    "a needs_login agent must carry a command",
  );
});

it("PIN: install is decided before login — a missing binary is never told to sign in", () => {
  // Telling an operator to run a sign-in command for a binary they do not have sends them somewhere
  // with no fix at the end of it.
  expect(
    readinessFrom({
      installed: "no",
      loggedIn: "no",
      installReason: "not there",
      installRemedy: "install it",
      loginCommand: "sign in",
    }),
  ).toEqual({ state: "unusable", reason: "not there", remedy: "install it" });
});
