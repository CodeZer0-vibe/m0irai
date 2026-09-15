# Packet-10 Architecture Decision Records

Each ADR documents one decision with **Context / Decision / Consequences**. ADRs are immutable once accepted — superseding decisions create a new ADR that supersedes the old one. This is a contract between the design phase and the build phase: the builder MUST NOT relitigate a decision in code without first proposing a superseding ADR.

| #   | Title                                                                       | Status   |
| --- | --------------------------------------------------------------------------- | -------- |
| 001 | ULID for all generated IDs                                                  | Accepted |
| 002 | JSON Schema bundle in `.zer0/SCHEMA.json` (NOT MCP server)                  | Accepted |
| 003 | Append-only `events` and `errors` tables                                    | Accepted |
| 004 | `state.json` is a CACHE, SQLite is TRUTH                                    | Accepted |
| 005 | External-first observability (not external-fallback)                        | Accepted |
| 006 | Logger AUGMENTATION (not replacement)                                       | Accepted |
| 007 | 5 standalone diagnostic `.mjs` scripts (not single `zer0 diagnose` command) | Accepted |
| 008 | Diagnostic scripts MUST NOT import `src/evidence/db.ts`                     | Accepted |
| 009 | Defer self-healing automation to packet-12                                  | Accepted |
| 010 | Defer MCP server to packet-13                                               | Accepted |
| 011 | Datadog/Sentry-style error fingerprinting                                   | Accepted |
| 012 | W3C TraceContext columns now, OpenTelemetry SDK in packet-11                | Accepted |

**How the builder uses these:** when implementing a packet-10 file, if the design implied by the brief seems ambiguous or arbitrary, find the relevant ADR. The ADR resolves the ambiguity. If no ADR covers it, output `[BLOCKED: design decision not in ADRs — escalate]`.
