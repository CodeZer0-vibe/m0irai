/**
 * @file src/adapters/acp/acp-vendor-patch.test.ts
 * @purpose FIX-3c (codex DECISION → fix): regression protection for the VENDOR half of the F6 work that
 *   actually bites. acp-background-tasks.test.ts exercises only zer0's client, so deleting the forwarding
 *   lines from the patched adapter would not fail it — and a stray `npm install` can silently restore the
 *   pristine package. This reads the INSTALLED dist AND the patch artifact, so an unapplied or
 *   drifted patch cannot look healthy: no mock stands between the assertion and the file that ships.
 *   Lives in the UNIT pool on purpose (not tests/integration/, which only runs under
 *   `npm run test:integration`) — it is pure synchronous file reads, and a silent revert must fail the
 *   test command everyone actually runs. Its sibling tests/integration/claude-acp-usage-patch.test.ts
 *   guards the OTHER patch hunk (the /usage windows) and the receipt lifecycle.
 * @exports (none — test file)
 * @depends node:fs, node:path, node:url, vitest
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALLED = join(
  REPO_ROOT,
  "node_modules",
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist",
  "acp-agent.js",
);
const PATCH = join(REPO_ROOT, "patches", "@agentclientprotocol+claude-agent-acp+0.75.1.patch");

const dist = readFileSync(INSTALLED, "utf8");
const patch = readFileSync(PATCH, "utf8");
const both = { "installed dist": dist, "patch artifact": patch };

describe("F6 vendor patch: the background-task forwarding is really in the shipped adapter", () => {
  for (const [label, text] of Object.entries(both)) {
    it(`${label} defines and calls the forwarder`, () => {
      // The forwarder itself, plus BOTH call sites (the membership level + the completion edge). Three
      // occurrences: one definition, one per case. Deleting either case drops the count and fails here.
      expect(text.match(/zer0ForwardBackgroundTasks/g)?.length).toBe(3);
      expect(text).toContain('"_claude/backgroundTasks"');
      expect(text).toContain('reason: "membership_changed"');
      expect(text).toContain('reason: "task_notification"');
    });

    it(`${label} keeps the forward FAIL-SOFT (a client without the extension must not brick the session)`, () => {
      // The forward runs inside the consumer loop, where a throw reaches the catch that calls
      // failAllTurns + closeQueryStream. The try/catch is load-bearing, not decoration.
      // Sliced by index rather than matched by a brace-counting regex, so this reads the same in the
      // installed file and in the patch artifact (whose lines carry a leading `+`).
      const start = text.indexOf("async zer0ForwardBackgroundTasks(");
      expect(start).toBeGreaterThan(-1);
      const forwarder = text.slice(start, start + 700);
      expect(forwarder).toContain(`try ${String.fromCharCode(123)}`);
      expect(forwarder).toContain("catch");
      expect(forwarder).toContain('extNotification("_claude/backgroundTasks"');
    });
  }
});

describe("F6 vendor patch: the trace records STRUCTURE, never operator content (privacy)", () => {
  for (const [label, text] of Object.entries(both)) {
    it(`${label} routes every raw SDK payload through the redactor`, () => {
      expect(text).toContain("function zer0RedactPayload");
      // All four task edge/progress sites plus background_tasks_changed. The latest bridge owns
      // task lifecycle bookkeeping upstream; Zer0 observes those exact branches without replacing it.
      expect(text.match(/raw: zer0RedactPayload\(message\)/g)?.length).toBe(5);
    });

    it(`${label} contains NO un-redacted raw payload site — the exact leak this closed`, () => {
      // `raw: message` wrote the operator's real instructions (`prompt`), the model's paraphrase
      // (`description`/`summary`) and an absolute path carrying their user + project names into a debug
      // artifact that gets shared. If this string ever comes back, the leak is back.
      expect(text).not.toContain("raw: message");
      expect(text).not.toContain("taskSubjects:");
      expect(text).not.toContain("adapterTaskSubjects:");
    });

    it(`${label} keeps the trace debug-gated (zero cost, and no file written, when unset)`, () => {
      expect(text).toContain("process.env.ZER0_ADAPTER_TRACE");
      expect(text).toContain("if (!ZER0_TRACE_PATH)");
    });
  }
});

describe("F6 vendor patch: the latest bridge retains every lifecycle observation point", () => {
  for (const [label, text] of Object.entries(both)) {
    it(`${label} keeps turn, compaction, session, stream, and task-result markers`, () => {
      for (const marker of [
        'zer0Trace("prompt.enter"',
        'zer0Trace("prompt.rejected.sessionEnded"',
        'zer0Trace("turn.settled"',
        'zer0Trace("sdk.compaction"',
        'zer0Trace("session.created"',
        'zer0Trace("queryStream.closed"',
        'zer0Trace("taskTool.result"',
      ]) {
        expect(text).toContain(marker);
      }
      expect(text).toContain("zer0QueryId");
      expect(text).toContain("zer0SessionId");
    });
  }
});
