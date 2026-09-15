import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BOOT_PROGRESS_METHOD } from "./room-boot-progress.js";
import { JsonRpcWriter, RoomRpcServer } from "./zer0-v2-host.js";

/**
 * The seam this lane exists for: a real `session/new` puts its stage reports on the wire BEFORE the
 * response, in boot order, through the same serialized stdout owner as every other frame.
 *
 * Driven through `RoomRpcServer` rather than through the compiled host binary because the ordering is
 * what is under test and a spawned process would only add scheduling noise between the two. The Rust
 * side's half of the same seam — that these frames are decoded as progress instead of killing the
 * transport — is pinned in `boot_progress.rs`.
 */
it("puts every boot stage on the wire, in order, before the session/new response", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "boot-wire-"));
  gitInit(root);
  const { frames, writer } = recordingWriter();
  const server = new RoomRpcServer(root, writer, path.join(root, "evidence.db"), root, 8);
  try {
    await request(server, "init", "initialize", { protocolVersion: 1, clientCapabilities: {} });
    frames.length = 0;
    await request(server, "new", "session/new", { cwd: root, mcpServers: [] });

    const progress = frames.filter((frame) => frame.method === BOOT_PROGRESS_METHOD);
    expect(progress.map((frame) => stage(frame))).toStrictEqual([
      "evidence",
      "liveness",
      "migrate",
      "session",
      "journal",
    ]);

    // The migration stage is the expensive one and the one the operator was left staring at, so it is
    // the one that has to name what it is doing rather than just that it is doing something.
    expect(detail(progress[2])).toMatch(/^14 → /u);

    // Ordering is the contract: the terminal is holding the request open, so a stage that arrived
    // AFTER the response would have renewed nothing and told the operator nothing.
    const responseIndex = frames.findIndex((frame) => frame.id === "new");
    const afterResponse = frames
      .slice(responseIndex + 1)
      .filter((frame) => frame.method === BOOT_PROGRESS_METHOD);
    expect(responseIndex).toBeGreaterThan(-1);
    expect(afterResponse).toStrictEqual([]);
  } finally {
    await server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

async function request(
  server: RoomRpcServer,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  await server.drain();
}

function gitInit(root: string): void {
  // The project lock resolves a project id by shelling git; without a repository the boot refuses
  // before it reaches the stages this test is about.
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

function stage(frame: Record<string, unknown>): unknown {
  return params(frame).stage;
}

function detail(frame: Record<string, unknown> | undefined): unknown {
  return frame === undefined ? undefined : params(frame).detail;
}

function params(frame: Record<string, unknown>): Record<string, unknown> {
  const value = frame.params;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordingWriter(): {
  readonly frames: Record<string, unknown>[];
  readonly writer: JsonRpcWriter;
} {
  const frames: Record<string, unknown>[] = [];
  const stdout = {
    write(chunk: string, callback: (error?: Error | null) => void): boolean {
      frames.push(JSON.parse(chunk) as Record<string, unknown>);
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
  return { frames, writer: new JsonRpcWriter(stdout) };
}
