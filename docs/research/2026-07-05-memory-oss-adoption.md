# Build-vs-buy: adopt an existing OSS memory solution? — NO (finish ours); two pieces earmarked

Research locked 2026-07-05 (operator-directed: "check github repos or open-source solutions,
ask codex and gemini to research"). Three dispatches: codex repo-level audit (read the actual
READMEs/pyprojects/package.jsons/licenses), gemini ecosystem sweep, gemini MCP+embeddings
sweep. Cross-checked; two gemini claims were overturned by codex's repo evidence (noted below —
the standing fabrication pattern, cross-check mandatory).

## The four kill-constraints (zer0's non-negotiables)

1. Fully local, ZERO provider API keys (subscription-first — the product never holds a key).
2. Embeddable in a Node/TS Windows CLI — no Python daemon, no Docker, no Postgres.
3. Apache-2.0-compatible license.
4. Composable with the sealed semantics: transcript digest, exactly-once watermark,
   reconciler-verified facts, regenerated projections.

## Verdicts (codex repo audit, gemini corroboration)

| Candidate                                   | Verdict                       | Killed by                                                                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mem0 (mem0ai/mem0)                          | DEAD for import               | TS SDK depends on `openai`; extraction LLM + embeddings default to OpenAI; OpenMemory MCP being sunset, Docker + OPENAI_API_KEY quickstart. STEAL-THE-DESIGN: add-only facts, hybrid semantic/BM25/entity, temporal ranking.                           |
| Letta / MemGPT                              | DEAD                          | Python ≥3.11 server (+ Postgres/Docker); Node is a thin client; SDK quickstart wants a hosted API key.                                                                                                                                                 |
| Zep + Graphiti                              | DEAD                          | Python + a graph backend daemon (Neo4j/FalkorDB/Kuzu); defaults to OpenAI; docs warn local models fail its extraction schemas. STEAL-THE-DESIGN: temporal validity windows, episode provenance.                                                        |
| cognee                                      | DEAD                          | GEMINI OVERTURNED: gemini called it "viable native TS graph-memory library"; codex read the repo — the TS package is a CLIENT, the engine is Python and usage starts with `LLM_API_KEY`.                                                               |
| txtai                                       | DEAD                          | Python framework; JS binding is API-client only; full install pulls torch/faiss.                                                                                                                                                                       |
| LangGraph memory (JS)                       | Not worth importing           | Pure TS/MIT and embeddable, but it's interfaces + checkpointers — the extraction/storage logic (the hard part we already built) is left to the developer. Importing scaffolding we've outgrown.                                                        |
| MCP official memory server                  | STEAL-THE-DESIGN              | Truly local/keyless TS, BUT storage is a JSONL entity graph with substring search + full-file rewrites — no SQLite/FTS/watermark/provenance. Useful as an API-shape reference; see "MCP exposure" below.                                               |
| sqlite-vec                                  | **ADOPT-A-PIECE (earmarked)** | Pure C SQLite extension, Node bindings, better-sqlite3-compatible, Windows, MIT/Apache dual. Pre-v1 maturity risk. The blessed vector path INSIDE our one DB file.                                                                                     |
| LanceDB (Node)                              | Pass                          | Solid, Windows-native, Apache-2.0 — but a SECOND storage engine beside better-sqlite3; splits persistence, fights the projections/journal semantics. Only if we outgrow SQLite.                                                                        |
| fastembed-js                                | DEAD                          | GEMINI OVERTURNED: gemini recommended it as "heavily maintained by Qdrant"; codex found the repo ARCHIVED 2026-01-15. Maintenance-dead.                                                                                                                |
| @huggingface/transformers (transformers.js) | **ADOPT-A-PIECE (earmarked)** | Apache-2.0, local ONNX inference in Node, can pin a local model path (no remote fetch). The embedder for the future semantic-recall unit. Small quantized MiniLM ≈ 22MB; per-entry CPU cost needs a Windows microbench before committing (UNVERIFIED). |
| onnxruntime-node                            | ADOPT-A-PIECE (underneath)    | MIT, Windows x64/arm64 prebuilt CPU. The runtime under the embedder, not a memory solution.                                                                                                                                                            |

## The decision (unanimous across all three dispatches)

**Do not import a framework. Finish the custom layer** (briefing composition, recall pulls,
native-session carry). Every full framework fails no-key/no-daemon on Windows Node, or would
force rebuilding our exact semantics (verified facts, exactly-once digest, projections) around
its model. Codex, verbatim: "There is no candidate where importing beats finishing the
remaining ~3 units."

## The earmarked upgrade path (post-dogfood, 0.2-class)

FTS5 hybrid now (built) → IF the operator's memory-week recall misses are paraphrase-shaped:
`sqlite-vec` inside the existing better-sqlite3 file + `@huggingface/transformers` with a small
local ONNX embedding model (~22MB). Microbench cold-start + per-entry CPU on Windows FIRST.
Decision rule logged in findings 2026-07-05.

## MCP exposure (future option, not scheduled)

All three CLIs can consume the same local stdio MCP server today (per-CLI config verified:
`claude mcp add` / `codex mcp add` → config.toml / gemini settings). No documented
claude+codex+gemini shared-memory setup exists in the wild (UNVERIFIED absence — consistent
with the moat). The interesting inversion for post-0.1: zer0 EXPOSES its journal as a local
MCP memory server, so native agent sessions pull memory via their own tool call rather than
prompt injection — composes with the native-persistent-sessions architecture (MT7). Parked.
