# Spec 123 — Headless M5.2: Event-Indexed Search

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 5, story M5.2
Depth: light
Predecessors: Spec 122 (M5.1)

## Motivation

A trace JSONL is a sequence of events. Agents need fast lookup by
PC, address read/write, IEC edge, raster line, IRQ, drive command,
GCR sync, byte-ready, and screen change.

## Acceptance

- Index builder over a trace JSONL: emits `<trace>.idx` with per-key
  offset lists.
- CLI: `npm run trace:find -- --trace=<path> --pc=$ee13`
  returns matching events with byte offsets.
- MCP tool `headless_trace_find_event` mirrors the CLI.
- Smoke: build index over a synthetic LOAD trace, query by PC, return
  ≥ 1 hit.

## Deliverables

- NEW `src/runtime/headless/trace/event-index.ts`
- NEW `scripts/trace-find.mjs`
- NEW MCP tool `headless_trace_find_event`
- Smoke fixtures.

## Dependencies

- Spec 122.

## Risks

- Index size on long traces. Mitigation: chunked indexes per N
  events; query merges chunk results.
- Index format drift. Mitigation: version field; rebuild on mismatch.

## Out of scope

- Full-text search across trace metadata.
- Distributed index across machines.
