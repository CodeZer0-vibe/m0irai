/**
 * @file scripts/oracle-standalone.mjs
 * @purpose The standalone oracle (plan v5 §5). Speaks the room's JSON-RPC to the compiled launcher and proves,
 *   in a disposable git project with redirected HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME:
 *   (1) initialize→session/new→session/list returns the created id; (2) the session row carries the canonical
 *   project identity (cwd == realpath(project)); (3) fresh schema set == {14,15,16,20,21}; (6) session/load takes
 *   the continue path; (7) explicit shutdown and stdin EOF both exit 0 inside the deadline; (8) wrong cwd →
 *   the exact invalid-params error; (9) nothing outside the temp root changed (watch-list of real config
 *   files); (H) under ZER0_HERMETIC=1 a submitted turn is refused deterministically at the spawn seam
 *   (lane.failed carrying the hermetic message) for EXACTLY all three agents, each naming its own spawn
 *   seam, with the boot readiness record observed settled FIRST so the result cannot depend on probe
 *   latency; (BOOT) after that same session's full lifetime the scrubbed HOME gained no claude first-run
 *   artifact (.claude.json / .claude/) — the boot readiness probe spawned no process;
 *   (4) closing the room schedules the detached digest, whose facts + watermark reach the DB, and a second
 *   attach-and-close of the same session changes NEITHER count (replay stable); (5) an extraction that
 *   yields nothing advances only the watermark; (7b) the explicit shutdown and stdin EOF each close the room
 *   exactly once, read off the durable close record the lifecycle appends; (R) the proof set this run
 *   produced is EXACTLY the set docs/provenance/oracle.json registers for this configuration.
 *   The digest proofs assert EQUALITY, never a threshold (codex #14/#15/#16): the watermark SET equals the
 *   completed message ids of the session's own transcript, the journal holds exactly the canned extraction's
 *   rows and no others, and the close record holds exactly one line per close per process.
 *   `--falsify schema` runs the same protocol against a staged copy of dist with src/evidence/schema.sql
 *   removed and REQUIRES session/new to fail; `--falsify digest-entry` removes the compiled digest entry and
 *   REQUIRES the durable classified failure with no digest fact — a passing falsifier is a red result.
 *   The digest proofs are hermetic-only: release mode submits no turn, so it has nothing to digest.
 *   Modes: `hermetic` (default; compiled dist via a temp launcher, minimal env, hermetic+fake flags) and
 *   `release` (`--launcher <staged zer0-v2-host.mjs>`, real env, no hermetic flag, no submit).
 *   Refuses to start at all when `dist` is older than the `src` it was built from — see
 *   {@link assertDistMatchesSrc}, because every proof here is about `dist` and none of them is about `src`.
 * @exports assertDistMatchesSrc, runOracle, hermeticEnv, releaseEnv
 * @depends node:child_process, node:crypto, node:fs, node:module, node:os, node:path, node:url
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// M4: fresh memory opens now land v21 (journal_entry_files projection) — produced set gained 21.
const EXPECTED_SCHEMA = [14, 15, 16, 20, 21];
const WRONG_CWD_MESSAGE = "cwd must match the host project root";
const HERMETIC_MARK = "hermetic mode (ZER0_HERMETIC=1)";
const AGENTS = ["claude", "codex", "gemini"];
// The spawn seam each agent's hermetic refusal must NAME (src/shared/hermetic.ts puts the site in the
// message). A refusal carrying the wrong site — or a generic error — proves nothing about its seam.
const REFUSAL_SEAM = {
  claude: "acp-turn-session.spawnServer",
  codex: "acp-turn-session.spawnServer",
  gemini: "agy-pty-spawn.agyExePath",
};
const FALSIFIERS = ["schema", "digest-entry"];
// ZER0_DIGEST_FAKE is what makes proofs 4/5 hermetic: the child runs the real pass (transcript read,
// extraction parse, atomic facts + watermark write) against canned extractor output instead of a model call.
// A distinct topic per proof makes each digest countable on its own; the empty one must produce no fact.
const DIGEST_FAKE = JSON.stringify({
  decisions: [{ topic: "oracle-close", body: "the room close scheduled the detached digest" }],
  summary: "the oracle session left off after one submitted turn",
});
const DIGEST_FAKE_EMPTY = JSON.stringify({ decisions: [], summary: "" });
// The digest child is detached and starts a fresh Node, so the DB effect lands after the host has exited.
const DIGEST_WAIT_MS = 60_000;

function parseArgs(argv) {
  const out = {
    mode: "hermetic",
    launcher: undefined,
    falsify: undefined,
    deadlineMs: 120_000,
    keep: false,
  };
  const valued = {
    "--mode": (v) => {
      out.mode = v;
    },
    "--launcher": (v) => {
      out.launcher = v;
    },
    "--falsify": (v) => {
      out.falsify = v;
    },
    "--deadline": (v) => {
      out.deadlineMs = Number(v);
    },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") {
      out.keep = true;
      continue;
    }
    const setter = valued[a];
    if (setter === undefined) throw new Error(`unknown argument ${a}`);
    setter(argv[++i]);
  }
  validateArgs(out);
  return out;
}

function validateArgs(out) {
  if (out.mode !== "hermetic" && out.mode !== "release")
    throw new Error("--mode must be hermetic or release");
  if (out.mode === "release" && !out.launcher)
    throw new Error("release mode requires --launcher <staged zer0-v2-host.mjs>");
}

/** Real config files the room touches when NOT redirected. Their state must be identical before/after. */
function watchList() {
  const home = homedir();
  return [
    join(home, ".gemini", "antigravity-cli", "settings.json"),
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "config.toml"),
    join(tmpdir(), "zer0-statusline", "agy.json"),
  ];
}
function snapshot(paths) {
  return paths.map((p) =>
    existsSync(p)
      ? `${p}=${createHash("sha256").update(readFileSync(p)).digest("hex")}`
      : `${p}=ABSENT`,
  );
}

// Windows environment variables are case-insensitive at the OS level: a real spawned child reads
// process.env[K] the same way regardless of which spelling of K the parent's env object carried
// (verified live: src/shared/child-env.ts's PATH/Path finding, and FL-173 below). copyKeysFolded
// copies each of `keys` from `process.env` into `target` at most once per case-folded name, so a
// `keys` list that (defensively, or by accident) spells one OS variable two ways — PATH/Path,
// SYSTEMDRIVE/SystemDrive, PROGRAMFILES/ProgramFiles — can never write the same value into a plain JS
// object under two distinct property keys.
function copyKeysFolded(target, keys) {
  const seenFolded = new Set();
  for (const key of keys) {
    const folded = key.toLowerCase();
    if (seenFolded.has(folded)) continue;
    const value = process.env[key];
    if (value !== undefined) {
      target[key] = value;
      seenFolded.add(folded);
    }
  }
}

