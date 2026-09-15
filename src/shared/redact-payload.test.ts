/**
 * @file src/shared/redact-payload.test.ts
 * @purpose FIX-3c BLOCK 4 (privacy): the debug-artifact redaction contract. Debug directories GET SHARED,
 *   and the bridge's background-task payloads carry the operator's actual work instructions, the model's
 *   paraphrase of them, and absolute paths embedding the operator's user/project names. The rule under
 *   test is INVERTED from a blocklist: a string is CONTENT unless its key is structurally allowlisted, so
 *   a future field carrying prose is redacted by default instead of leaking until someone notices.
 * @exports (none — test file)
 * @depends vitest, ./redact-payload
 */
import { describe, expect, it } from "vitest";
import { redactPayload } from "./redact-payload.js";

// The exact shape the patched claude ACP adapter forwards on _claude/backgroundTasks, with a prompt that
// stands in for the operator's real instructions.
const SECRET = "Refactor the billing reconciliation ledger for AcmeCorp before Friday";
const PAYLOAD = {
  sessionId: "21988528-1bb5-4597-8058-6e9f27366910",
  reason: "task_notification",
  taskId: "a6ead7c29f49d00a4",
  status: "completed",
  outputFile: "C:\\Users\\realname\\Projects\\SecretCo\\.zer0\\tasks\\a6ead.output",
  summary: SECRET,
  tasks: [{ task_id: "bc6i7yinc", task_type: "local_bash", description: SECRET }],
};

describe("redactPayload: structure survives, content never does", () => {
  it("keeps structural identifiers verbatim", () => {
    const out = redactPayload(PAYLOAD) as Record<string, unknown>;
    expect(out.sessionId).toBe("21988528-1bb5-4597-8058-6e9f27366910");
    expect(out.taskId).toBe("a6ead7c29f49d00a4");
    expect(out.status).toBe("completed");
    expect(out.reason).toBe("task_notification");
  });

  it("redacts every free-text string, nested and in arrays, to {len, sha8}", () => {
    const out = redactPayload(PAYLOAD) as Record<string, unknown>;
    expect(out.summary).toEqual({ redacted: true, len: SECRET.length, sha8: expect.any(String) });
    expect(out.outputFile).toMatchObject({ redacted: true });
    const tasks = out.tasks as Record<string, unknown>[];
    expect(tasks[0]?.task_id).toBe("bc6i7yinc"); // structural survives inside the array
    expect(tasks[0]?.task_type).toBe("local_bash");
    expect(tasks[0]?.description).toMatchObject({ redacted: true, len: SECRET.length });
  });

  it("THE GUARANTEE: the serialized result cannot contain the secret text anywhere", () => {
    expect(JSON.stringify(redactPayload(PAYLOAD))).not.toContain(SECRET);
    expect(JSON.stringify(redactPayload(PAYLOAD))).not.toContain("realname");
    expect(JSON.stringify(redactPayload(PAYLOAD))).not.toContain("SecretCo");
  });

  it("is stable: the same content hashes the same, different content differs (correlation without text)", () => {
    const a = redactPayload({ note: "alpha" }) as { note: { sha8: string } };
    const b = redactPayload({ note: "alpha" }) as { note: { sha8: string } };
    const c = redactPayload({ note: "beta" }) as { note: { sha8: string } };
    expect(a.note.sha8).toBe(b.note.sha8);
    expect(a.note.sha8).not.toBe(c.note.sha8);
  });
});

describe("redactPayload: defaults and caps", () => {
  it("passes numbers, booleans and null through — they cannot carry prose", () => {
    expect(redactPayload({ count: 3, ok: true, gone: null })).toEqual({
      count: 3,
      ok: true,
      gone: null,
    });
  });

  it("an UNKNOWN string key is redacted by default (the inverted rule, not a blocklist)", () => {
    const out = redactPayload({ someFutureSdkField: SECRET }) as Record<string, unknown>;
    expect(out.someFutureSdkField).toMatchObject({ redacted: true });
  });

  it("depth- and width-caps a pathological payload instead of wedging", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => JSON.stringify(redactPayload(deep))).not.toThrow();
    const wide = redactPayload({ list: Array.from({ length: 500 }, () => "x") }) as {
      list: unknown[];
    };
    expect(wide.list.length).toBeLessThanOrEqual(50);
  });
});
