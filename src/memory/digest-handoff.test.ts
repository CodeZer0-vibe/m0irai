// The F10 seam, from the Node side: with ZER0_DIGEST_HANDOFF=1 the close writes a durable REQUEST and forks
// NOTHING (the process seam is injected and throws if anything tries), and that request is the in-process
// spawn plan verbatim — argv, env and cwd field-by-field — because the Rust consumer spawns exactly it. With
// the flag unset the same call forks in process and writes no request. Real fs; no child is ever created.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type DigestRequestLine,
  createHandoffSpawn,
  digestRequestFile,
  resolveDigestSpawns,
} from "./digest-handoff.js";
import {
  type DigestRequest,
  type DigestSpawnImpl,
  digestEntryPath,
  digestSpawnArgs,
  spawnDetachedDigest,
} from "./digest-runner.js";

const FLAG = "ZER0_DIGEST_HANDOFF";
const savedFlag = process.env[FLAG];
const roots: string[] = [];

/** The process seam every handoff test injects: if the handoff ever forks, the test says so by name. */
const neverForks: DigestSpawnImpl = () => {
  throw new Error("the handoff path forked a child instead of writing a request");
};

beforeEach(() => {
  delete process.env[FLAG];
});

afterEach((ctx) => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  const taken = roots.splice(0);
  if (ctx.task.result?.state === "fail") {
    for (const root of taken) process.stderr.write(`RETAINED handoff workspace: ${root}\n`);
    return;
  }
  for (const root of taken) rmSync(root, { force: true, recursive: true, maxRetries: 5 });
});

function workspace(): { readonly repoRoot: string; readonly dbPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "zer0-handoff-"));
  roots.push(repoRoot);
  return { repoRoot, dbPath: join(repoRoot, ".zer0", "evidence.db") };
}

function requestLines(file: string): DigestRequestLine[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DigestRequestLine);
}

it("the handoff writes ONE request that IS the in-process spawn plan, and forks nothing", () => {
  const { repoRoot, dbPath } = workspace();
  process.env[FLAG] = "1";
  const request: DigestRequest = { sessionId: "chat-handoff", repoRoot, dbPath, projectId: "p1" };
  const plan = digestSpawnArgs(request);

  const outcome = spawnDetachedDigest(
    request,
    resolveDigestSpawns(digestEntryPath(), neverForks).close,
  );

  expect(outcome).toBe("handed-off");
  const file = digestRequestFile(repoRoot);
  expect(file).toBe(join(repoRoot, ".zer0", "journal", "digest-requests.jsonl"));
  const lines = requestLines(file);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  // Field by field: the Rust consumer spawns `execPath argv…` with env_clear() + env and current_dir(cwd),
  // so any difference from the plan is a child that behaves differently from the one this host would fork.
  expect(line).toEqual({
    v: 1,
    kind: "digest",
    sessionId: "chat-handoff",
    projectId: "p1",
    repoRoot,
    dbPath: resolve(repoRoot, dbPath),
    execPath: process.execPath,
    argv: [...plan.argv],
    cwd: plan.options.cwd,
    env: plan.options.env,
    requestedAt: line?.requestedAt,
  });
  expect(line?.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  // The flag must NOT ride into the child, or the child would try to hand its own work off again.
  expect(Object.keys(line?.env ?? {})).not.toContain(FLAG);
});

it("a second close appends a second line — the file is a queue, never a rewrite", () => {
  const { repoRoot, dbPath } = workspace();
  process.env[FLAG] = "1";
  const close = resolveDigestSpawns(digestEntryPath(), neverForks).close;
  spawnDetachedDigest({ sessionId: "chat-one", repoRoot, dbPath, projectId: "p1" }, close);
  spawnDetachedDigest({ sessionId: "chat-two", repoRoot, dbPath, projectId: "p1" }, close);
  expect(requestLines(digestRequestFile(repoRoot)).map((line) => line.sessionId)).toEqual([
    "chat-one",
    "chat-two",
  ]);
});

it("without the flag the SAME call forks in process and writes no request (C4 path unchanged)", () => {
  const { repoRoot, dbPath } = workspace();
  const forked: { command: string; argv: readonly string[] }[] = [];
  const recording: DigestSpawnImpl = (command, args) => {
    forked.push({ command, argv: args });
    return { once: () => undefined, unref: () => undefined };
  };
  const request: DigestRequest = { sessionId: "chat-inproc", repoRoot, dbPath, projectId: "p1" };

  const outcome = spawnDetachedDigest(
    request,
    resolveDigestSpawns(digestEntryPath(), recording).close,
  );

  expect(outcome).toBe("requested");
  expect(forked).toHaveLength(1);
  expect(forked[0]?.command).toBe(process.execPath);
  expect(forked[0]?.argv).toEqual(digestSpawnArgs(request).argv);
  expect(existsSync(digestRequestFile(repoRoot))).toBe(false);
});

it("boot catch-up children are forked here even under the flag — they run while the host runs", () => {
  const { repoRoot, dbPath } = workspace();
  process.env[FLAG] = "1";
  const forked: string[] = [];
  const recording: DigestSpawnImpl = (command) => {
    forked.push(command);
    return { once: () => undefined, unref: () => undefined };
  };
  const seams = resolveDigestSpawns(digestEntryPath(), recording);

  const outcome = spawnDetachedDigest(
    { sessionId: "chat-catchup", repoRoot, dbPath, projectId: "p1" },
    seams.catchUp,
  );

  expect({ outcome, forked: forked.length }).toEqual({ outcome: "requested", forked: 1 });
  expect(existsSync(digestRequestFile(repoRoot))).toBe(false);
});

it("the folder is created when it does not exist, and a write that cannot be made durable THROWS", () => {
  const { repoRoot, dbPath } = workspace();
  expect(existsSync(join(repoRoot, ".zer0", "journal"))).toBe(false);
  const request: DigestRequest = { sessionId: "chat-mkdir", repoRoot, dbPath, projectId: "p1" };
  createHandoffSpawn(digestEntryPath())(request);
  expect(existsSync(digestRequestFile(repoRoot))).toBe(true);

  // A file where the folder must be: the OS refuses, and the seam must not pretend a digest was scheduled.
  const blocked = join(repoRoot, "blocked");
  writeFileSync(blocked, "not a directory", "utf8");
  expect(() =>
    createHandoffSpawn(digestEntryPath(), join(blocked, "requests.jsonl"))(request),
  ).toThrow(/ENOTDIR|EEXIST|ENOENT/u);
});
