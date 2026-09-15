/**
 * @file src/adapters/acp/acp-turn-cancel.test.ts
 * @purpose FL-150 ROUND 2 (review P1-B) — THE OPERATOR'S DEFECT ON THE NON-CARRIER PATH. FL-150 closed
 *   the carrier lane; this closes the other one. `dispatchAcpTurn` used to run
 *   `if (cancelled) session.close();` with no `return`, so an abort landing during the documented
 *   ~2-3 s handshake closed the late session and then called `session.prompt()` on it anyway.
 *   Reachable on every agent-to-agent hop (the room grants the carrier only to operator-origin lanes,
 *   so a hop's `origin: "agent"` takes this path) and on every turn with either memory flag off.
 * @exports (test suite — no runtime exports)
 * @depends vitest, ./acp-turn, ./acp-turn-session
 *
 * THE SHIPPED `dispatchAcpTurn`, driven through its own documented `open` seam — the injectable opener
 * that exists precisely so a test can stand where the bridge child would be. Nothing is mocked above it.
 *
 * THE WINDOW NEEDS NO CLOCK: the fake opener does not resolve until the test releases it, so the abort
 * is inside the handshake by construction, which is the instant the reviewer's probe caught.
 */
import { describe, expect, it } from "vitest";
import type { TurnSession } from "./acp-turn-session.js";
import { dispatchAcpTurn } from "./acp-turn.js";

interface Recorder {
  readonly prompts: string[];
  closes: number;
}

function fakeSession(record: Recorder): TurnSession {
  return {
    prompt: async (text: string) => {
      record.prompts.push(text);
      return { reply: "the answer nobody asked for", stopReason: "end_turn" };
    },
    setMode: async () => undefined,
    requireMode: async () => undefined,
    close: () => {
      record.closes += 1;
    },
  };
}

/** An opener held mid-handshake until the test releases it. */
function gatedOpener(record: Recorder, gate: Promise<void>) {
  return async (): Promise<TurnSession> => {
    await gate;
    return fakeSession(record);
  };
}

describe("FL-150: a cancel landing during the ACP handshake stops the turn", () => {
  it("composes and sends no prompt to the session it just closed", async () => {
    const record: Recorder = { prompts: [], closes: 0 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();

    const turn = dispatchAcpTurn(
      {
        agent: "claude",
        cwd: "/repo",
        promptText: "the prompt the operator cancelled",
        signal: controller.signal,
      },
      gatedOpener(record, gate),
    );

    // THE OPERATOR PRESSES ESC while the bridge is still coming up, then it finishes coming up.
    controller.abort();
    release?.();

    await expect(turn).rejects.toThrow(/aborted: ACP turn cancelled/);
    expect(
      record.prompts,
      "a prompt was composed and sent after the abort — the operator's own defect, on the hop path",
    ).toEqual([]);
    expect(record.closes, "the late session must still be closed, never leaked").toBeGreaterThan(0);
  });
});

/** THE DOOR: a turn already stopped before dispatch must not spawn a bridge child to throw away. */
describe("FL-150: an already-cancelled ACP turn never opens a session", () => {
  it("spawns no bridge child at all", async () => {
    const record: Recorder = { prompts: [], closes: 0 };
    let opens = 0;
    const controller = new AbortController();
    controller.abort();

    await expect(
      dispatchAcpTurn(
        { agent: "claude", cwd: "/repo", promptText: "stopped first", signal: controller.signal },
        async () => {
          opens += 1;
          return fakeSession(record);
        },
      ),
    ).rejects.toThrow(/aborted: ACP turn cancelled/);

    expect(opens, "a cancelled turn spawned a bridge child").toBe(0);
    expect(record.prompts).toEqual([]);
  });
});

/**
 * THE POSITIVE CONTROL. Without it the two cases above could pass because this fixture never reaches
 * the prompt at all — a green that proves the harness broken rather than the guard working.
 */
describe("FL-150: an uncancelled ACP turn is untouched", () => {
  it("still opens, prompts, and answers", async () => {
    const record: Recorder = { prompts: [], closes: 0 };

    const result = await dispatchAcpTurn(
      { agent: "claude", cwd: "/repo", promptText: "answer me" },
      async () => fakeSession(record),
    );

    expect(record.prompts).toEqual(["answer me"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("the answer nobody asked for");
  });
});
