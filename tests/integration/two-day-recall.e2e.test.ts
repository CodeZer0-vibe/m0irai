/**
 * @file tests/integration/two-day-recall.e2e.test.ts
 * @purpose T-FINAL AC-9 + AC-8, live. DAY 1: a real carrier turn (cockpit transport → real bridge)
 *   delivers a seeded decision to claude's NATIVE session, then the lane closes (ladder). AC-8: the
 *   bridge pid must be GONE from the process table post-close. "RESTART": every zer0 in-memory surface
 *   resets (carrier runtime, transport, db handle) — the durable store is the only bridge to day 2; the
 *   native-session holder crosses a REAL process death. DAY 2: a fresh transport resumes the STORED
 *   session id in a NEW bridge process; the composed prompt must carry ZERO briefing bytes and ZERO
 *   decision bytes — the live reply recalling the decision proves NATIVE-SESSION memory, the wave's
 *   namesake acceptance. (Plan letter says "two cockpit processes": cross-process STORE semantics are
 *   separately proven by the two-process lock/mint test; the death that matters is the native holder's.)
 * @exports (none — test file)
 * @depends node:fs, node:os, node:path, node:process, vitest, ../../src/adapters/acp/*, ../../src/chat/lane-carrier, ../../src/chat/lane-transport, ../../src/evidence/db, ../../src/memory/ledger
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, expect, it } from "vitest";
import { openAcpLaneConnection } from "../../src/adapters/acp/acp-lane-connection.js";
import { resolveAcpSpec } from "../../src/adapters/acp/acp-servers.js";
import { runCarrierTurn } from "../../src/chat/lane-carrier.js";
import { createCockpitLaneTransport, resetCarrierRuntime } from "../../src/chat/lane-transport.js";
import { closeDb, openLaneStateDb } from "../../src/evidence/db.js";
import { mintSeq } from "../../src/memory/ledger.js";

/** FL-150: CarrierTurnInput.signal is REQUIRED - a turn must name what can cancel it, because the ACP
 *  call site that could quietly omit it did, for the whole life of the defect. Nothing here cancels. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

const RUN_REAL_CLI = process.env.ZER0_REAL_CLI === "1";
const LIVE_TIMEOUT_MS = 300_000;
const NOW = "2026-07-10T09:30:00.000Z";
const RECEIPT_FILE = path.join(process.cwd(), ".council", "receipts", "mt7-two-day-recall.log");
const cleanupRoots: string[] = [];

function recordReceipt(line: string): void {
  console.log(line);
  mkdirSync(path.dirname(RECEIPT_FILE), { recursive: true });
  appendFileSync(RECEIPT_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
}

afterAll(() => {
  resetCarrierRuntime();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      recordReceipt(`MT7_TWODAY_CLEANUP leftover=${root}`);
    }
  }
});

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitPidGone(pid: number, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (pidGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return pidGone(pid);
}

interface TwoDayFixture {
  readonly dbPath: string;
  readonly repoRoot: string;
  readonly codename: string;
  readonly binding: { adapterPkg: string; adapterVersion: string; cwd: string };
  readonly readBody: (id: string) => { author: string; body: string };
}

function makeFixture(): TwoDayFixture {
  const storeRoot = mkdtempSync(path.join(tmpdir(), "twoday-store-"));
  const repoRoot = path.join(mkdtempSync(path.join(tmpdir(), "twoday-repo-")), "repo");
  mkdirSync(repoRoot, { recursive: true });
  cleanupRoots.push(storeRoot, path.dirname(repoRoot));
  const dbPath = path.join(storeRoot, "evidence.db");
  const codename = `MT7_TWODAY_${Date.now()}`;
  const bodies = new Map([
    ["m-decision", { author: "operator", body: `DECISION: the release codename is ${codename}.` }],
  ]);
  const db = openLaneStateDb(dbPath);
  db.prepare(
    "INSERT INTO projects(project_id, canonical_root, git_common_dir, created_at) VALUES (?,?,?,?)",
  ).run("p1", repoRoot, path.join(repoRoot, ".git"), NOW);
  mintSeq(db, "p1", "m-decision");
  closeDb(db);
  return {
    dbPath,
    repoRoot,
    codename,
    binding: { ...resolveAcpSpec("claude").binding, cwd: repoRoot },
    readBody: (id) => bodies.get(id) ?? { author: "operator", body: "" },
  };
}

async function runDay1(fx: TwoDayFixture) {
  const db = openLaneStateDb(fx.dbPath);
  let pid: number | undefined;
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: fx.repoRoot,
    repoRoot: fx.repoRoot,
    openConnection: async (input) => {
      const conn = await openAcpLaneConnection(input);
      pid = conn.pid();
      return conn;
    },
  });
  const turn = await runCarrierTurn({
    agent: "claude",
    turn: 1,
    binding: fx.binding,
    db,
    operatorMessage: "Operator: Acknowledge our decision above. Reply exactly: STORED.",
    projectId: "p1",
    readBody: fx.readBody,
    setup: "[zer0 team — you are claude. Be terse.]",
    transport,
    signal: NEVER_CANCELLED,
  });
  const closed = await transport.close();
  closeDb(db);
  recordReceipt(
    `MT7_TWODAY day1 session=${turn.sessionId} outcome=${turn.outcome} close=${closed.outcome} pid=${pid}`,
  );
  return { turn, pid };
}

async function runDay2(fx: TwoDayFixture) {
  const db = openLaneStateDb(fx.dbPath);
  let reply = "";
  const transport = createCockpitLaneTransport({
    agent: "claude",
    cwd: fx.repoRoot,
    repoRoot: fx.repoRoot,
    onText: (chunk) => {
      reply += chunk;
    },
  });
  const turn = await runCarrierTurn({
    agent: "claude",
    turn: 2,
    binding: fx.binding,
    db,
    operatorMessage:
      "Operator: What is the release codename from our decision? Reply with ONLY the codename.",
    projectId: "p1",
    readBody: fx.readBody,
    setup: "[zer0 team — you are claude. Be terse.]",
    transport,
    signal: NEVER_CANCELLED,
  });
  const artifactDir = path.join(process.cwd(), ".council", "receipts", "mt7-two-day-recall");
  mkdirSync(artifactDir, { recursive: true });
  const promptPath = path.join(artifactDir, "day2-prompt.md");
  writeFileSync(promptPath, turn.prompt ?? "", "utf8");
  recordReceipt(
    `MT7_TWODAY day2 session=${turn.sessionId} outcome=${turn.outcome} prompt=${promptPath} reply=${reply.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  await transport.close();
  closeDb(db);
  return { turn, reply };
}

it.skipIf(!RUN_REAL_CLI)(
  "AC-9 + AC-8: day-2 recalls day-1's decision on a briefing-free prompt via the resumed NATIVE session; the closed bridge leaves no process",
  async () => {
    const fx = makeFixture();

    // DAY 1: deliver the decision to the NATIVE session, close the lane, prove no orphan (AC-8).
    const day1 = await runDay1(fx);
    expect(day1.turn.outcome).toBe("accepted");
    if (day1.pid !== undefined) {
      expect(await waitPidGone(day1.pid, 10_000)).toBe(true);
      recordReceipt(`MT7_TWODAY ac8 pid=${day1.pid} gone=true`);
    }

    // "RESTART": every zer0 in-memory surface died with runDay1's handles; only the store crosses.
    resetCarrierRuntime();

    // DAY 2: fresh everything, NEW bridge process, resume by the STORED id (AC-9).
    const day2 = await runDay2(fx);
    expect(day2.turn.outcome).toBe("accepted");
    const day2Prompt = day2.turn.prompt ?? "";
    expect(day2.turn.sessionId).toBe(day1.turn.sessionId); // the SAME native session across death
    expect(day2Prompt).not.toContain("# Static memory briefing"); // ZERO briefing bytes
    expect(day2Prompt).not.toContain(fx.codename); // the prompt cannot be the recall channel
    expect(day2.reply).toContain(fx.codename); // NATIVE-SESSION memory carried the decision
  },
  LIVE_TIMEOUT_MS,
);
