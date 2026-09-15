/**
 * @file src/room/room-listing.fixtures.ts
 * @purpose Room fixtures and the in-process session/list driver shared by the listing falsifiers.
 * @exports SeededRoom, ListedFrame, seedRoom, seedBeyondThePage, plantNestedStamp, listRooms, listedRows, captureStderr
 * @depends node:crypto, node:fs/promises, node:path, ./zer0-v2-host
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonRpcWriter, RoomRpcServer } from "./zer0-v2-host.js";

export interface SeededRoom {
  readonly id: string;
  readonly runDir: string;
}

export interface ListedFrame {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Seeds a room WITHOUT the real writer, because hundreds of real `createSession` calls cost one
 * git-backed project-scope resolve each. The drift risk that buys is closed by the listing suite's
 * first test, which pins this shape against one room written by the production writer.
 */
export async function seedRoom(
  root: string,
  updatedAt: string,
  options: { marked?: boolean; title?: string; padBytes?: number } = {},
): Promise<SeededRoom> {
  const id = `chat-${String(Date.now())}-${randomUUID()}`;
  const runDir = path.join(root, ".council", "runs", id);
  await mkdir(runDir, { recursive: true });
  const session = {
    id,
    repoRoot: root,
    runDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [
      {
        id: `msg-${randomUUID()}`,
        turn: 1,
        role: "user",
        agent: "user",
        text: `${options.title ?? "Room"}${" ".repeat(options.padBytes ?? 0)}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        tokenEstimate: 1,
      },
    ],
  };
  await writeFile(path.join(runDir, "transcript.json"), JSON.stringify(session, null, 2), "utf8");
  if (options.marked !== false)
    await writeFile(path.join(runDir, "zer0-v2-room.json"), JSON.stringify({ version: 1 }), "utf8");
  return { id, runDir };
}

/** Enough rooms that the page cut happens BEFORE any full load, which is where the stamp decides. */
export async function seedBeyondThePage(
  root: string,
  count: number,
): Promise<readonly SeededRoom[]> {
  const seeded: SeededRoom[] = [];
  for (let index = 0; index < count; index += 1) {
    seeded.push(
      await seedRoom(root, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), {
        title: `Room ${String(index).padStart(3, "0")}`,
      }),
    );
  }
  return seeded;
}

/**
 * Rewrites one room's transcript so it stays schema-valid and stays the same room, but carries a SECOND
 * `updatedAt` nested one level down at two-space indentation — the shape a prefix regex mistakes for a
 * top-level field. The document is minified so the planted line is the only two-space line in it.
 */
export async function plantNestedStamp(runDir: string, stamp: string): Promise<void> {
  const transcript = path.join(runDir, "transcript.json");
  const session: unknown = JSON.parse(await readFile(transcript, "utf8"));
  await writeFile(
    transcript,
    `${JSON.stringify(session).slice(0, -1)},"metadata":{\n  "updatedAt": "${stamp}"\n}}`,
    "utf8",
  );
}

/** Minifies a seeded room's transcript, so its header cannot be reconstructed from the prefix. */
export async function minifyTranscript(runDir: string): Promise<void> {
  const transcript = path.join(runDir, "transcript.json");
  const session: unknown = JSON.parse(await readFile(transcript, "utf8"));
  await writeFile(transcript, JSON.stringify(session), "utf8");
}

/**
 * Drives one real `session/list` in process, over a REAL JsonRpcWriter and a fake stdout: the frames
 * these tests read are the ones that would go on the wire, validated by the writer's own encoder.
 */
export async function listRooms(root: string): Promise<ListedFrame> {
  const frames: ListedFrame[] = [];
  const stdout = {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      frames.push(JSON.parse(chunk) as ListedFrame);
      callback();
      return true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  const server = new RoomRpcServer(
    root,
    new JsonRpcWriter(stdout),
    path.join(root, "evidence.db"),
    root,
  );
  try {
    await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    );
    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} }),
    );
    await server.drain();
  } finally {
    await server.shutdown();
  }
  const frame = frames.find((candidate) => candidate.id === "list");
  if (frame === undefined) throw new Error("session/list produced no response frame");
  return frame;
}

export function listedRows(frame: ListedFrame): readonly Record<string, unknown>[] {
  const result = frame.result as { sessions?: readonly Record<string, unknown>[] } | undefined;
  if (result?.sessions === undefined)
    throw new Error(`session/list returned no rows: ${JSON.stringify(frame)}`);
  return result.sessions;
}

/** Collects the host's stderr for the duration of one call, then restores the real stream. */
export async function captureStderr<T>(
  run: () => Promise<T>,
): Promise<{ readonly value: T; readonly lines: readonly string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), lines };
  } finally {
    process.stderr.write = original;
  }
}
