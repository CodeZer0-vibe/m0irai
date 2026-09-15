/**
 * @file src/chat/ui.test.ts
 * @purpose Tests terminal rendering helpers by capturing process.stdout/stderr writes.
 * @exports (none)
 * @depends vitest, figures, ./ui
 */
import figures from "figures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEventBus, type RouteClassifiedEvent } from "./events.js";
import type { ChatMode } from "./types.js";
import {
  attachTurnUi,
  printAgentChunk,
  printAgentDone,
  printAgentError,
  printAgentFailed,
  printAgentLabel,
  printBuildCard,
  printChatError,
  printChatStatus,
  printCouncilDispatch,
  printCouncilProgress,
  printPick,
  printSessionInfo,
} from "./ui.js";

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
let priorNoColor: string | undefined;

/**
 * Replaces a stream's `write` with a sink that records every chunk as a string.
 * Recording into an external array avoids depending on the spy's overloaded type.
 */
function captureWrites(stream: NodeJS.WriteStream, sink: string[]): void {
  vi.spyOn(stream, "write").mockImplementation((chunk: unknown): boolean => {
    sink.push(String(chunk));
    return true;
  });
}

beforeEach(() => {
  // Disable color so emitted strings are deterministic (yoctocolors no-ops under NO_COLOR
  // and ui.ts shouldColor() short-circuits regardless of TTY).
  priorNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  captureWrites(process.stdout, stdoutChunks);
  captureWrites(process.stderr, stderrChunks);
});

afterEach(() => {
  if (priorNoColor === undefined) {
    process.env.NO_COLOR = undefined;
  } else {
    process.env.NO_COLOR = priorNoColor;
  }
  vi.restoreAllMocks();
});

function stdoutText(): string {
  return stdoutChunks.join("");
}

function stderrText(): string {
  return stderrChunks.join("");
}

describe("printAgentLabel", () => {
  it("writes the agent name in brackets surrounded by newlines", () => {
    printAgentLabel("claude");

    expect(stdoutText()).toBe("\n[claude]\n");
  });

  it("appends a suffix segment when provided", () => {
    printAgentLabel("codex", "workspace-write");

    expect(stdoutText()).toBe("\n[codex] workspace-write\n");
  });
});

describe("printAgentChunk", () => {
  it("writes the raw chunk to stdout without decoration", () => {
    printAgentChunk("codex", "partial token stream");

    expect(stdoutText()).toBe("partial token stream");
    expect(stderrText()).toBe("");
  });
});

describe("printAgentError", () => {
  it("writes the error chunk to stderr, not stdout", () => {
    printAgentError("gemini", "something failed\n");

    expect(stderrText()).toBe("something failed\n");
    expect(stdoutText()).toBe("");
  });
});

describe("printAgentDone", () => {
  it("renders the done glyph, agent, and seconds to one decimal (incl sub-second)", () => {
    printAgentDone("claude", 2500);
    expect(stdoutText()).toBe(`\n${figures.tick} claude done (2.5s)\n`);

    stdoutChunks.length = 0;
    printAgentDone("codex", 450);
    expect(stdoutText()).toBe(`\n${figures.tick} codex done (0.5s)\n`);
  });
});

describe("printAgentFailed", () => {
  it("renders the cross glyph with the failing exit code", () => {
    printAgentFailed("gemini", 137);

    expect(stdoutText()).toBe(`\n${figures.cross} gemini failed (exit 137)\n`);
  });
});

describe("printChatStatus", () => {
  it("prefixes the info glyph and terminates with a newline on stdout", () => {
    printChatStatus("session resumed");

    expect(stdoutText()).toBe(`${figures.info} session resumed\n`);
  });
});

describe("printChatError", () => {
  it("prefixes the cross glyph and writes to stderr", () => {
    printChatError("dispatch failed");

    expect(stderrText()).toBe(`${figures.cross} dispatch failed\n`);
    expect(stdoutText()).toBe("");
  });
});

describe("printCouncilDispatch", () => {
  it("reports the dispatched-agent count (incl zero for an empty list)", () => {
    printCouncilDispatch(["claude", "codex", "gemini"]);
    expect(stdoutText()).toBe("\n[council] 3 agents dispatched...\n");

    stdoutChunks.length = 0;
    printCouncilDispatch([]);
    expect(stdoutText()).toBe("\n[council] 0 agents dispatched...\n");
  });
});

describe("printCouncilProgress", () => {
  it("uses the tick glyph for a done agent", () => {
    printCouncilProgress("claude", "done");

    expect(stdoutText()).toBe(`├─ ${figures.tick} claude\n`);
  });

  it("uses the cross glyph for a failed agent", () => {
    printCouncilProgress("codex", "failed");

    expect(stdoutText()).toBe(`├─ ${figures.cross} codex\n`);
  });

  it("uses the ellipsis glyph for a running agent", () => {
    printCouncilProgress("gemini", "running");

    expect(stdoutText()).toBe(`├─ ${figures.ellipsis} gemini\n`);
  });
});

describe("printSessionInfo", () => {
  it("renders the session id and message count", () => {
    printSessionInfo("chat-abc123", 5);

    expect(stdoutText()).toBe("Session: chat-abc123 (5 messages)\n");
  });
});

function routeClassified(mode: ChatMode, reason: string, turn = 0): RouteClassifiedEvent {
  return { kind: "route.classified", mode, reason, turn };
}

