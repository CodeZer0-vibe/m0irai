// digest-runner: the ONE trigger the room close path calls (7), boot catch-up that returns immediately and
// EXCLUDES the attached session (4), the entry resolved as this module's own sibling with its own extension,
// and the child inheriting the parent's runtime flags. The spawn seam's FAILURE paths (A6 missing entry,
// R1, codex #9) live in digest-spawn-failures.test.ts. Real fs + sqlite + real forked children. Under vitest the worker carries no TypeScript
// loader, so the tests that need a real child supply one themselves on top of the runner's own plan — which
// is exactly the inheritance path production relies on. Top-level it().
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Db, closeDb, openMemoryDb } from "../evidence/db.js";
import { awaitDigestEvidence, readDigestRows } from "./digest-evidence.js";
import {
  type DigestRequest,
  type DigestSpawn,
  bootCatchUp,
  digestChildEnv,
  digestEntryPath,
  digestSpawnArgs,
  spawnDetachedDigest,
} from "./digest-runner.js";
import { appendEntry } from "./journal-store.js";

const NOW = "2026-07-04T00:00:00.000Z";
const FAKE = JSON.stringify({
  decisions: [{ topic: "fake", body: "fake decision" }],
  summary: "fake",
});
const REPO = fileURLToPath(new URL("../..", import.meta.url)); // worktree root (src/memory -> repo)
const TSX_LOADER = pathToFileURL(
  join(REPO, "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;
const TSCONFIG = join(REPO, "tsconfig.json");

// F9 (Phase 4): a wait on a real detached child that times out and then DELETES its own workspace destroys
// the only evidence of why. Every budget below is a diagnosis trigger, never a pass condition — the wait
// returns the moment the rows land or a durable failure record appears. Measured cost of these children:
// 1.7 s / 1.8 s / 2.6 s here, and the lead's ten probes on master (idle, cold path, cold loader cache, and
// under a concurrent full unit suite) all landed in 2.0-3.6 s. The budgets stay at their pre-existing 40-45 s
// (~12x the worst observation, which covers the F5 ">=3x load" rule with room to spare); they are NOT raised.
const CHILD_BUDGET_MS = 40_000;
const CATCHUP_BUDGET_MS = 45_000;

let tempRoot: string | undefined;
let spawnedPids: number[] = [];
const savedDebug = process.env.ZER0_DEBUG;
const savedFake = process.env.ZER0_DIGEST_FAKE;

beforeEach(() => {
  process.env.ZER0_DEBUG = "0"; // B2a-1: debug is on-by-default now; this suite's OFF baseline is explicit
  delete process.env.ZER0_DIGEST_FAKE;
  spawnedPids = [];
});

afterEach((ctx) => {
  restore("ZER0_DEBUG", savedDebug);
  restore("ZER0_DIGEST_FAKE", savedFake);
  if (tempRoot !== undefined) {
    if (ctx.task.result?.state === "fail") {
      // Retained on purpose: the DB, .zer0/journal/digest-failures.log and .zer0/leases are the diagnosis.
      process.stderr.write(`RETAINED digest workspace for diagnosis: ${tempRoot}\n`);
    } else {
      // The detached children hold only os.tmpdir() as their CWD (MT3e), but they still hold the DB file open
      // until they exit; Node's native EBUSY retry waits that out instead of masking a failure.
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
    tempRoot = undefined;
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** The runner's own plan, plus the TypeScript loader this vitest worker does not carry. Production needs no
 *  such help: the packaged host has an empty execArgv and forks the compiled sibling directly. */
function loaderSpawn(request: DigestRequest): "requested" {
  const { argv, options } = digestSpawnArgs(request);
  const child = spawn(process.execPath, ["--import", TSX_LOADER, ...argv], {
    ...options,
    env: { ...options.env, TSX_TSCONFIG_PATH: TSCONFIG },
  });
  if (child.pid !== undefined) spawnedPids.push(child.pid); // so a stalled wait can report their liveness
  child.unref();
  return "requested";
}

function freshWorkspace(): { db: Db; repoRoot: string; dbPath: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-drun-"));
  const dbPath = join(tempRoot, "evidence.db");
  const db = openMemoryDb(dbPath);
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p1", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot, dbPath };
}

function freshWorkspaceWithRelativeDb(): { db: Db; repoRoot: string; dbPath: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "zer0-drun-"));
  const dbPath = ".zer0/evidence.db";
  const db = openMemoryDb(join(tempRoot, dbPath));
  db.prepare(
    "INSERT OR IGNORE INTO projects (project_id, canonical_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)",
  ).run("p-rel", tempRoot, `${tempRoot}/.git`, NOW);
  return { db, repoRoot: tempRoot, dbPath };
}

async function writeSession(repoRoot: string, sessionId: `chat-${string}`): Promise<void> {
  const runDir = join(repoRoot, ".council", "runs", sessionId);
  await mkdir(runDir, { recursive: true });
  const messages = [
    {
      id: `${sessionId}-m1`,
      turn: 1,
      role: "agent",
      agent: "claude",
      text: "did work",
      createdAt: NOW,
      status: "completed",
      tokenEstimate: 4,
    },
  ];
  const session = {
    id: sessionId,
    repoRoot,
    runDir,
    createdAt: NOW,
    updatedAt: NOW,
    defaultAgent: "claude",
    lastAgent: "claude",
    summary: { text: "", throughTurn: 0 },
    messages,
  };
  await writeFile(join(runDir, "transcript.json"), JSON.stringify(session), "utf8");
}

/** Waits for terminal evidence and, when none arrives, returns the whole diagnosis as the assertion value. */
async function awaitDecisions(
  repoRoot: string,
  dbPath: string,
  atLeast: number,
  budgetMs: number,
): Promise<string> {
  const result = await awaitDigestEvidence({
    repoRoot,
    dbPath,
    budgetMs,
    expected: (rows) => rows.decisions >= atLeast,
    spawnedPids,
  });
  return result.ok ? "digested" : result.report;
}

it("spawnDetachedDigest fires the injected spawn with the request (the shared close trigger — 7)", () => {
  const seen: DigestRequest[] = [];
  const req: DigestRequest = {
    sessionId: "chat-x",
    repoRoot: "/r",
    dbPath: "/db",
    projectId: "p1",
  };
  spawnDetachedDigest(req, (r) => {
    seen.push(r);
    return "requested";
  });
  expect(seen).toEqual([req]);
});

it("bootCatchUp spawns one digest per on-disk session and returns the count immediately (no model call — 4)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-a");
    await writeSession(repoRoot, "chat-b");
    const spawned: DigestRequest[] = [];
    const count = await bootCatchUp({ repoRoot, dbPath, projectId: "p1" }, (r) => {
      spawned.push(r);
      return "requested";
    });
    expect(count).toBe(2); // returns the count immediately (no model call)
    await new Promise((r) => setTimeout(r, 700)); // let the staggered spawns fire
    expect(spawned.map((r) => r.sessionId).sort()).toEqual(["chat-a", "chat-b"]);
  } finally {
    closeDb(db);
  }
});

it("bootCatchUp EXCLUDES the attached session — it is digested by the close, never raced here (C2)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-a");
    await writeSession(repoRoot, "chat-attached");
    await writeSession(repoRoot, "chat-b");
    const spawned: DigestRequest[] = [];
    const count = await bootCatchUp(
      { repoRoot, dbPath, projectId: "p1", exclude: "chat-attached" },
      (r) => {
        spawned.push(r);
        return "requested";
      },
    );
    await new Promise((r) => setTimeout(r, 700));
    expect({ count, sessions: spawned.map((r) => r.sessionId).sort() }).toEqual({
      count: 2,
      sessions: ["chat-a", "chat-b"],
    });
  } finally {
    closeDb(db);
  }
});

