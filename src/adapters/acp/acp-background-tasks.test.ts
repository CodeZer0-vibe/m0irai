/**
 * @file src/adapters/acp/acp-background-tasks.test.ts
 * @purpose BLOCK 4 (FIX-3b / F6): the client half of the background-task surface. The claude ACP adapter
 *   used to DROP `background_tasks_changed` and every `task_*` signal (dist/acp-agent.js, the
 *   PATCH(zer0 f6-tasksurface) sites), so zer0 could never see live subagents/shells — live-proven to be
 *   why the inner claude read an empty TaskList as "my subagents died" and re-dispatched paid work. The
 *   receipted patch now forwards them on the adapter's `_claude/*` extension channel; this pins zer0's
 *   side of that contract: createAcpClient implements extNotification, routes it to onExtNotification,
 *   and NEVER lets a handler failure or a missing handler reach the bridge (the adapter forwards from
 *   inside its consumer loop, where a throw would brick the session).
 * @exports (none — test file)
 * @depends vitest, ./acp-permission, ./acp-turn-session
 */
import { describe, expect, it } from "vitest";
import { autoApproveDecider } from "./acp-permission.js";
import { createAcpClient } from "./acp-turn-session.js";

function client(onExtNotification?: (method: string, params: Record<string, unknown>) => void) {
  return createAcpClient({
    decide: autoApproveDecider,
    onUpdate: () => undefined,
    onUsage: () => undefined,
    ...(onExtNotification !== undefined ? { onExtNotification } : {}),
  });
}

const LIVE_SET = {
  sessionId: "s-1",
  reason: "membership_changed",
  tasks: [
    { task_id: "a6ead7c29f49d00a4", task_type: "local_agent", description: "reviewer fan-out" },
    { task_id: "bc6i7yinc", task_type: "local_bash", description: "tick loop" },
  ],
};

describe("F6: the bridge's background-task extension reaches zer0", () => {
  it("routes _claude/backgroundTasks to the handler with the live task set intact", async () => {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    await client((method, params) => seen.push({ method, params })).extNotification?.(
      "_claude/backgroundTasks",
      LIVE_SET,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("_claude/backgroundTasks");
    expect(seen[0]?.params.tasks).toEqual(LIVE_SET.tasks);
  });

  it("accepts the notification when no handler is wired (a client without the extension is supported)", async () => {
    await expect(
      client().extNotification?.("_claude/backgroundTasks", LIVE_SET),
    ).resolves.toBeUndefined();
  });

  it("swallows a throwing handler — a client-side bug must never fail the bridge's turn", async () => {
    const thrower = client(() => {
      throw new Error("consumer blew up");
    });
    await expect(
      thrower.extNotification?.("_claude/backgroundTasks", LIVE_SET),
    ).resolves.toBeUndefined();
  });

  it("passes unknown extension methods through untouched (no filtering, no crash)", async () => {
    const seen: string[] = [];
    await client((method) => seen.push(method)).extNotification?.("_claude/sdkMessage", {
      message: {},
    });
    expect(seen).toEqual(["_claude/sdkMessage"]);
  });
});
