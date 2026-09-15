/**
 * @file src/chat/session-store-atomic.test.ts
 * @purpose Falsifiers for the transcript's durability contract: a torn write never replaces a good file.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// The writer seam. Every `node:fs/promises` call in the module graph stays REAL except `writeFile` and
// `rename`, which consult these hooks first — that is how a crash mid-write and a hostile rename are
// injected without touching production code or the surrounding filesystem.
const hooks: {
  writeFile: ((file: string, data: string) => Promise<void> | undefined) | undefined;
  rename: ((from: string, to: string) => Promise<void> | undefined) | undefined;
} = { writeFile: undefined, rename: undefined };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    writeFile: async (file: unknown, data: unknown, options?: unknown) => {
      const injected = hooks.writeFile?.(String(file), String(data));
      if (injected !== undefined) return injected;
      return actual.writeFile(file as string, data as string, options as never);
    },
    rename: async (from: unknown, to: unknown) => {
      const injected = hooks.rename?.(String(from), String(to));
      if (injected !== undefined) return injected;
      return actual.rename(from as string, to as string);
    },
  };
});

const { appendMessage, createSession, listSessions, loadSession, persistSession } = await import(
  "./session-store.js"
);
const { createUserMessage } = await import("./commands.js");

const roots: string[] = [];

afterEach(async () => {
  hooks.writeFile = undefined;
  hooks.rename = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sl-atomic-"));
  roots.push(root);
  return root;
}

function transcriptPath(runDir: string): string {
  return path.join(runDir, "transcript.json");
}

/** Every `.tmp` scratch file the atomic writer left behind in the room directory. */
async function strayTempFiles(runDir: string): Promise<readonly string[]> {
  return (await readdir(runDir)).filter((name) => name.endsWith(".tmp"));
}

it("falsifier: a crash 60% through the write leaves the previous transcript byte-identical and loadable", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  const good = appendMessage(created, createUserMessage(1, "the answer that must survive"));
  await persistSession(good);
  const before = await readFile(transcriptPath(good.runDir), "utf8");

  const doomed = appendMessage(good, createUserMessage(2, "the write that never finished"));
  hooks.writeFile = async (file, data) => {
    if (!file.endsWith(".json") && !file.endsWith(".tmp")) return undefined;
    // A power cut mid-write: 60% of the bytes reach the disk, then the process dies.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await actual.writeFile(file, data.slice(0, Math.floor(data.length * 0.6)), "utf8");
    throw new Error("simulated crash 60% through the transcript write");
  };
  await expect(persistSession(doomed)).rejects.toThrow("simulated crash");
  hooks.writeFile = undefined;

  expect(await readFile(transcriptPath(good.runDir), "utf8")).toBe(before);
  const reloaded = await loadSession(good.id, root);
  expect(reloaded.messages.map((message) => message.text)).toEqual([
    "the answer that must survive",
  ]);
  expect(await strayTempFiles(good.runDir)).toEqual([]);
});

it("falsifier: a rename that always throws leaves the previous transcript intact, reports, and strands no temp file", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  const good = appendMessage(created, createUserMessage(1, "durable"));
  await persistSession(good);
  const before = await readFile(transcriptPath(good.runDir), "utf8");

  hooks.rename = () => Promise.reject(Object.assign(new Error("EPERM: forced"), { code: "EPERM" }));
  const doomed = appendMessage(good, createUserMessage(2, "never lands"));
  await expect(persistSession(doomed)).rejects.toThrow(/transcript\.json/u);
  hooks.rename = undefined;

  expect(await readFile(transcriptPath(good.runDir), "utf8")).toBe(before);
  expect(await strayTempFiles(good.runDir)).toEqual([]);
});

it("falsifier: the rename failure names the file, the cause, and what the operator can still do", async () => {
  const root = await freshRoot();
  const session = await createSession(root);
  hooks.rename = () => Promise.reject(Object.assign(new Error("EPERM: forced"), { code: "EPERM" }));
  const failure = await persistSession(session).catch((error: unknown) => error);
  hooks.rename = undefined;
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).toContain("transcript.json");
  expect(message).toContain("EPERM");
  expect(message).toMatch(/room-events\.jsonl|journal/u);
});

it("falsifier: concurrent saves of the same room keep the accepted order, newest last", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  const first = appendMessage(created, createUserMessage(1, "accepted first"));
  const second = appendMessage(first, createUserMessage(2, "accepted second"));

  // The hazard, made deterministic: the FIRST accepted save is slow. Without serialization the second
  // save's bytes land first and the first save then overwrites them — the room loses its newest turn.
  // A delay here is a hazard injected into a fake, never a deadline any assertion below reads.
  let stalled = false;
  hooks.writeFile = (file, data) => {
    if (stalled || !data.includes("accepted first") || data.includes("accepted second"))
      return undefined;
    stalled = true;
    return (async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await actual.writeFile(file, data, "utf8");
    })();
  };

  // Both are handed to the store without awaiting the first — the store, not luck, decides the order.
  await Promise.all([persistSession(first), persistSession(second)]);
  hooks.writeFile = undefined;
  expect(stalled).toBe(true);

  const onDisk = await loadSession(created.id, root);
  expect(onDisk.messages.map((message) => message.text)).toEqual([
    "accepted first",
    "accepted second",
  ]);
});

it("falsifier: an interrupted write never shortens the file the reader sees", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  const big = appendMessage(created, createUserMessage(1, "x".repeat(20_000)));
  await persistSession(big);
  const fullSize = (await stat(transcriptPath(big.runDir))).size;

  hooks.rename = () => Promise.reject(new Error("interrupted"));
  await persistSession(appendMessage(big, createUserMessage(2, "y".repeat(20_000)))).catch(
    () => undefined,
  );
  hooks.rename = undefined;

  expect((await stat(transcriptPath(big.runDir))).size).toBe(fullSize);
});

it("a missing runs directory is empty, and listSessions still answers with the rooms it can see", async () => {
  const root = await freshRoot();
  expect(await listSessions(root)).toEqual([]);
  const created = await createSession(root);
  expect(await listSessions(root)).toEqual([created.id]);
});

it("falsifier: a directory entry that is not a room never reaches the caller", async () => {
  const root = await freshRoot();
  const created = await createSession(root);
  await writeFile(path.join(root, ".council", "runs", "not-a-room.txt"), "x", "utf8");
  expect(await listSessions(root)).toEqual([created.id]);
});
