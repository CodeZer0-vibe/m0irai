import { expect, it, vi } from "vitest";
import type { NativeModeState } from "../chat/native-mode.js";
import { RoomModeController, type RoomModeEventPayload } from "./room-mode.js";

const careful: NativeModeState = {
  claude: { modeId: "default", status: "active" },
  codex: { modeId: "agent", status: "active" },
  gemini: { modeId: "accept-edits", status: "active" },
};

function controller(options: {
  readonly state?: NativeModeState;
  readonly persisted?: boolean;
  readonly setLaneMode?: ReturnType<typeof vi.fn>;
  readonly setAgentMode?: ReturnType<typeof vi.fn>;
}) {
  const events: RoomModeEventPayload[] = [];
  const persist = vi.fn(() => ({ outcome: "written" as const }));
  const room = new RoomModeController({
    repoRoot: "C:/room",
    emit: (event) => events.push(event),
    boot: () => ({ state: options.state ?? careful, persisted: options.persisted ?? true }),
    persist,
    setLaneMode: options.setLaneMode ?? vi.fn(async () => ({ outcome: "applied" as const })),
    setAgentMode: options.setAgentMode ?? vi.fn(),
  });
  return { room, events, persist };
}

it("falsifier: plain Shift+Tab calls every real provider owner and persists the careful-to-plan tier", async () => {
  const setLaneMode = vi.fn(async () => ({ outcome: "applied" as const }));
  const setAgentMode = vi.fn();
  const { room, events, persist } = controller({ setLaneMode, setAgentMode });
  room.boot();
  await room.cycle("");
  expect(setAgentMode).toHaveBeenCalledWith("gemini", "accept-edits");
  expect(setAgentMode).toHaveBeenLastCalledWith("gemini", "plan");
  expect(setLaneMode).toHaveBeenCalledWith("claude", "plan");
  expect(setLaneMode).toHaveBeenCalledWith("codex", "read-only");
  expect(persist).toHaveBeenCalled();
  const active = events.filter((event) => event.status === "active");
  expect(active.filter((event) => event.agent === "claude").at(-1)).toMatchObject({
    agent: "claude",
    modeId: "plan",
    word: "plan",
  });
  expect(active.filter((event) => event.agent === "gemini").at(-1)).toMatchObject({
    agent: "gemini",
    modeId: "plan",
    word: "plan",
  });
});

it("publishes the authoritative Gemini mode on a fresh room without inventing ACP modes", () => {
  const { room, events } = controller({ persisted: false });
  room.boot();

  expect(events).toEqual([
    expect.objectContaining({
      agent: "gemini",
      modeId: "accept-edits",
      status: "active",
      word: "edits",
    }),
  ]);
});

it("publishes a failed Gemini boot mode when the local AGY mode owner rejects it", () => {
  const { room, events } = controller({
    persisted: false,
    setAgentMode: vi.fn(() => {
      throw new Error("mode unavailable");
    }),
  });
  room.boot();

  expect(events).toEqual([
    expect.objectContaining({ agent: "gemini", status: "failed", error: "mode unavailable" }),
  ]);
});

it("starts independent ACP mode changes together instead of serializing provider timeouts", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setLaneMode = vi.fn(async () => {
    await gate;
    return { outcome: "applied" as const };
  });
  const { room } = controller({ setLaneMode });

  const cycling = room.cycle("");
  expect(setLaneMode).toHaveBeenCalledTimes(2);
  release();
  await cycling;
});

it("falsifier: an addressed cycle changes only that provider catalog and leaves the draft parser shared", async () => {
  const setLaneMode = vi.fn(async () => ({ outcome: "applied" as const }));
  const { room } = controller({ setLaneMode });
  await room.cycle("@codex inspect this");
  expect(setLaneMode).toHaveBeenCalledTimes(1);
  expect(setLaneMode).toHaveBeenCalledWith("codex", "agent-full-access");
});

it("falsifier: no-session intent remains pending until the real mode.session event confirms it", async () => {
  const setLaneMode = vi.fn(async () => ({ outcome: "noSession" as const }));
  const { room, events, persist } = controller({ setLaneMode });
  await room.cycle("@claude explain");
  expect(events.at(-1)).toMatchObject({
    agent: "claude",
    modeId: "acceptEdits",
    status: "pending",
  });
  expect(persist).toHaveBeenCalled();
  room.onModeSession({
    kind: "mode.session",
    agent: "claude",
    turn: 1,
    outcome: "applied",
    modeId: "acceptEdits",
    availableModeIds: ["default", "acceptEdits", "plan"],
  });
  expect(events.at(-1)).toMatchObject({
    agent: "claude",
    modeId: "acceptEdits",
    status: "active",
    availableModeIds: ["default", "acceptEdits", "plan"],
  });
});

it("falsifier: provider errors revert visibly and never reject the room mode RPC", async () => {
  const setLaneMode = vi.fn(async () => ({
    outcome: "failed" as const,
    reason: "bridge rejected",
  }));
  const { room, events } = controller({ setLaneMode });
  await expect(room.cycle("@claude explain")).resolves.toBeUndefined();
  expect(events.at(-1)).toMatchObject({
    agent: "claude",
    modeId: "default",
    status: "failed",
    error: "bridge rejected",
  });
});

it("falsifier: an unsafe provider acknowledgement clears pending intent and reverts visibly", async () => {
  const setLaneMode = vi.fn(async () => ({ outcome: "noSession" as const }));
  const { room, events } = controller({ setLaneMode });
  await room.cycle("@claude explain");
  expect(events.at(-1)).toMatchObject({
    agent: "claude",
    modeId: "acceptEdits",
    status: "pending",
  });

  room.onModeSession({
    kind: "mode.session",
    agent: "claude",
    turn: 1,
    outcome: "applied",
    modeId: "bad\u001b[31m",
  });
  expect(events.at(-1)).toMatchObject({
    agent: "claude",
    modeId: "default",
    status: "failed",
    error: "provider reported an unsafe mode id",
  });
});