// FL-175 round 4 ADDITIONS to nit (b): this was the second of two tests still titled "REAL" despite
// dispatching through gatedDigestSpawn's in-process fake since the round-3 addendum fix (the reviewer's
// re-check found the scope was three tests, not the one this lane's round 4 first caught). Retitled;
// the dead `process.env.ZER0_DIGEST_FAKE = FAKE;` line below (nothing here spawns a real child, so
// nothing reads it) is removed. `loaderSpawn`, which DOES spawn a real child, is still exercised only by
// the "opens the REPO db when dbPath is relative" test.
//
// For the record (round-4 ADDITIONS item 5): the async-`spawnDetachedDigest` mutation used to
// mutation-test the sibling "spawnDetachedDigest returns immediately..." test does NOT bite THIS test's
// own assertions. `bootCatchUp` (digest-runner.ts:275-277) calls `spawnDetachedDigest(digest, spawnFn)`
// for session 0 and discards its return value — it never checks what comes back, only that a digest was
// scheduled — so a mutated `spawnDetachedDigest` returning a Promise instead of "requested" synchronously
// changes nothing observable here. Only the sibling test, which asserts directly on
// `spawnDetachedDigest`'s own return value (`expect(returned).toBe("requested")`), catches that mutation.
// Documented here so nobody re-discovers this by re-running the mutation against the wrong test.
it("bootCatchUp dispatches all 3 undigested sessions, and their journal writes land only after the gated spawn releases (4)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-a");
    await writeSession(repoRoot, "chat-b");
    await writeSession(repoRoot, "chat-c");
    // FL-175 round-3 addendum: "the open is not gated on the model calls" used to be proved with a
    // fixed 2_000 ms `Date.now() - start` ceiling — the exact wall-clock-proxy class this lane exists to
    // remove. Measured directly: the delta alone ranged 68-1061 ms across 2 isolated runs on this box, a
    // 15x spread, before it was reported RED once under a loaded scope run. Proved structurally instead,
    // reusing the F5 gated-spawn seam: session 0's digest is dispatched SYNCHRONOUSLY inside bootCatchUp
    // (production code, digest-runner.ts:275-277) before the function returns, so a caller that instead
    // waited for that digest's own work before returning would leave `decisions` non-zero here — a
    // same-tick fact, not a race. Sessions 1-2 are staggered by real (deliberate, production) 250 ms
    // timers — untouched, since `awaitDecisions` below already tolerates that real time passing.
    const child = gatedDigestSpawn(db);
    const count = await bootCatchUp({ repoRoot, dbPath, projectId: "p1" }, child.spawn);
    expect(count).toBe(3);
    expect(readDigestRows(dbPath).decisions).toBe(0);
    expect(readDigestRows(dbPath).error).toBeUndefined();
    child.release();
    // Each session's detached digest writes one decision (the IMMEDIATE tx serialises the 3 writers).
    expect(await awaitDecisions(repoRoot, dbPath, 3, CATCHUP_BUDGET_MS)).toBe("digested");
  } finally {
    closeDb(db);
  }
}, 60_000);

