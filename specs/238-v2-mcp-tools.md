# Spec 238 — V2 MCP tool layer

**Sprint:** 129
**Status:** PROPOSED 2026-05-08
**Depends on:** 237 (agent query API)
**Master:** 230

## Goal

Replace ad-hoc `headless_*` MCP tools with V2 agent surface. Tools
return structured rows that fit `save_finding` / `save_open_question`
directly. Old tools deprecated until 240+ removal sprint.

## Tool catalog

```
runtime_inspect_routine            artifactId, entryPc → RoutineRecord
runtime_evidence_for_segment       artifactId, range  → SegmentEvidence
runtime_query_events               EventQuery         → EventRow[]
runtime_compare_with_vice          scenarioId         → DivergenceRecord | null
runtime_follow_path                PathQuery          → PathChain
runtime_swimlane_slice             SwimlaneQuery      → SwimlaneSlice
runtime_resolve_pc                 artifactId, pc     → ResolvedPc
runtime_replay_until               predicate, timeout → ReplayUntilResult
runtime_run_scenario               scenarioId         → ReplayResult
runtime_save_baseline_trace        scenarioId         → { path, hash }
```

Each tool uses MCP zod schemas, returns JSON, adheres to existing
`safeHandler` envelope (Spec 012).

## Output → finding integration

Tools that produce notable observations auto-stage findings:

- `runtime_compare_with_vice` returns DivergenceRecord. Agent
  passes it directly to `save_finding({ tags:["vice-divergence"],
  evidence:[divRecord], addressRange })`.
- `runtime_inspect_routine` output fits `save_entity({ kind:"routine",
  ... })`.
- `runtime_evidence_for_segment` output supports
  `mark_segment_confirmed` if executionCount > threshold.

## Deprecation list (V1 tools to retire)

After Spec 240+ migration:

- `headless_session_*` — replaced by `runtime_run_scenario` +
  `runtime_replay_until`.
- `headless_integrated_session_*` — replaced by V2 surface.
- `headless_trace_*` — replaced by `runtime_query_events`.
- `headless_monitor_memory` / `headless_monitor_registers` — kept
  (pure read-only, no V2 equivalent needed).
- `headless_breakpoint_*` / `headless_watch_*` — kept (debug aids).

## Acceptance

- All 10 V2 tools registered + schema-validated.
- Tool round-trip <500ms for typical 1000-event slice queries.
- E2E demo: agent uses ONLY V2 tools to debug a synthetic
  divergence and produces a finding + open-question chain.
- V1 tools still functional; no breakage.

## Out-of-scope

- V1 tool removal (= Sprint 130 cleanup).
- UI integration (V3).
