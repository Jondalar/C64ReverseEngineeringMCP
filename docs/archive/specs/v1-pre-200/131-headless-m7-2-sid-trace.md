# Spec 131 — Headless M7.2: SID Trace

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 7, story M7.2
Depth: light
Predecessors: Spec 130, Spec 122

## Motivation

SID writes carry music init/play structure. Logging them with PC and
cycle attribution lets agents identify init and play routines without
audio.

## Acceptance

- Trace channel `sid_writes` (Spec 122) records every SID write with
  `{ cycle, pc, addr, value }`.
- Analysis tool `analyze_sid_writes` reads the trace, identifies init
  vs play routine clusters by PC frequency.
- Smoke: synthetic SID-poll fixture produces an expected write
  sequence.

## Deliverables

- EDIT `src/runtime/headless/c64/sid.ts` (publish writes to channel)
- NEW MCP tool `analyze_sid_writes`
- Smoke fixtures.

## Dependencies

- Spec 130.
- Spec 122.

## Risks

- Heuristic init/play detection can misattribute. Mitigation:
  confidence score on output; document the heuristic.

## Out of scope

- Music decoding.
- SID file generation.
