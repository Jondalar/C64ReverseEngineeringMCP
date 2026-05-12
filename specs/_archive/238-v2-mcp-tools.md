# Spec 238 — V2 MCP tool layer

**Sprint:** 133
**Status:** PHASE-A DONE 2026-05-09 — 14 V2 `runtime_*` MCP tools
shipped in src/server-tools/runtime.ts, registered via
`registerRuntimeTools` in src/server.ts (additive, side-by-side
with V1 `headless_*`). Wraps Spec 237 AgentQueryApi facade.
Headless-over-VICE framing in every tool description. Smoke
`scripts/smoke-runtime-mcp.mjs` — **19/19 PASS** (registration
checks + 4 handler invocations on real session).

**V1 hard-cut deferred to V2.1 cleanup sprint (Phase B).**
Reasoning: removing `headless_*` requires migrating
agent-orchestrator phase-tools + all probe scripts + internal
callers. Decoupled from this sprint to keep V2 ship scope.

V2 tool catalog (Phase A):
runtime_monitor_registers / memory / disasm; runtime_step_into /
step_over / until; runtime_breakpoint_add / list / remove;
runtime_save_vsf / load_vsf; runtime_resolve_pc; runtime_status;
runtime_diff_snapshots.

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

## V1 tool removal (HARD CUT, E3 RESOLVED 2026-05-08)

V2 tools land + V1 tools removed in the same sprint. No grace
period, no `@deprecated` markers. No productive external users
exist. Migration of internal callers (scripts, smoke tests, agent
flows) is atomic part of the V2 implementation.

Removed:

- `headless_session_*` → `runtime_run_scenario` + `runtime_replay_until`
- `headless_integrated_session_*` → V2 surface
- `headless_trace_*` → `runtime_query_events`
- `headless_breakpoint_*` / `headless_watch_*` → `runtime_breakpoint_*`
- `headless_monitor_memory` / `headless_monitor_registers` →
  `runtime_monitor_memory` / `runtime_monitor_registers`
  (kept-but-renamed under V2 namespace).

Acceptance includes "all V1 tool call-sites in repo migrated" check.

## Acceptance

- All 10 V2 tools registered + schema-validated.
- Tool round-trip <500ms for typical 1000-event slice queries.
- E2E demo: agent uses ONLY V2 tools to debug a synthetic
  divergence and produces a finding + open-question chain.
- V1 tools still functional; no breakage.

## Out-of-scope

- V1 tool removal (= Sprint 130 cleanup).
- UI integration (V3).
