/**
 * @file src/adapters/acp/acp-lane-session.test.ts
 * @purpose Falsifiers for MT7 ACP lane sessions over injected lane-state and child/connection seams.
 * @exports (test suite - no runtime exports)
 * @depends vitest, ./acp-lane-session
 */
import { expect, it } from "vitest";
import {
  type LaneBinding,
  type LaneConnection,
  type LaneSessionDeps,
  type LaneSessionInput,
  type LaneSessionRow,
  type LaneStateStore,
  openLaneSession,
} from "./acp-lane-session.js";

const DB = { tag: "db" };
const NOW = "2026-07-10T00:00:00Z";

type TestDb = typeof DB;

function row(overrides: Partial<LaneSessionRow> = {}): LaneSessionRow {
  return {
    adapterPkg: "claude-agent-acp",
    adapterVersion: "0.58.1",
    agent: "claude",
    cwd: "C:/repo",
    projectId: "p1",
    sessionId: "stored-session",
    ...overrides,
  };
}

function store(stored: LaneSessionRow | undefined): LaneStateStore<TestDb> & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    getLaneSession: () => stored,
    laneBindingMatches: (session, binding) => bindingMatches(session, binding),
    touchResumed: (_db, projectId, agent, now) => touched.push(`${projectId}:${agent}:${now}`),
  };
}

function bindingMatches(session: LaneSessionRow, binding: LaneBinding): boolean {
  return (
    session.cwd === binding.cwd &&
    session.adapterPkg === binding.adapterPkg &&
    session.adapterVersion === binding.adapterVersion
  );
}

function input(laneStore: LaneStateStore<TestDb>): LaneSessionInput<TestDb> {
  return {
    adapterPkg: "claude-agent-acp",
    adapterVersion: "0.58.1",
    agent: "claude",
    cwd: "C:/repo",
    db: DB,
    projectId: "p1",
    store: laneStore,
  };
}

function fakeDeps(conn: LaneConnection): LaneSessionDeps {
  return {
    closeWaitMs: 1,
    now: () => NOW,
    openConnection: async () => conn,
  };
}

function connection(): LaneConnection & {
  prompts: string[];
  resumes: string[];
  modeSets: string[];
  news: number;
} {
  const state = {
    alive: true,
    news: 0,
    prompts: [] as string[],
    resumes: [] as string[],
    modeSets: [] as string[],
  };
  return {
    get news() {
      return state.news;
    },
    prompts: state.prompts,
    resumes: state.resumes,
    modeSets: state.modeSets,
    close: () => {
      state.alive = false;
    },
    initialize: async () => undefined,
    isAlive: () => state.alive,
    killTree: async () => {
      state.alive = false;
    },
    newSession: async () => {
      state.news += 1;
      return { sessionId: "new-session" };
    },
    pid: () => 1234,
    prompt: async (sessionId, text) => {
      state.prompts.push(`${sessionId}:${text}`);
      return "end_turn";
    },
    resumeSession: async (sessionId) => {
      state.resumes.push(sessionId);
      return {};
    },
    setMode: async (sessionId, modeId) => {
      state.modeSets.push(`${sessionId}:${modeId}`);
    },
    waitForExit: async () => !state.alive,
  };
}

it("no stored row creates a native session and consecutive prompts reuse the same child", async () => {
  const conn = connection();
  const opened = await openLaneSession(input(store(undefined)), fakeDeps(conn));
  expect(opened.outcome).toBe("created");
  if (opened.outcome !== "created") throw new Error("expected created");

  await opened.session.prompt("one");
  await opened.session.prompt("two");

  expect(conn.news).toBe(1);
  expect(conn.resumes).toEqual([]);
  expect(conn.prompts).toEqual(["new-session:one", "new-session:two"]);
});

it("W4-1: LaneSession.setMode threads the session's own sessionId to the connection", async () => {
  const conn = connection();
  const opened = await openLaneSession(input(store(undefined)), fakeDeps(conn));
  if (opened.outcome !== "created") throw new Error("expected created");

  await opened.session.setMode("plan");

  expect(conn.modeSets).toEqual(["new-session:plan"]); // the SAME sessionId prompt() would use
});

it("matching stored row resumes once, touches last_resumed_at, and forwards raw session updates", async () => {
  const laneStore = store(row());
  const rawUpdates: unknown[] = [];
  const conn = connection();
  conn.prompt = async (_sessionId, _text, emit) => {
    emit({ sessionUpdate: "usage_update", size: 200, used: 100 });
    emit({ sessionUpdate: "thread/compacted", reason: "test" });
    return "end_turn";
  };

  const opened = await openLaneSession(
    { ...input(laneStore), onSessionUpdate: (update) => rawUpdates.push(update) },
    fakeDeps(conn),
  );
  expect(opened.outcome).toBe("resumed");
  if (opened.outcome !== "resumed") throw new Error("expected resumed");

  const turn = await opened.session.prompt("recall");

  expect(conn.resumes).toEqual(["stored-session"]);
  expect(laneStore.touched).toEqual(["p1:claude:2026-07-10T00:00:00Z"]);
  expect(turn.usage).toEqual({ size: 200, used: 100 });
  expect(rawUpdates).toEqual([
    { sessionUpdate: "usage_update", size: 200, used: 100 },
    { sessionUpdate: "thread/compacted", reason: "test" },
  ]);
});

it("any binding mismatch returns invalidBinding and never attempts resume", async () => {
  const mismatches = [
    row({ projectId: "other" }),
    row({ cwd: "C:/other" }),
    row({ adapterPkg: "codex-acp" }),
    row({ adapterVersion: "1.2.3" }),
  ];

  for (const stored of mismatches) {
    let openedChild = false;
    const result = await openLaneSession(input(store(stored)), {
      ...fakeDeps(connection()),
      openConnection: async () => {
        openedChild = true;
        return connection();
      },
    });
    expect(result).toMatchObject({ outcome: "invalidBinding" });
    expect(openedChild).toBe(false);
  }
});

it("a resume exception is a distinct resumeFailed outcome", async () => {
  const conn = connection();
  conn.resumeSession = async () => {
    throw new Error("unknown session");
  };

  const result = await openLaneSession(input(store(row())), fakeDeps(conn));

  expect(result).toMatchObject({ outcome: "resumeFailed", sessionId: "stored-session" });
  expect(conn.isAlive()).toBe(false);
});

it("close escalates through killTree and returns a surviving orphan pid", async () => {
  const conn = connection();
  let treeKills = 0;
  conn.close = () => undefined;
  conn.killTree = async () => {
    treeKills += 1;
  };
  const opened = await openLaneSession(input(store(undefined)), fakeDeps(conn));
  if (opened.outcome !== "created") throw new Error("expected created");

  const closed = await opened.session.close();

  expect(treeKills).toBe(1);
  expect(closed).toEqual({ outcome: "orphan", pid: 1234 });
});