/**
 * A spawnFn whose own "child work" (the journal write a real detached digest eventually produces) is
 * gated on a promise the caller resolves explicitly, not on any real process's lifetime — the FL-175
 * round-3 F5 fix (no wall clock of any kind). Writes through the real production writer
 * (journal-store.ts), matching exactly what a real detached child's extraction pass produces.
 */
function gatedDigestSpawn(db: Db): {
  readonly spawn: DigestSpawn;
  readonly release: () => void;
  readonly invoked: () => boolean;
} {
  let invoked = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spawn: DigestSpawn = (request) => {
    invoked = true;
    void gate.then(() => {
      appendEntry(db, {
        projectId: request.projectId,
        category: "decision",
        author: "agent",
        body: JSON.stringify({ topic: "gated", body: "released by the test, not a real child" }),
        createdAt: new Date().toISOString(),
      });
    });
    return "requested";
  };
  return { spawn, release: () => release?.(), invoked: () => invoked };
}

// FL-175 round-4 nit (b): retitled — since the F5 fix this test dispatches through gatedDigestSpawn's
// in-process fake, not a real spawned child (loaderSpawn, which DOES spawn one, is still exercised by
// the "opens the REPO db when dbPath is relative" test below). The old "REAL" title and the
// ZER0_DIGEST_FAKE env line below were both leftovers from before that fix; FAKE is only ever read by a
// real spawned child, and nothing here spawns one, so the line was dead and has been removed.
it("spawnDetachedDigest returns immediately and its journal write lands only after the gated spawn releases (3)", async () => {
  const { db, repoRoot, dbPath } = freshWorkspace();
  try {
    await writeSession(repoRoot, "chat-1");
    // Three assertions, three different wrong implementations, none of them a timing comparison:
    // (1) a caller that BLOCKS waiting for the child before returning would itself await the gate —
    //     which this test only releases AFTER checking the call already returned — so it would deadlock
    //     and the test fails on ITS OWN outer timeout, not a comparison.
    // (2) a caller that never invokes spawnFn at all (a silent no-op) fails `child.invoked()` below.
    // (3) a caller that writes the journal entry itself instead of deferring to the child fails
    //     `decisions === 0`, checked before any release — a same-tick fact, since nothing can run
    //     between two synchronous statements with no `await` between them.
    const child = gatedDigestSpawn(db);
    const returned = spawnDetachedDigest(
      { sessionId: "chat-1", repoRoot, dbPath, projectId: "p1" },
      child.spawn,
    );

    expect(returned).toBe("requested");
    expect(child.invoked()).toBe(true);
    expect(readDigestRows(dbPath).decisions).toBe(0);
    expect(readDigestRows(dbPath).error).toBeUndefined();

    child.release();
    expect(await awaitDecisions(repoRoot, dbPath, 1, CHILD_BUDGET_MS)).toBe("digested");
  } finally {
    closeDb(db);
  }
}, 60_000);

