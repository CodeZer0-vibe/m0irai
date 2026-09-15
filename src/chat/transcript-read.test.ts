/**
 * @file src/chat/transcript-read.test.ts
 * @purpose Pins the four verdicts, the strict UTF-8 decode, and the header reconstruction the stamp probe relies on.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readTranscript, readTranscriptStamp } from "./transcript-read.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SESSION_ID = "chat-1700000000000-fixture" as const;

async function roomWith(content: string | Uint8Array): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "transcript-read-"));
  roots.push(root);
  const runDir = path.join(root, ".council", "runs", SESSION_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "transcript.json"), content);
  return root;
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    repoRoot: "C:/anywhere",
    runDir: "C:/anywhere/.council/runs/chat-1700000000000-fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-03T04:05:06.000Z",
    defaultAgent: "claude",
    lastAgent: null,
    summary: { text: "", throughTurn: 0 },
    messages: [
      {
        id: "msg-1",
        turn: 1,
        role: "user",
        agent: "user",
        text: "history",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        tokenEstimate: 1,
      },
    ],
    ...overrides,
  };
}

it("loads a healthy transcript and rebinds it to the caller's own paths", async () => {
  const root = await roomWith(JSON.stringify(session(), null, 2));
  const read = await readTranscript(SESSION_ID, root);
  expect(read.outcome.kind).toBe("loaded");
  if (read.outcome.kind !== "loaded") return;
  expect(read.outcome.session.repoRoot).toBe(root);
  expect(read.outcome.session.messages).toHaveLength(1);
});

it("a missing transcript is absent, and says nothing about content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "transcript-read-"));
  roots.push(root);
  expect((await readTranscript(SESSION_ID, root)).outcome.kind).toBe("absent");
});

it("falsifier: a byte that is not valid UTF-8 is damaged, and the verdict carries those exact bytes", async () => {
  // Reading this as a UTF-8 string substitutes U+FFFD and the document then parses cleanly, which is
  // how an operator's history was silently replaced by replacement characters.
  const text = JSON.stringify(session(), null, 2);
  const bytes = Buffer.from(text, "utf8");
  bytes[text.indexOf("history")] = 0xff;

  const read = await readTranscript(SESSION_ID, await roomWith(bytes));

  expect(read.outcome.kind).toBe("damaged");
  if (read.outcome.kind !== "damaged") return;
  expect(read.outcome.reason).toMatch(/not valid UTF-8/u);
  expect(Buffer.from(read.outcome.bytes)).toEqual(bytes);
});

it("a transcript that is not a JSON document is damaged and carries its bytes", async () => {
  const torn = JSON.stringify(session(), null, 2).slice(0, 120);
  const read = await readTranscript(SESSION_ID, await roomWith(torn));
  expect(read.outcome.kind).toBe("damaged");
  if (read.outcome.kind !== "damaged") return;
  expect(Buffer.from(read.outcome.bytes).toString("utf8")).toBe(torn);
});

it("intact bytes that are not this room are incompatible, and carry no bytes to move", async () => {
  const wrongId = await readTranscript(
    SESSION_ID,
    await roomWith(JSON.stringify(session({ id: "chat-1700000000001-elsewhere" }), null, 2)),
  );
  expect(wrongId.outcome.kind).toBe("incompatible");
  expect(wrongId.outcome).not.toHaveProperty("bytes");

  const wrongShape = await readTranscript(
    SESSION_ID,
    await roomWith(JSON.stringify(session({ defaultAgent: undefined }), null, 2)),
  );
  expect(wrongShape.outcome.kind).toBe("incompatible");
});

it("the stamp comes from the header without reading the whole file", async () => {
  const root = await roomWith(JSON.stringify(session(), null, 2));
  const stamp = await readTranscriptStamp(SESSION_ID, root);
  expect(stamp).toEqual({
    kind: "stamped",
    updatedAt: "2026-02-03T04:05:06.000Z",
    session: undefined,
  });
});

it("falsifier: a nested updatedAt at two-space depth is never mistaken for the header's own", async () => {
  // Schema-valid, same room, and the ONLY two-space-indented line is the planted nested one. A pattern
  // match reads indentation as nesting; reconstructing and parsing the header cannot be fooled by it.
  const minified = JSON.stringify(session());
  const planted = `${minified.slice(0, -1)},"metadata":{\n  "updatedAt": "1900-01-01T00:00:00.000Z"\n}}`;

  const stamp = await readTranscriptStamp(SESSION_ID, await roomWith(planted));

  expect(stamp.kind).toBe("stamped");
  if (stamp.kind !== "stamped") return;
  expect(stamp.updatedAt).toBe("2026-02-03T04:05:06.000Z");
  // It fell back to the whole-file read, and that load is handed back so no caller pays for it twice.
  expect(stamp.session?.updatedAt).toBe("2026-02-03T04:05:06.000Z");
});

it("falsifier: a header belonging to another room is never used as this room's stamp", async () => {
  const foreign = JSON.stringify(session({ id: "chat-1700000000001-elsewhere" }), null, 2);
  const stamp = await readTranscriptStamp(SESSION_ID, await roomWith(foreign));
  // The header parses, but its id is not this room, so the probe declines and the full read decides.
  expect(stamp.kind).toBe("incompatible");
});

it("a minified transcript still reports the right stamp, and hands back the load it paid for", async () => {
  const stamp = await readTranscriptStamp(SESSION_ID, await roomWith(JSON.stringify(session())));
  expect(stamp.kind).toBe("stamped");
  if (stamp.kind !== "stamped") return;
  expect(stamp.updatedAt).toBe("2026-02-03T04:05:06.000Z");
  expect(stamp.session).toBeDefined();
});

// N2-4 (delta review): the raw Zod message went to the operator whole — 545 characters of JSON for one
// missing member, unbounded in the transcript's own size because it echoes received values — with no
// next step. An operator who cannot read a diff needs the shape of the problem and what to do.
it("falsifier: a schema failure is bounded and says what the operator can do", async () => {
  const noisy = session({ defaultAgent: undefined, messages: Array.from({ length: 40 }, () => 1) });
  const read = await readTranscript(SESSION_ID, await roomWith(JSON.stringify(noisy, null, 2)));

  expect(read.outcome.kind).toBe("incompatible");
  if (read.outcome.kind !== "incompatible") return;
  const reason = read.outcome.reason;
  expect(reason.length).toBeLessThan(600);
  expect(reason).toContain("does not have the shape of a room transcript");
  // The next step, in the same shape as the unreadable message.
  expect(reason).toMatch(/untouched/u);
  expect(reason).toMatch(/build that wrote it|move that file aside/u);
});

it("a schema failure short enough to read is passed through whole", async () => {
  const read = await readTranscript(
    SESSION_ID,
    await roomWith(JSON.stringify(session({ summary: "not an object" }), null, 2)),
  );
  expect(read.outcome.kind).toBe("incompatible");
  if (read.outcome.kind !== "incompatible") return;
  expect(read.outcome.reason).not.toMatch(/characters in full/u);
});