export function hermeticEnv(root) {
  const dirs = {
    home: join(root, "home"),
    appdata: join(root, "appdata"),
    localappdata: join(root, "localappdata"),
    tmp: join(root, "tmp"),
    codex: join(root, "codexhome"),
    statusline: join(root, "statusline"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // A stub file at the ONE path the gemini readiness probe stats (agent-readiness-probe.agyExists ==
  // existsSync(LOCALAPPDATA/agy/bin/agy.exe)). Without it the probe reads installed:"no", the room
  // records gemini unusable, and @all drops gemini BY DESIGN (room-readiness-service.resolveTargets,
  // wave spec §14 Q8) — so H.hermetic-refusal could never observe gemini's refusal at its own seam.
  // The stub is never executed: under ZER0_HERMETIC=1 agyExePath() refuses BEFORE any spawn
  // (agy-pty-spawn.ts), and no other code path reaches for this file.
  mkdirSync(join(dirs.localappdata, "agy", "bin"), { recursive: true });
  writeFileSync(join(dirs.localappdata, "agy", "bin", "agy.exe"), "");
  const keep = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "SYSTEMDRIVE",
    "PROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "OS",
  ];
  const env = {};
  copyKeysFolded(env, keep);
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.localappdata,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    CODEX_HOME: dirs.codex,
    ZER0_STATUSLINE_DIR: dirs.statusline,
    ZER0_HERMETIC: "1",
    ZER0_MEMORY: "1",
    ZER0_DIGEST_FAKE: DIGEST_FAKE,
  });
  return env;
}

// FL-173: object-rest destructuring (`{ ZER0_HERMETIC: _x, ...env } = process.env`) excludes only the
// LITERAL key spelled "ZER0_HERMETIC". A parent whose own env carries a differently-cased spelling
// (e.g. `zer0_hermetic`, set by a lowercase-exporting shell) survives untouched into `env` — and because
// process.env is case-insensitive on Windows, a real child spawned with that `env` still reads
// process.env.ZER0_HERMETIC === "1" (reproduced live 2026-09-02: setting process.env.zer0_hermetic on
// the parent, object-rest-excluding "ZER0_HERMETIC", then spawning a real child with the rest object —
// the child's own process.env.ZER0_HERMETIC read back "1"). Release mode exists to prove the REAL
// provider paths; a release proof that silently ran hermetic would pass while proving nothing. Filtering
// every key case-insensitively against both flag names closes every spelling, not just the one this
// process happens to have used.
const RELEASE_ENV_DROP_FOLDED = new Set(["zer0_hermetic", "zer0_digest_fake"]);
export function releaseEnv() {
  // Real env minus the two test-only flags — release/live proof must run the real provider paths.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (RELEASE_ENV_DROP_FOLDED.has(key.toLowerCase())) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function gitInitProject(root) {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: project,
    encoding: "utf8",
  });
  const real = realpathSync(project);
  if (resolve(top.stdout.trim()).toLowerCase() !== resolve(real).toLowerCase())
    throw new Error(`temp project is not its own toplevel: ${top.stdout.trim()} vs ${real}`);
  return real;
}