it("REAL detached digest opens the REPO db when dbPath is relative and child cwd is tmpdir", async () => {
  const { db, repoRoot, dbPath } = freshWorkspaceWithRelativeDb();
  try {
    await writeSession(repoRoot, "chat-relative-db");
    process.env.ZER0_DIGEST_FAKE = FAKE;
    spawnDetachedDigest(
      { sessionId: "chat-relative-db", repoRoot, dbPath, projectId: "p-rel" },
      loaderSpawn,
    );
    const landed = await awaitDecisions(repoRoot, dbPath, 1, CHILD_BUDGET_MS);
    const failureLog = existsSync(join(repoRoot, ".zer0", "journal", "digest-failures.log"));
    expect({ landed, failureLog }).toEqual({ landed: "digested", failureLog: false });
  } finally {
    closeDb(db);
  }
}, 60_000);

it("digestChildEnv drops provider API keys but keeps PATH + the ZER0_* the child reads (DECISION-3)", () => {
  process.env.ANTHROPIC_API_KEY = "sk-anthropic";
  process.env.OPENAI_API_KEY = "sk-openai";
  process.env.ZER0_DEBUG = "1";
  process.env.ZER0_DIGEST_FAKE = "{}";
  try {
    const env = digestChildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ZER0_DEBUG).toBe("1");
    expect(env.ZER0_DIGEST_FAKE).toBe("{}");
    expect(env.NODE_NO_WARNINGS).toBe("1");
    expect(typeof env.PATH === "string" || typeof env.Path === "string").toBe(true);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY; // ZER0_DEBUG / ZER0_DIGEST_FAKE restored by afterEach
  }
});

it("FL-172: a hermetic parent hands ZER0_HERMETIC to the digest child — the child must not out-spawn the oracle", () => {
  // The digest child is the one child running OUR code: its inner codex-exec seam reads ZER0_HERMETIC
  // in the CHILD process (digest-extractor.ts), so the parent must hand the flag down or the child's
  // guard sees nothing and a real codex can run under a hermetic harness (ZER0_DIGEST_FAKE unset).
  // The child inherits the parent's hermetic refusal or it inherits nothing.
  const saved = process.env.ZER0_HERMETIC;
  process.env.ZER0_HERMETIC = "1";
  try {
    const env = digestChildEnv();
    expect(env.ZER0_HERMETIC).toBe("1");
  } finally {
    if (saved === undefined) delete process.env.ZER0_HERMETIC;
    else process.env.ZER0_HERMETIC = saved;
  }
});