describe("printBuildCard", () => {
  it("renders the 3 separately-sourced fields (lane status, mergeable, on-task) for a captured lane", () => {
    printBuildCard({
      kind: "build.card",
      turn: 1,
      runId: "brun-1",
      agent: "codex",
      laneStatus: "captured",
      mergeable: true,
      onTask: "unverified",
    });

    expect(stdoutText()).toBe("[codex] captured · mergeable:yes · on-task:unverified\n");
  });

  it("renders mergeable:no for an empty lane (no artifact, never auto-acceptable)", () => {
    printBuildCard({
      kind: "build.card",
      turn: 1,
      runId: "brun-1",
      agent: "claude",
      laneStatus: "empty",
      mergeable: false,
      onTask: "unverified",
    });

    expect(stdoutText()).toBe("[claude] empty · mergeable:no · on-task:unverified\n");
  });
});

describe("printBuildCard — gemini .md card payload (BLOCK-2: render path/violation)", () => {
  // BLOCK-2: the card renderer must DISPLAY artifactPath (export path, on a gate-PASS gemini lane)
  // when present — it survives zod but was previously dropped by the renderer. INV-3d: render the
  // PATH, never the `.md` content.
  it("renders the artifact export path when artifactPath is present (gate-PASS .md lane)", () => {
    printBuildCard({
      kind: "build.card",
      turn: 1,
      runId: "brun-1",
      agent: "gemini",
      laneStatus: "captured",
      mergeable: false,
      onTask: "unverified",
      artifactPath: ".zer0/runs/r/research/l.md",
    });

    expect(stdoutText()).toBe(
      "[gemini] captured · mergeable:no · on-task:unverified · artifact:.zer0/runs/r/research/l.md\n",
    );
  });
});

describe("printBuildCard — policy violation + bare-card non-regression (BLOCK-2)", () => {
  // BLOCK-2: the card renderer must DISPLAY policyViolation (violating-entry string, on a policy-
  // rejected gemini lane) when present.
  it("renders the policy violation when policyViolation is present (policy-rejected lane)", () => {
    printBuildCard({
      kind: "build.card",
      turn: 1,
      runId: "brun-1",
      agent: "gemini",
      laneStatus: "policy-rejected",
      mergeable: false,
      onTask: "unverified",
      policyViolation: "added a .ts entry — only one docs/research/*.md is allowed",
    });

    expect(stdoutText()).toBe(
      "[gemini] policy-rejected · mergeable:no · on-task:unverified · policy:added a .ts entry — only one docs/research/*.md is allowed\n",
    );
  });

  // Non-regression: a bare card (neither new field) renders the EXACT pre-existing single line.
  it("renders the bare card unchanged when neither new field is present (non-regression)", () => {
    printBuildCard({
      kind: "build.card",
      turn: 1,
      runId: "brun-1",
      agent: "codex",
      laneStatus: "captured",
      mergeable: true,
      onTask: "unverified",
    });

    expect(stdoutText()).toBe("[codex] captured · mergeable:yes · on-task:unverified\n");
  });
});

describe("attachTurnUi build.card", () => {
  it("renders a build card when build.card is emitted on the bus", () => {
    const bus = new ChatEventBus();
    attachTurnUi(bus);

    bus.emit({
      kind: "build.card",
      turn: 0,
      runId: "brun-1",
      agent: "codex",
      laneStatus: "escaped",
      mergeable: false,
      onTask: "unverified",
    });

    expect(stdoutText()).toBe("[codex] escaped · mergeable:no · on-task:unverified\n");
  });
});

describe("printPick", () => {
  // Asserts both the exhaustive [mode] -> label mapping AND that the reason passes through verbatim
  // (the per-mode reason is distinct, proving it is not hardcoded). Subsumes the prior single-mode
  // build/all cases without assertion loss.
  it("maps every ChatMode to its label and renders the reason verbatim", () => {
    const cases: ReadonlyArray<readonly [ChatMode, string, string]> = [
      ["single", "[single]", "direct question"],
      ["all", "[asking all 3]", "opinion routed to council"],
      ["debate", "[debate]", "compare approaches"],
      ["research", "[research]", "needs sources"],
      ["build", "[build]", "leading verb 'build' is a write keyword"],
    ];
    for (const [mode, label, reason] of cases) {
      stdoutChunks.length = 0;
      printPick(routeClassified(mode, reason));
      expect(stdoutText()).toBe(`${label} — ${reason}\n`);
    }
  });
});

describe("attachTurnUi", () => {
  it("prints the pick when route.classified is emitted on the bus", () => {
    const bus = new ChatEventBus();
    attachTurnUi(bus);

    bus.emit(routeClassified("build", "write keyword"));

    expect(stdoutText()).toBe("[build] — write keyword\n");
  });

  it("renders debate events on the same bus", () => {
    const bus = new ChatEventBus();
    attachTurnUi(bus);

    bus.emit({ kind: "debate.round-start", label: "Round 1", round: 1, turn: 0 });

    expect(stdoutText()).toBe("\n[debate] Round 1\n");
  });

  it("is idempotent — re-attaching the same bus does not double-render the pick", () => {
    const bus = new ChatEventBus();
    attachTurnUi(bus);
    attachTurnUi(bus);

    bus.emit(routeClassified("research", "research request"));

    expect(stdoutText()).toBe("[research] — research request\n");
  });
});