/** Every compiled `.js` under `dist/src`, which mirrors `src/` one-for-one. */
function* compiledOutputs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* compiledOutputs(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

/**
 * REFUSES TO PROVE A BUILD THAT IS NOT THIS TREE. Every proof here speaks about `dist`, never about
 * `src`, so a stale `dist` makes the whole report a confident statement about code that has been
 * edited since — and the report reads as an accusation against production. That is not hypothetical: on
 * 2026-08-25 `BOOT.hermetic-probe-no-spawn` failed seven runs in a row against `agent-readiness-probe`'s
 * `assertNotHermetic`, which was already in `src` and merely absent from the `dist` those runs proved.
 * Removing that one line from the compiled probe reproduces it exactly — `stray=[.claude.json,.claude]`
 * with `claude:{state:"needs_login"}` — while the same run's lanes still refuse at their own seams,
 * which is the tell no amount of reading `src` could have given.
 *
 * The comparison is per FILE, not against one build timestamp: each output is checked against its own
 * source. A source with no output is IGNORED — `*.test.ts` and gate-reachability's declared test-support
 * files are outside the production program (tsconfig.production.json emits only the closure of
 * `zer0-v2-host.ts` + `digest-entry.ts`), and refusing to run after an ordinary test edit would make
 * this check the thing people route around. An absent `dist` is ignored too: {@link tempLauncher} owns
 * that error and names the missing host, which is the more useful message of the two.
 */
export function assertDistMatchesSrc(repoRoot) {
  const distSrc = join(repoRoot, "dist", "src");
  if (!existsSync(distSrc)) return;
  const stale = [];
  for (const output of compiledOutputs(distSrc)) {
    const source = join(repoRoot, "src", `${relative(distSrc, output).slice(0, -".js".length)}.ts`);
    if (!existsSync(source)) continue;
    if (statSync(source).mtimeMs > statSync(output).mtimeMs) stale.push(relative(repoRoot, source));
  }
  if (stale.length === 0) return;
  const named = stale.slice(0, 10).join(", ");
  const rest = stale.length > 10 ? ` (+${String(stale.length - 10)} more)` : "";
  throw new Error(
    `dist is STALE: ${String(stale.length)} source file(s) were edited after the build that this run would prove, so every proof below would describe code that is no longer in this tree. Run \`npm run build\`, then re-run the oracle. Edited since the build: ${named}${rest}`,
  );
}

/** A tiny launcher beside the temp root that imports the compiled host (never the source checkout). */
function tempLauncher(root, distRoot) {
  const host = join(distRoot, "src", "room", "zer0-v2-host.js");
  if (!existsSync(host))
    throw new Error(`compiled host missing: ${host} (run npm run build first)`);
  const file = join(root, "launcher.mjs");
  writeFileSync(
    file,
    `import { runZer0V2Host } from ${JSON.stringify(pathToFileURL(host).href)};\nrunZer0V2Host();\n`,
  );
  return file;
}

class HostClient {
  constructor(launcher, cwd, env) {
    this.child = spawn(process.execPath, [launcher], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.events = [];
    this.stderr = "";
    this.buf = "";
    this.nextId = 1;
    this.exit = new Promise((res) =>
      this.child.on("exit", (code, signal) => res({ code, signal })),
    );
    this.child.stderr.on("data", (d) => {
      this.stderr += d;
    });
    this.child.stdout.on("data", (d) => this.onData(String(d)));
  }
  onData(chunk) {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) return;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }
  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      this.events.push({ nonjson: line.slice(0, 200) });
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      this.pending.get(m.id)(m);
      this.pending.delete(m.id);
    } else if (m.method === "zer0/room/event") this.events.push(m.params);
    else this.events.push(m);
  }
  request(method, params, ms) {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout waiting for ${method}`));
      }, ms);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        res(m);
      });
      void this.exit.then((e) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          clearTimeout(t);
          rej(
            new Error(
              `host exited (${JSON.stringify(e)}) before answering ${method}; stderr: ${this.stderr.slice(-400)}`,
            ),
          );
        }
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  endStdin() {
    this.child.stdin.end();
  }
  async waitExit(ms) {
    const r = await Promise.race([
      this.exit,
      new Promise((res) => setTimeout(() => res({ timeout: true }), ms)),
    ]);
    if (r.timeout) {
      this.child.kill();
      return { timeout: true };
    }
    return r;
  }
  waitForEvents(predicate, count, ms) {
    return new Promise((res) => {
      const started = Date.now();
      const tick = () => {
        const hits = this.events.filter(predicate);
        if (hits.length >= count) return res(hits);
        if (Date.now() - started > ms) return res(hits);
        setTimeout(tick, 100);
      };
      tick();
    });
  }
}

/**
 * Waits for the host's boot readiness record to LAND, observed over the same RPC the Rust terminal
 * reads (`zer0/room/agents`; strict decoder rust/crates/codegen/xai-grok-pager/src/room_agents.rs).
 * The record is seeded all-`unknown` (UNKNOWN_READINESS) and replaced whole once probeRoomReadiness's
 * Promise.all resolves (room-readiness-service.ts), so ANY decided state proves the whole post-probe
 * record is what a submit would now read. This is what makes H.hermetic-refusal independent of probe
 * latency: whether claude's leg answers in one microtask (guarded) or ~0.8 s (a real child), the proof
 * submits only AFTER the record that decides @all fan-out has landed.
 */
async function waitForReadinessSettled(c, sessionId, ms) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      // Every zer0/room/* request carries the attached session id (zer0-v2-host.routeRoomRequest
      // requires it before dispatch), agents included.
      last = await c.request("zer0/room/agents", { sessionId }, Math.min(ms, 15_000));
      const agents = last.result?.agents;
      if (
        agents !== null &&
        typeof agents === "object" &&
        Object.values(agents).some((a) => a?.state !== "unknown")
      )
        return { settled: true, record: agents };
    } catch {
      // A timed request or a scheduler busy window — keep polling until the budget is spent.
    }
    if (Date.now() - started > ms) return { settled: false, record: last?.result?.agents };
    await new Promise((res) => setTimeout(res, 100));
  }
}

function initParams() {
  return {
    protocolVersion: 1,
    clientInfo: { name: "m0irai-oracle", version: "0" },
    clientCapabilities: {},
  };
}

function readDb(repoRoot, dbPath) {
  const req = createRequire(join(repoRoot, "package.json"));
  const Database = req("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const versions = db
      .prepare("select version from _schema_version order by version")
      .all()
      .map((r) => Number(r.version));
    const sessions = db.prepare("select count(*) as n from chat_sessions").get().n;
    const tables = db.prepare("select count(*) as n from sqlite_master where type='table'").get().n;
    return { versions, sessions, tables };
  } finally {
    db.close();
  }
}

/** The digest side of the DB: what the detached child wrote, keyed so each proof can count its own rows.
 *  `marks` carries the watermark as what it IS — a SET of message ids per session (schema v15:
 *  digest_watermark(project_id, session_id, message_id, created_at)). A count alone cannot tell a partly
 *  advanced multi-message transcript from a complete one (codex #14), so every digest proof asserts the ids. */
function readDigest(repoRoot, dbPath) {
  const req = createRequire(join(repoRoot, "package.json"));
  const Database = req("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const facts = db
      .prepare("select category, topic_key as topic, body from journal_entries order by seq")
      .all();
    const marks = db
      .prepare(
        "select session_id as session, message_id as message from digest_watermark order by session_id, message_id",
      )
      .all();
    const watermarks = db
      .prepare(
        "select session_id as session, count(*) as n from digest_watermark group by session_id",
      )
      .all();
    return {
      facts,
      decisions: facts.filter((f) => f.category === "decision"),
      summaries: facts.filter((f) => f.category === "summary"),
      scratch: facts.filter((f) => f.category === "scratch"),
      marks,
      watermarks,
      watermarkFor: (session) => watermarks.find((w) => w.session === session)?.n ?? 0,
      watermarkIds: (session) =>
        marks
          .filter((m) => m.session === session)
          .map((m) => m.message)
          .sort(),
    };
  } finally {
    db.close();
  }
}

/** The digest side of the DB, or undefined while it cannot be opened yet (a proof that samples mid-run). */
function readDigestSafe(ctx) {
  try {
    return readDigest(ctx.repoRoot, join(ctx.project, ".zer0", "evidence.db"));
  } catch {
    return undefined;
  }
}

/**
 * The message ids a close MUST digest, read from the transcript the digest child itself reads
 * (`.council/runs/<sessionId>/transcript.json`, the authority — src/chat/session-store.ts). The pass digests
 * exactly the COMPLETED messages not already in the watermark set (src/memory/digest.ts:62), so this list is
 * the exact watermark set a correct close leaves behind — not a lower bound.
 */
function completedMessageIds(project, sessionId) {
  const file = join(project, ".council", "runs", sessionId, "transcript.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return (parsed.messages ?? [])
    .filter((m) => m.status === "completed")
    .map((m) => m.id)
    .sort();
}

/** The facts a canned extraction must produce, derived from the fake itself so the two can never drift. */
function expectedFacts(fake) {
  const extraction = JSON.parse(fake);
  const decisions = extraction.decisions.map((d) => ({ topic: d.topic, body: d.body }));
  const summaries = extraction.summary.trim().length > 0 ? [extraction.summary] : [];
  return { decisions, summaries, total: decisions.length + summaries.length };
}

/** One close-record line split into its fields. `drain` is last and may contain spaces, so it takes the tail. */
function closeFields(line) {
  const pick = (key) => new RegExp(`${key}=(\\S+)`).exec(line)?.[1];
  const drainAt = line.indexOf("drain=");
  return {
    session: pick("session"),
    reason: pick("reason"),
    digest: pick("digest"),
    drain: drainAt < 0 ? undefined : line.slice(drainAt + "drain=".length),
    line,
  };
}

/** The durable close record the attached-session lifecycle appends: exactly one line per close. */
function closeRecord(project) {
  const file = join(project, ".zer0", "journal", "room-close.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** The single-flight leases the digest children take, with the liveness of whoever holds each one. F9: a
 *  stalled wait must be able to say whether a child is still running, dead mid-pass, or never started. */
function leaseEvidence(project) {
  const dir = join(project, ".zer0", "leases");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((file) => {
    let pid;
    try {
      pid = JSON.parse(readFileSync(join(dir, file), "utf8")).pid;
    } catch {
      pid = undefined;
    }
    let alive;
    if (typeof pid === "number") {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = error?.code === "EPERM";
      }
    }
    return { file, pid, alive };
  });
}

/** Everything a digest proof needs to name its own cause when the child never delivered (F9). */
function digestDiagnosis(ctx, timeline) {
  const failures = join(ctx.project, ".zer0", "journal", "digest-failures.log");
  return [
    `timeline(ms)=${timeline.length === 0 ? "no change observed" : timeline.join(" | ")}`,
    `leases=${JSON.stringify(leaseEvidence(ctx.project))}`,
    `digest-failures.log=${existsSync(failures) ? JSON.stringify(readFileSync(failures, "utf8").slice(-300)) : "absent"}`,
    `close=${JSON.stringify(closeRecord(ctx.project))}`,
    `TEMP ROOT RETAINED: ${ctx.root}`,
  ].join("; ");
}

/**
 * Waits for terminal evidence from a real detached digest child: the rows the caller wants, or a durable
 * failure record, which ends the wait immediately rather than burning the budget on a digest that already
 * gave up. Records WHEN each change landed so a stall can be told from a slow start (F9). The budget is a
 * diagnosis trigger, not a pass condition: measured cost of one child here is 0.7-1.0 s, and the lead's ten
 * probes on master span 2.0-3.6 s, so DIGEST_WAIT_MS stays where it is.
 */
async function waitForDigest(ctx, predicate) {
  const dbPath = join(ctx.project, ".zer0", "evidence.db");
  const started = Date.now();
  const timeline = [];
  let previous = "";
  for (;;) {
    let snapshot;
    try {
      snapshot = readDigest(ctx.repoRoot, dbPath);
    } catch {
      snapshot = undefined;
    }
    const shape =
      snapshot === undefined
        ? "db unreadable"
        : `facts=${String(snapshot.facts.length)} decisions=${String(snapshot.decisions.length)} scratch=${String(snapshot.scratch.length)} watermarks=${JSON.stringify(snapshot.watermarks)}`;
    if (shape !== previous) {
      timeline.push(`+${String(Date.now() - started)} ${shape}`);
      previous = shape;
    }
    if (snapshot !== undefined && predicate(snapshot)) return { snapshot, timeline };
    if (snapshot !== undefined && snapshot.scratch.length > 0) return { snapshot, timeline };
    if (Date.now() - started > DIGEST_WAIT_MS) return { snapshot, timeline };
    await new Promise((res) => setTimeout(res, 250));
  }
}

/**
 * Proof 4: closing the room scheduled the digest, and its facts + watermark reached the DB — EXACTLY.
 * Every clause is an equality, not a threshold (codex #14): the watermark SET equals the completed message
 * ids of this session's transcript (a partly advanced watermark is now red), the journal holds exactly the
 * canned extraction's decisions and summary and NOTHING else (a bogus extra row is now red), and no
 * catastrophe names this session. `watermark > 0 && decisions.length === 1` could not see any of those.
 */
async function proveDigestOnClose(ctx, results, sessionId) {
  const { snapshot: seen, timeline } = await waitForDigest(ctx, (db) => db.decisions.length > 0);
  const want = expectedFacts(DIGEST_FAKE);
  const expectedIds = completedMessageIds(ctx.project, sessionId);
  const marks = seen?.watermarkIds(sessionId) ?? [];
  const decisions = (seen?.decisions ?? []).map((d) => ({ topic: d.topic, body: d.body }));
  const summaries = (seen?.summaries ?? []).map((s) => s.body);
  const scratch = (seen?.scratch ?? []).filter((row) => row.body.includes(`session=${sessionId}`));
  const ok =
    expectedIds.length > 0 && // a transcript with nothing completed would make the set equality vacuous
    JSON.stringify(marks) === JSON.stringify(expectedIds) &&
    JSON.stringify(decisions) === JSON.stringify(want.decisions) &&
    JSON.stringify(summaries) === JSON.stringify(want.summaries) &&
    (seen?.facts.length ?? -1) === want.total &&
    scratch.length === 0;
  results.push({
    proof: "4.digest-close-fact-and-watermark",
    ok,
    detail: `watermark(${sessionId})=${JSON.stringify(marks)} expected=${JSON.stringify(expectedIds)}; decisions=${JSON.stringify(decisions)} expected=${JSON.stringify(want.decisions)}; summaries=${JSON.stringify(summaries)} expected=${JSON.stringify(want.summaries)}; facts=${String(seen?.facts.length ?? -1)}/${String(want.total)}; scratch(this session)=${JSON.stringify(scratch.map((s) => s.body.slice(0, 140)))}${ok ? "" : ` || ${digestDiagnosis(ctx, timeline)}`}`,
  });
  // 7b, exact cardinality (codex #15): ONE line in the whole record after ONE close of ONE process, for THIS
  // session, with exactly that one reason. Counting "how many lines say shutdown" let an extra close record
  // ride along invisibly.
  const lines = closeRecord(ctx.project).map(closeFields);
  const reasons = lines.map((l) => l.reason).sort();
  results.push({
    proof: "7b.explicit-shutdown-closes-once",
    ok:
      lines.length === 1 &&
      JSON.stringify(reasons) === JSON.stringify(["zer0/room/shutdown"]) &&
      lines.every((l) => l.session === sessionId && l.digest === "requested"),
    detail: `lines=${String(lines.length)} reasons=${JSON.stringify(reasons)} sessions=${JSON.stringify([...new Set(lines.map((l) => l.session))])} digest=${JSON.stringify(lines.map((l) => l.digest))}`,
  });
  return seen;
}

/**
 * Proof 4b + 7b. Replay is proven by RE-RUNNING the compiled entry synchronously against the same DB rather
 * than by waiting out a detached child: a second pass either changes the counts or it does not, with no
 * timing guess to get wrong (and no idle-machine assumption — F5). It also proves the compiled entry runs
 * standalone under plain Node, byte-silent, with no loader and no flags: the packaged shape exactly.
 * 7b reads the durable close record, which the host writes before it exits — one line per close.
 */
function proveReplayStable(ctx, results, sessionId, before) {
  const dbPath = join(ctx.project, ".zer0", "evidence.db");
  const projectId = readProjectId(ctx.repoRoot, dbPath);
  const entry = join(ctx.distRoot, "src", "memory", "digest-entry.js");
  const replay = spawnSync(process.execPath, [entry, sessionId, ctx.project, dbPath, projectId], {
    cwd: tmpdir(),
    env: ctx.env,
    encoding: "utf8",
  });
  const after = readDigest(ctx.repoRoot, dbPath);
  // The comparison is over the watermark ROWS (session + message id), not the per-session counts: a replay
  // that dropped one id and added another would leave every count identical (codex #14).
  const same =
    JSON.stringify(before?.facts ?? null) === JSON.stringify(after.facts) &&
    JSON.stringify(before?.marks ?? null) === JSON.stringify(after.marks);
  results.push({
    proof: "4b.replay-changes-nothing",
    ok: same && replay.status === 0 && replay.stdout === "" && replay.stderr === "",
    detail: `entry exit=${String(replay.status)} stdout=${JSON.stringify(replay.stdout)} stderr=${JSON.stringify(replay.stderr.slice(-200))}; facts ${String(before?.facts.length ?? -1)} -> ${String(after.facts.length)}; watermark rows ${JSON.stringify(before?.marks ?? [])} -> ${JSON.stringify(after.marks)}`,
  });
  // 7b, exact cardinality (codex #15): after the SECOND process closed the same session by stdin EOF the
  // whole record is exactly two lines — one per process — and their reasons are exactly that multiset. An
  // extra "host-shutdown" line from a defective lifecycle now fails here instead of passing unseen.
  const lines = closeRecord(ctx.project).map(closeFields);
  const forSession = lines.filter((l) => l.session === sessionId);
  const reasons = forSession.map((l) => l.reason).sort();
  results.push({
    proof: "7b.stdin-eof-closes-once",
    ok:
      lines.length === 2 &&
      forSession.length === 2 &&
      JSON.stringify(reasons) === JSON.stringify(["stdin-eof", "zer0/room/shutdown"]) &&
      forSession.every((l) => l.digest === "requested"),
    detail: `lines=${String(lines.length)} for-session=${String(forSession.length)} reasons=${JSON.stringify(reasons)} digest=${JSON.stringify(forSession.map((l) => l.digest))} other-sessions=${JSON.stringify(lines.filter((l) => l.session !== sessionId).map((l) => l.line))}`,
  });
}

/** The canonical project identity the room resolved — the digest entry is keyed on it, never on a re-resolve. */
function readProjectId(repoRoot, dbPath) {
  const req = createRequire(join(repoRoot, "package.json"));
  const Database = req("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return String(db.prepare("select project_id from projects limit 1").get()?.project_id ?? "");
  } finally {
    db.close();
  }
}

/** Proof 5: an extraction that yields nothing advances ONLY the watermark — no fact enters the journal. */
async function proveEmptyExtraction(ctx, results) {
  const before = readDigest(ctx.repoRoot, join(ctx.project, ".zer0", "evidence.db"));
  const env = { ...ctx.env, ZER0_DIGEST_FAKE: DIGEST_FAKE_EMPTY };
  const c = new HostClient(ctx.launcher, ctx.project, env);
  await c.request("initialize", initParams(), ctx.stepMs);
  const created = await c.request("session/new", { cwd: ctx.project, mcpServers: [] }, ctx.stepMs);
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string") {
    c.endStdin();
    await c.waitExit(ctx.stepMs);
    results.push({
      proof: "5.empty-extraction-watermark-only",
      ok: false,
      detail: JSON.stringify(created.error),
    });
    return;
  }
  await c.request("zer0/room/submit", { sessionId, text: "@all second session" }, ctx.stepMs);
  await c.waitForEvents((e) => e?.type === "lane.failed", AGENTS.length, ctx.stepMs);
  await c.request("zer0/room/shutdown", { sessionId }, ctx.stepMs);
  await c.waitExit(ctx.stepMs);
  const { snapshot: after, timeline } = await waitForDigest(
    ctx,
    (db) => db.watermarkFor(sessionId) > 0,
  );
  // Exact on both sides (codex #14): the watermark set equals this transcript's completed ids — every
  // message was accounted for, not just one — and the facts delta is exactly zero, row for row.
  const expectedIds = completedMessageIds(ctx.project, sessionId);
  const marks = after?.watermarkIds(sessionId) ?? [];
  const scratch = (after?.scratch ?? []).filter((row) => row.body.includes(`session=${sessionId}`));
  const ok =
    expectedIds.length > 0 &&
    JSON.stringify(marks) === JSON.stringify(expectedIds) &&
    (after?.facts.length ?? -1) === before.facts.length &&
    JSON.stringify(after?.facts ?? null) === JSON.stringify(before.facts) &&
    scratch.length === 0;
  results.push({
    proof: "5.empty-extraction-watermark-only",
    ok,
    detail: `watermark(${sessionId})=${JSON.stringify(marks)} expected=${JSON.stringify(expectedIds)}; facts delta ${String((after?.facts.length ?? -1) - before.facts.length)} (${String(before.facts.length)} -> ${String(after?.facts.length ?? -1)}); scratch(this session)=${JSON.stringify(scratch.map((s) => s.body.slice(0, 140)))}${ok ? "" : ` || ${digestDiagnosis(ctx, timeline)}`}`,
  });
}

async function proveSessionA(ctx, results) {
  const c = new HostClient(ctx.launcher, ctx.project, ctx.env);
  // The settled readiness record (hermetic only) — carried out for BOOT.hermetic-probe-no-spawn.
  let readiness;
  const init = await c.request("initialize", initParams(), ctx.stepMs);
  results.push({
    proof: "1.initialize",
    ok: init.result?.protocolVersion === 1,
    detail: init.result ? "protocolVersion 1" : JSON.stringify(init.error),
  });
  const created = await c.request("session/new", { cwd: ctx.project, mcpServers: [] }, ctx.stepMs);
  const sessionId = created.result?.sessionId;
  results.push({
    proof: "1.session/new",
    ok: typeof sessionId === "string" && sessionId.startsWith("chat-"),
    detail: sessionId ?? JSON.stringify(created.error),
  });
  if (typeof sessionId !== "string") {
    c.endStdin();
    await c.waitExit(ctx.stepMs);
    return undefined;
  }
  const list = await c.request("session/list", {}, ctx.stepMs);
  const rows = list.result?.sessions ?? [];
  const row = rows.find((s) => s.sessionId === sessionId);
  results.push({
    proof: "1.session/list-contains-created",
    ok: row !== undefined,
    detail: `${String(rows.length)} session(s)`,
  });
  results.push({
    proof: "2.canonical-project-identity",
    ok:
      row !== undefined &&
      resolve(String(row.cwd)).toLowerCase() === resolve(ctx.project).toLowerCase(),
    detail: row ? String(row.cwd) : "no row",
  });
  const dbPath = join(ctx.project, ".zer0", "evidence.db");
  try {
    const db = readDb(ctx.repoRoot, dbPath);
    results.push({
      proof: "3.schema-set",
      ok: JSON.stringify(db.versions) === JSON.stringify(EXPECTED_SCHEMA),
      detail: `{${db.versions.join(",")}} sessions=${String(db.sessions)} tables=${String(db.tables)}`,
    });
    results.push({
      proof: "2.chat_sessions-row",
      ok: db.sessions === 1,
      detail: `chat_sessions=${String(db.sessions)}`,
    });
  } catch (error) {
    results.push({ proof: "3.schema-set", ok: false, detail: String(error) });
  }
  if (ctx.mode === "hermetic") {
    // The precondition, OBSERVED not assumed: the boot readiness record has landed before the submit,
    // so @all fan-out is decided by rule (with the stub agy.exe above, gemini dispatches) and not by
    // whether the submit happened to beat the probe — the latency race this proof used to ride on.
    readiness = await waitForReadinessSettled(c, sessionId, ctx.stepMs);
    const submitted = await c.request(
      "zer0/room/submit",
      { sessionId, text: "@all hello from the oracle" },
      ctx.stepMs,
    );
    const failed = await c.waitForEvents(
      (e) => e?.type === "lane.failed" && String(e?.payload?.error ?? "").includes(HERMETIC_MARK),
      AGENTS.length,
      ctx.stepMs,
    );
    const agents = [...new Set(failed.map((e) => e.payload.agent))].sort();
    // EXACTLY the three agents — a missing one (the old failure) and an unexpected fourth are both red.
    const refusedExactlyAll = JSON.stringify(agents) === JSON.stringify([...AGENTS].sort());
    const seamsNamed = AGENTS.every((a) =>
      failed.some(
        (e) => e.payload?.agent === a && String(e.payload?.error ?? "").includes(REFUSAL_SEAM[a]),
      ),
    );
    const terminal = c.events
      .filter(
        (e) => typeof e?.type === "string" && /^lane.(failed|completed|cancelled)$/.test(e.type),
      )
      .map(
        (e) =>
          `${String(e.payload?.agent)}:${e.type}:${String(e.payload?.error ?? "").slice(0, 120)}`,
      );
    results.push({
      proof: "H.hermetic-refusal",
      ok: submitted.result !== undefined && readiness.settled && refusedExactlyAll && seamsNamed,
      detail: submitted.result
        ? `readiness=${JSON.stringify(readiness.record)} settled=${String(readiness.settled)}; lane.failed(hermetic) for [${agents.join(",")}]; seamsNamed=${String(seamsNamed)}; terminal=${JSON.stringify(terminal)}; eventTypes=${JSON.stringify([...new Set(c.events.map((e) => e?.type))])}`
        : `readiness=${JSON.stringify(readiness.record)}; ${JSON.stringify(submitted.error)}`,
    });
  }
  const shut = await c.request("zer0/room/shutdown", { sessionId }, ctx.stepMs);
  const exit = await c.waitExit(ctx.stepMs);
  results.push({
    proof: "7.explicit-shutdown-exit0",
    ok: shut.result?.acknowledged === true && exit.code === 0,
    detail: `ack=${String(shut.result?.acknowledged)} exit=${JSON.stringify(exit)}`,
  });
  return { sessionId, readiness };
}

/**
 * BOOT.hermetic-probe-no-spawn — the boot-path sibling of H.hermetic-refusal. A real `claude auth status`
 * child writes a first-run `.claude.json` plus a `.claude/` directory into its HOME; under
 * ZER0_HERMETIC=1 the boot readiness probe must spawn NOTHING, so after session A's full lifetime
 * (boot → readiness observed settling → turn → shutdown) the oracle's scrubbed HOME must hold neither
 * artifact. This is the detector f-review-r1 used to prove the original defect live (a 309-byte
 * .claude.json appearing in a redirected HOME). The precondition is the settled readiness record
 * carried out of proveSessionA — this proof watches a probe that RAN, not one that may still be pending.
 * Its falsifier is a mutation run (the guard line removed), like the other proofs' mutation evidence;
 * there is no separate --falsify mode for it.
 */
function proveBootProbeNoSpawn(ctx, results, sessionA) {
  const home = ctx.env.HOME;
  let entries;
  try {
    entries = readdirSync(home);
  } catch {
    entries = [`readdir failed: ${home}`];
  }
  const stray = [".claude.json", ".claude"]
    .map((name) => join(home, name))
    .filter((p) => existsSync(p));
  const settled = sessionA.readiness?.settled === true;
  results.push({
    proof: "BOOT.hermetic-probe-no-spawn",
    ok: settled && stray.length === 0,
    detail: `home=${home}; readiness=${JSON.stringify(sessionA.readiness?.record)} settled=${String(settled)}; stray=${stray.length === 0 ? "none" : JSON.stringify(stray)}; home-entries=${JSON.stringify(entries)}`,
  });
}

async function proveSessionB(ctx, results, sessionId) {
  const c = new HostClient(ctx.launcher, ctx.project, ctx.env);
  await c.request("initialize", initParams(), ctx.stepMs);
  const list = await c.request("session/list", {}, ctx.stepMs);
  const has = (list.result?.sessions ?? []).some((s) => s.sessionId === sessionId);
  const loaded = await c.request(
    "session/load",
    { sessionId, cwd: ctx.project, mcpServers: [] },
    ctx.stepMs,
  );
  results.push({
    proof: "6.session/load-continue",
    ok: has && loaded.result !== undefined && loaded.error === undefined,
    detail: loaded.result !== undefined ? "loaded" : JSON.stringify(loaded.error),
  });
  c.endStdin();
  const exit = await c.waitExit(ctx.stepMs);
  results.push({ proof: "7.stdin-eof-exit0", ok: exit.code === 0, detail: JSON.stringify(exit) });
}

async function proveWrongCwd(ctx, results) {
  const other = join(ctx.root, "elsewhere");
  mkdirSync(other, { recursive: true });
  const c = new HostClient(ctx.launcher, ctx.project, ctx.env);
  await c.request("initialize", initParams(), ctx.stepMs);
  const bad = await c.request("session/new", { cwd: other, mcpServers: [] }, ctx.stepMs);
  const ok =
    bad.error !== undefined &&
    bad.error.code === -32602 &&
    String(bad.error.message).includes(WRONG_CWD_MESSAGE);
  results.push({
    proof: "8.wrong-cwd-invalid-params",
    ok,
    detail: bad.error
      ? `${String(bad.error.code)} ${String(bad.error.message)}`
      : "unexpected success",
  });
  c.endStdin();
  await c.waitExit(ctx.stepMs);
}

/** Stage a copy of dist with ONE named file removed, INSIDE the repo (gitignored .verify-logs/) so Node still
 * resolves node_modules — the only difference from the real dist must be that file, or the red is for the
 * wrong reason. Returns { distRoot, brokenRoot }. */
function stageBrokenDist(repoRoot, missing) {
  const brokenRoot = join(repoRoot, ".verify-logs", `oracle-falsify-${process.pid}`);
  const distRoot = join(brokenRoot, "dist");
  rmSync(brokenRoot, { recursive: true, force: true });
  cpSync(join(repoRoot, "dist"), distRoot, { recursive: true });
  const target = join(distRoot, ...missing);
  if (!existsSync(target)) throw new Error(`falsifier precondition: ${target} not staged`);
  unlinkSync(target);
  return { distRoot, brokenRoot };
}

const FALSIFIER_TARGETS = {
  schema: ["src", "evidence", "schema.sql"],
  "digest-entry": ["src", "memory", "digest-entry.js"],
};

/**
 * A6, the must-fail proof for the second executable entry: with the compiled digest entry deleted, closing a
 * room must leave a DURABLE classified failure and NO digest fact. A silent close here would mean a packaged
 * build that quietly never remembers anything — the failure this whole phase exists to make impossible.
 */
async function proveDigestEntryFalsifier(ctx, results) {
  const c = new HostClient(ctx.launcher, ctx.project, ctx.env);
  await c.request("initialize", initParams(), ctx.stepMs);
  const created = await c.request("session/new", { cwd: ctx.project, mcpServers: [] }, ctx.stepMs);
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string") {
    c.endStdin();
    await c.waitExit(ctx.stepMs);
    results.push({
      proof: "A6.digest-entry-falsifier(must-fail)",
      ok: false,
      detail: `session/new failed for the wrong reason: ${JSON.stringify(created.error)}`,
    });
    return;
  }
  await c.request("zer0/room/submit", { sessionId, text: "@all falsifier turn" }, ctx.stepMs);
  await c.waitForEvents((e) => e?.type === "lane.failed", AGENTS.length, ctx.stepMs);
  // Sampled while the host still runs, so the "the watermark did not move" clause below has a real before.
  const beforeMarks = readDigestSafe(ctx)?.marks ?? [];
  const shut = await c.request("zer0/room/shutdown", { sessionId }, ctx.stepMs);
  const exit = await c.waitExit(ctx.stepMs);
  const { snapshot: seen, timeline } = await waitForDigest(ctx, (db) => db.scratch.length > 0);
  const scratch = (seen?.scratch ?? []).map((row) => row.body);
  const log = join(ctx.project, ".zer0", "journal", "digest-failures.log");
  const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
  // The record must name THIS session and THE path that was removed — "some catastrophe happened" would
  // pass on an unrelated failure and prove nothing about the missing entry (codex #16). Paths are compared
  // with separators and case normalised, the same win32 spelling tolerance digest-entry.ts:isDirectInvocation
  // applies, because the parent builds this path from import.meta.url and the falsifier from join().
  const entry = join(ctx.distRoot, "src", "memory", "digest-entry.js");
  const normal = (text) => text.replace(/\\/g, "/").toLowerCase();
  const namesTarget = (text) =>
    text.includes("[digest-catastrophe]") &&
    text.includes(`session=${sessionId}`) &&
    normal(text).includes(normal(entry));
  const recorded = [...scratch, ...logged.split("\n")].some(namesTarget);
  const noFact = (seen?.decisions.length ?? 1) === 0 && (seen?.summaries.length ?? 1) === 0;
  // A host that was KILLED on timeout, or that failed the shutdown, would produce "no digest fact" for a
  // reason that has nothing to do with the missing entry — the falsifier would then be green while proving
  // nothing. So the close itself must have succeeded normally, and no watermark may have moved.
  const closedCleanly =
    shut.result?.acknowledged === true && exit.timeout !== true && exit.code === 0;
  const afterMarks = seen?.marks ?? [];
  const watermarkStill = JSON.stringify(afterMarks) === JSON.stringify(beforeMarks);
  const ok = recorded && noFact && closedCleanly && watermarkStill;
  results.push({
    proof: "A6.digest-entry-falsifier(must-fail)",
    ok,
    detail: `durable-record-names-session-and-entry=${String(recorded)} no-digest-fact=${String(noFact)} shutdown-ack=${String(shut.result?.acknowledged)} exit=${JSON.stringify(exit)} watermark ${JSON.stringify(beforeMarks)} -> ${JSON.stringify(afterMarks)}; missing-entry=${JSON.stringify(entry)}; scratch=${JSON.stringify(scratch.map((b) => b.slice(0, 200)))}; log=${JSON.stringify(logged.slice(-200))}; host-stderr=${JSON.stringify(c.stderr.replace(/\s+/g, " ").slice(-200))}${ok ? "" : ` || ${digestDiagnosis(ctx, timeline)}`}`,
  });
}

/** The must-fail proof: without the compiled schema, session/new must fail and the cause must reach stderr. */
async function proveSchemaFalsifier(ctx, results) {
  const c = new HostClient(ctx.launcher, ctx.project, ctx.env);
  let outcome;
  try {
    await c.request("initialize", initParams(), ctx.stepMs);
    const created = await c.request(
      "session/new",
      { cwd: ctx.project, mcpServers: [] },
      ctx.stepMs,
    );
    outcome =
      created.error !== undefined
        ? `session/new error: ${String(created.error.message)}`
        : "session/new SUCCEEDED";
  } catch (error) {
    outcome = `host failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  c.endStdin();
  const exit = await c.waitExit(ctx.stepMs);
  const failed = !outcome.includes("SUCCEEDED");
  const causeSeen = /schema\.sql|ENOENT/.test(c.stderr);
  results.push({
    proof: "F.schema-falsifier(must-fail)",
    ok: failed && causeSeen,
    detail: `${outcome}; exit=${JSON.stringify(exit)}; cause-in-stderr=${String(causeSeen)}: ${c.stderr.replace(/\s+/g, " ").slice(-260)}`,
  });
}