it("the dev-loader tsconfig variable is PASSED THROUGH, never invented (C4: absent parent -> absent child)", () => {
  const saved = process.env.TSX_TSCONFIG_PATH;
  try {
    delete process.env.TSX_TSCONFIG_PATH;
    expect(digestChildEnv().TSX_TSCONFIG_PATH).toBeUndefined();
    process.env.TSX_TSCONFIG_PATH = TSCONFIG;
    expect(digestChildEnv().TSX_TSCONFIG_PATH).toBe(TSCONFIG);
  } finally {
    restore("TSX_TSCONFIG_PATH", saved);
  }
});

it("the child inherits the parent's loader but NEVER its debugger (codex #10)", () => {
  const saved = process.execArgv;
  try {
    const loader = "file:///D:/repo/node_modules/tsx/dist/esm/index.mjs";
    process.execArgv = [
      "--inspect-brk=0",
      "--import",
      loader,
      "--inspect-port",
      "9229",
      "--conditions",
      "node",
      "--debug-port=5858",
    ];
    const { argv } = digestSpawnArgs({
      sessionId: "chat-x",
      repoRoot: tmpdir(),
      dbPath: join(tmpdir(), "db"),
      projectId: "p1",
    });
    // The loader and every other flag survive; each inspector flag goes, and so does its separated value —
    // leaving "9229" behind would have shifted the entry out of position and run the port as the script.
    expect(argv.slice(0, 4)).toEqual(["--import", loader, "--conditions", "node"]);
    expect(argv[4]).toBe(digestEntryPath());
    expect(argv).not.toContain("9229");
    expect(argv.some((arg) => arg.startsWith("--inspect") || arg.startsWith("--debug"))).toBe(
      false,
    );
  } finally {
    process.execArgv = saved;
  }
});

it("digestSpawnArgs pins the detached contract: sibling entry, inherited flags, CWD outside the project", () => {
  const request: DigestRequest = {
    sessionId: "chat-x",
    repoRoot: join(tmpdir(), "some-project-root"),
    dbPath: join(tmpdir(), "proj-db"),
    projectId: "p1",
  };
  const { argv, options } = digestSpawnArgs(request);
  expect(options.detached).toBe(true);
  expect(options.stdio).toBe("ignore");
  expect(options.windowsHide).toBe(true);
  // The invariant: the child NEVER cd's into a removable project dir (Windows holds CWD → EBUSY on rmdir).
  expect(options.cwd).toBe(tmpdir());
  expect(options.cwd.startsWith(request.repoRoot)).toBe(false);
  expect(options.env).toEqual(digestChildEnv()); // exactly the childEnv allowlist, no full process.env
  // The parent's own runtime flags come first, then the entry, then every path the child needs.
  expect(argv.slice(0, process.execArgv.length)).toEqual(process.execArgv);
  expect(argv[process.execArgv.length]).toBe(digestEntryPath());
  for (const arg of [request.sessionId, request.repoRoot, request.dbPath, request.projectId]) {
    expect(argv).toContain(arg);
  }
});

it("the entry is this module's own sibling carrying its own extension (C4), and it exists on disk", () => {
  const entry = digestEntryPath();
  const self = fileURLToPath(import.meta.url).replace(/\.test\.ts$/u, ".ts");
  expect(entry).toBe(join(REPO, "src", "memory", "digest-entry.ts"));
  expect(entry.slice(0, entry.lastIndexOf("digest-entry"))).toBe(
    self.slice(0, self.lastIndexOf("digest-runner")),
  );
  expect(existsSync(entry)).toBe(true);
  expect(readFileSync(entry, "utf8")).toContain("runDigestEntry");
});
