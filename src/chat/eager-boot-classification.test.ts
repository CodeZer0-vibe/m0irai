/**
 * @file src/chat/eager-boot-classification.test.ts
 * @exports (test suite — no runtime exports)
 * @depends node:fs, node:os, node:path, vitest, ./eager-session-boot, ./events, ./lane-transport
 * @purpose Slice A site 1 — a logged-out codex reads as NEEDS SIGN-IN, not as offline.
 *
 *   The eager ACP open already discovers this: the bridge rejects with the SDK's own "Authentication
 *   required" and `classifyLaneFailure` has recognised that string for months. Nothing called it from
 *   the boot path, so the room painted `offline` — a true statement about the connection and a
 *   misleading one about the account, because the fix is a sign-in and the operator was being shown a
 *   word that suggests a restart. The wiring gap was the whole defect; the machinery was already there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, openLaneStateDb } from "../evidence/db.js";
import { codexLoginStateFrom, startEagerSessionBoot } from "./eager-session-boot.js";
import { type AgentStatusUpdateEvent, ChatEventBus } from "./events.js";
import { initCarrierRuntime, resetCarrierRuntime } from "./lane-transport.js";

/** FL-150: StartEagerSessionBootInput.signal is REQUIRED - the boot path feeds acquireLaneSession, and
 *  a boot with no cancel authority is the shape the required field exists to forbid. Production passes
 *  the room's shutdown signal (room-eager-sessions.ts's `start(bus, signal)`); this suite never aborts
 *  it, and now has to say so. */
const NEVER_CANCELLED: AbortSignal = new AbortController().signal;

const dirs: string[] = [];
afterEach(() => {
  resetCarrierRuntime();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The REAL SDK rejection string a logged-out bridge produces (`jsonrpc.js:1033`), not a paraphrase. */
const AUTHENTICATION_REQUIRED = "Authentication required";

async function bootWith(message: string): Promise<{
  readonly statuses: readonly AgentStatusUpdateEvent[];
  readonly codex: Awaited<ReturnType<typeof startEagerSessionBoot>["codex"]>;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "eager-classify-"));
  dirs.push(root);
  const bus = new ChatEventBus();
  const statuses: AgentStatusUpdateEvent[] = [];
  bus.on("agent.status", (event) => statuses.push(event));
  // projectId present + carrier lanes on is what makes the eager open genuinely ATTEMPT the session;
  // the injected connection then rejects, which is the shape of a real bridge refusal.
  initCarrierRuntime({
    projectId: "proj-1",
    dbPath: path.join(root, "lane.db"),
    repoRoot: root,
    cwd: root,
    openConnection: async () => {
      throw new Error(message);
    },
  } as never);
  // A REAL, MIGRATED database, and it took two goes to get here. A fake db throws "db.prepare is not a
  // function" and a bare openDb throws "no such table: lane_sessions" — both BEFORE the injected
  // connection is ever opened, so the test would have asserted against a harness failure while
  // believing it was asserting against a bridge refusal. eagerOpenAcpAgent catches everything at one
  // point and words it identically, which is what makes that mistake invisible. (The neighbouring
  // eager-boot-probe-honesty test passes `db: undefined as never` and asserts only "unavailable",
  // which the harness failure also produces; noted here, not changed by this slice.)
  const db = openLaneStateDb(path.join(root, "evidence.db"));
  const boot = startEagerSessionBoot({
    db,
    projectId: "proj-1",
    repoRoot: root,
    cwd: root,
    bus,
    signal: NEVER_CANCELLED,
  });
  const codex = await boot.codex;
  await Promise.all([boot.claude, boot.gemini]);
  closeDb(db);
  return { statuses, codex };
}

it("FALSIFIER site 1: a logged-out codex carries needs_auth out of the eager open", async () => {
  const { statuses, codex } = await bootWith(AUTHENTICATION_REQUIRED);

  expect(codex).toMatchObject({ outcome: "unavailable", cause: "needs_auth" });
  // And it reaches the WIRE on the channel that already exists — availability.state ∈ {…, needs_auth,
  // …} is in the protocol schema and the Rust reducer already decodes it. A bare auth:"down" was the
  // old shape and it is the one the chip could not act on.
  const codexStatus = statuses.find((event) => event.agent === "codex" && event.availability);
  expect(codexStatus?.availability).toEqual({ state: "needs_auth" });
  // auth rides along: a signed-out lane is still not reachable, and the two fields answer different
  // questions. Dropping auth here would let a stale ready survive in the reducer's merge.
  expect(codexStatus?.auth).toBe("down");
  expect(codexLoginStateFrom(codex)).toBe("no");
});

it("PIN: an ordinary transport failure is NOT evidence about the account", async () => {
  const { statuses, codex } = await bootWith("connect ECONNREFUSED 127.0.0.1:9999");

  // classifyLaneFailure deliberately returns undefined for a transport error, and this is the assertion
  // that keeps the classification honest: a probe that mapped every failure to needs_auth would pass
  // the site above and tell an operator with a broken socket to sign in again.
  expect(codex).toMatchObject({ outcome: "unavailable" });
  expect(codex).not.toHaveProperty("cause");
  expect(codexLoginStateFrom(codex)).toBe("unknown");
  expect(statuses.find((event) => event.agent === "codex")?.auth).toBe("down");
  expect(statuses.every((event) => event.availability === undefined)).toBe(true);
});

it("PIN: a spent account classifies as exhausted, and words auth as limited rather than down", async () => {
  const { statuses, codex } = await bootWith("You are out of usage credits for this month");

  expect(codex).toMatchObject({ outcome: "unavailable", cause: "exhausted" });
  const codexStatus = statuses.find((event) => event.agent === "codex" && event.availability);
  expect(codexStatus?.availability).toEqual({ state: "exhausted" });
  expect(codexStatus?.auth).toBe("limited");
  // Exhausted is not signed out. Reporting it as a login state would send the operator to re-run an
  // auth command that changes nothing.
  expect(codexLoginStateFrom(codex)).toBe("unknown");
});