function bestEffortRm(path) {
  if (path === undefined) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Codex #18: the run must produce EXACTLY the proof set `docs/provenance/oracle.json` registers for this
 * configuration. Without this, deleting a proof function and re-registering leaves both the hash gate and
 * `results.every(ok)` green while the proof never executes again — the registration would attest to a set
 * nobody checks. A registered proof that did not run, and an unregistered proof that did, are both red here.
 * The comparison counts THIS result too, so it can never be the silent one.
 */
function proveRunMatchesRegistration(repoRoot, mode, falsify, results) {
  const name = "R.run-matches-registration";
  const key = falsify === undefined ? mode : `falsify:${falsify}`;
  let ok = false;
  let detail;
  try {
    const reg = JSON.parse(
      readFileSync(join(repoRoot, "docs", "provenance", "oracle.json"), "utf8"),
    );
    const expected = reg.runProofs?.[key];
    if (!Array.isArray(expected) || expected.length === 0)
      throw new Error(`registration has no runProofs for "${key}"`);
    const produced = [...results.map((r) => r.proof), name].sort();
    const missing = expected.filter((p) => !produced.includes(p));
    const unregistered = produced.filter((p) => !expected.includes(p));
    ok = missing.length === 0 && unregistered.length === 0;
    detail = `${key}: ran ${String(produced.length)} of ${String(expected.length)} registered; did-not-run=${JSON.stringify(missing)} unregistered=${JSON.stringify(unregistered)}`;
  } catch (error) {
    detail = `registration unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  results.push({ proof: name, ok, detail });
}

async function runProofs(ctx, results, falsify) {
  if (falsify === "schema") return proveSchemaFalsifier(ctx, results);
  if (falsify === "digest-entry") return proveDigestEntryFalsifier(ctx, results);
  const sessionA = await proveSessionA(ctx, results);
  if (sessionA !== undefined) {
    const sessionId = sessionA.sessionId;
    // Order matters: the digest of session A must be on disk BEFORE the second attach, or "replay changed
    // nothing" would be comparing against a digest that had simply not landed yet. The digest proofs are
    // hermetic-only: release mode submits no turn, so there is nothing to digest and no canned extraction.
    if (ctx.mode === "hermetic") proveBootProbeNoSpawn(ctx, results, sessionA);
    const digested =
      ctx.mode === "hermetic" ? await proveDigestOnClose(ctx, results, sessionId) : undefined;
    await proveSessionB(ctx, results, sessionId);
    if (ctx.mode === "hermetic") {
      proveReplayStable(ctx, results, sessionId, digested);
      await proveEmptyExtraction(ctx, results);
    }
  }
  await proveWrongCwd(ctx, results);
}

/**
 * Everything that must hold BEFORE a temp root exists, let alone a proof: the falsifier has to be one we
 * implement, and the build under test has to be this tree. Both refuse by throwing, so a run that gets past
 * here has nothing left to check about itself.
 *
 * The dist check is skipped for `--launcher`, where the host under test is an externally staged artifact
 * (the packaged sidecar in release mode) that this repo's `dist` says nothing about.
 */
function assertRunnable(args, repoRoot) {
  if (args.falsify !== undefined && !FALSIFIERS.includes(args.falsify))
    throw new Error(`unknown falsifier ${args.falsify}`);
  if (args.launcher === undefined) assertDistMatchesSrc(repoRoot);
}

export async function runOracle(rawArgs = process.argv.slice(2), repoRoot = process.cwd()) {
  const args = parseArgs(rawArgs);
  assertRunnable(args, repoRoot);
  const root = mkdtempSync(join(tmpdir(), "m0irai-oracle-"));
  const results = [];
  const before = snapshot(watchList());
  let brokenRoot;
  try {
    let distRoot = join(repoRoot, "dist");
    if (args.falsify !== undefined)
      ({ distRoot, brokenRoot } = stageBrokenDist(repoRoot, FALSIFIER_TARGETS[args.falsify]));
    const env = args.mode === "hermetic" ? hermeticEnv(root) : releaseEnv();
    const project = gitInitProject(root);
    const launcher = args.launcher ? resolve(args.launcher) : tempLauncher(root, distRoot);
    const ctx = {
      mode: args.mode,
      root,
      project,
      launcher,
      env,
      repoRoot,
      distRoot,
      stepMs: args.deadlineMs,
    };
    await runProofs(ctx, results, args.falsify);
  } catch (error) {
    results.push({
      proof: "oracle",
      ok: false,
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    const after = snapshot(watchList());
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    results.push({
      proof: "9.no-writes-outside-temp-root",
      ok: unchanged,
      detail: unchanged
        ? `${String(before.length)} watched files unchanged`
        : `changed: ${after.filter((x, i) => x !== before[i]).join("; ")}`,
    });
    // Last, so it sees every proof this run produced — including proof 9 above.
    proveRunMatchesRegistration(repoRoot, args.mode, args.falsify, results);
    // F9: a failed proof's temp root IS the diagnosis (the DB, .zer0/journal/digest-failures.log, the
    // leases, room-close.log). It is deleted only when every proof passed.
    const failed = results.some((r) => !r.ok);
    if (failed) process.stderr.write(`ORACLE TEMP ROOT RETAINED FOR DIAGNOSIS: ${root}\n`);
    else if (!args.keep) bestEffortRm(root);
    bestEffortRm(brokenRoot);
  }
  const ok = results.every((r) => r.ok);
  const report = {
    oracle: "m0irai-standalone",
    mode: args.mode,
    falsify: args.falsify ?? null,
    ok,
    results,
    tempRoot: args.keep ? root : undefined,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  return report;
}

const invokedPath = resolve(process.argv[1] ?? "");
const modulePath = resolve(fileURLToPath(import.meta.url));
const isMain =
  process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
if (isMain) {
  runOracle()
    .then((r) => {
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
