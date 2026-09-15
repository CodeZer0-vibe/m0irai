# ADR-012 — W3C TraceContext columns NOW, OpenTelemetry SDK in packet-11

**Status:** Accepted
**Date:** 2026-05-05
**Source:** gemini synthesis §"Adopting the OTel trace/span model is non-negotiable for interoperability... W3C TraceContext is the standard for propagation"

## Context

OpenTelemetry (OTel) is the industry standard for distributed tracing. Production observability platforms (Datadog, Honeycomb, Jaeger, Tempo, X-Ray) ingest OTel-compatible traces. The user's vision (multi-agent council, distributed dispatch across CLIs) maps perfectly onto OTel spans: each agent dispatch is a span, parent-child relationships capture causality.

But OpenTelemetry has weight:

- `@opentelemetry/api` + `@opentelemetry/sdk-node` adds ~5MB and ~30 packages
- Configuration is non-trivial (collectors, exporters, samplers)
- Workflow context propagation across Temporal activities needs careful threading
- Adds build-time cost to every diagnostic script that imports it

Two options:

1. **Ship full OTel SDK in packet-10** — heavy lift, may not be needed without an actual collector deployed
2. **Ship only the W3C TraceContext FIELDS now (`trace_id`, `span_id`, `parent_span_id`); add SDK in packet-11**

## Decision

**Ship the COLUMNS in packet-10. Defer the SDK to packet-11.**

What packet-10 ships:

- `events` table has columns `trace_id TEXT, span_id TEXT, parent_span_id TEXT` (all nullable)
- `errors` table has columns `trace_id TEXT, span_id TEXT` (nullable)
- `state.json` has optional `traceContext: { traceId, spanId }` field
- A helper `src/observability/trace-context.ts` exporting `generateTraceId()`, `generateSpanId()`, `extractFromHeaders()`, `injectToHeaders()` per W3C TraceContext spec
- These are POPULATED by activities and CLI commands using simple ULID-derived IDs (32-hex for traceId, 16-hex for spanId per W3C spec)

What packet-11 will ship:

- `@opentelemetry/api` + `@opentelemetry/sdk-node` integration
- Activity wrappers that auto-create spans
- Workflow context propagation
- Configurable exporter (default: noop; opt-in OTLP HTTP exporter for users who deploy a collector)

## Consequences

**Positive:**

- Existing data stays compatible with future OTel — IDs we generate today are valid traceId/spanId values per W3C spec
- Diagnostic agents can ALREADY trace causality via `WHERE trace_id = ?` queries
- Migration to OTel SDK in packet-11 is incremental: existing IDs remain valid, SDK just starts producing them
- No premature commitment to specific OTel collector or exporter

**Negative:**

- Span timing data not captured in packet-10 (no `startTime`/`endTime` per span) — accepted: events table has `created_at`, can derive intervals at query time
- IDs we generate today are random hex, not bound to any actual span — but they're valid TraceContext values, so semantics are preserved when packet-11 SDK takes over
- W3C TraceContext is overkill if no collector is deployed — accepted: cost is 3 nullable columns, ~30 LoC helper, no runtime impact when null

## W3C TraceContext format (locked spec)

Per W3C TraceContext §2.2 ([https://www.w3.org/TR/trace-context/](https://www.w3.org/TR/trace-context/)):

- `trace-id`: 32 hex chars, lowercase, all-zeros INVALID
- `span-id`: 16 hex chars, lowercase, all-zeros INVALID
- `traceparent` header format: `00-{trace-id}-{span-id}-{flags}` (we don't propagate via HTTP yet, but the format is locked)

`trace-context.ts:generateTraceId()` returns 32-char lowercase hex from `crypto.randomBytes(16).toString('hex')`.
`trace-context.ts:generateSpanId()` returns 16-char lowercase hex from `crypto.randomBytes(8).toString('hex')`.

A test asserts: 1000 generated trace IDs are all 32 chars, lowercase, never all-zeros, all unique.

## Why not just use ULID for trace/span IDs?

ULID is 26-char Crockford base32. W3C TraceContext is 32-char/16-char lowercase hex. Different alphabets, different lengths. Mixing would create downstream pain when packet-11 ships an OTel exporter that expects W3C-compliant IDs. Better to use the right format from day one.
