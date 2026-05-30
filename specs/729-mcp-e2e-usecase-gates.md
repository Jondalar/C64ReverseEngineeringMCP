# Spec 729 — MCP End-to-End Use-Case Gates

**Status:** PARTIAL (2026-05-30) — initial harnesses GREEN; trace gates PENDING
on 726 reader/writer alignment.  
**Owner:** MCP workflow QA  
**Depends on:** Specs 727, 728, 725, 726  
**Source:** `docs/llm-human-c64re-swimlane.md`

## Status — 2026-05-30

Shipped + GREEN (`npm run check:mcp-product-surface`):

- `scripts/e2e-mcp-tool-boundaries.mjs` (E2E-F/G) — 8/8. Product facade is
  default; `vice_*` / `runtime_drive_*` / maintenance excluded from default
  and from every normal playbook.
- `scripts/e2e-mcp-path-portability.mjs` (E2E-H) — 7/7. No default tool is
  `repo-dev-only` / `broken-cwd-coupled`; no silent cwd-default / ungated
  repo-samples scan in `workspace-ui`.
- `scripts/e2e-mcp-project-inventory.mjs` (E2E-A) — 16/16. Boots the REAL MCP
  server over stdio with the default surface (no `C64RE_FULL_TOOLS`) against a
  temp project OUTSIDE the repo; asserts tier gating + runs
  `project_init → agent_onboard → start_re_workflow → save_finding →
  list_findings → project_status → build_project_dashboard → analyze_prg`
  end-to-end. **Found + fixed a real gap:** `project_init` was advanced-tier,
  so a default LLM could not start a fresh project — promoted to default.

PENDING (depend on Spec 726 reader/writer schema alignment):

- E2E-B (`e2e-mcp-trace-first`), E2E-I (`smoke-trace-store-writer-reader-e2e`),
  E2E-C trace half, E2E-D trace-provenance half. They require the convenience
  readers to consume the live-writer `trace_run`/`trace_event`/`trace_mark`
  schema (not `meta`/`instructions`, not a raw-SQL workaround). Built next
  alongside the 726 alignment fix; not stubbed green.
- E2E-E (change/validation) stays expected-PENDING until Spec 711 code-overlay
  tooling lands (documented, not faked).

## 0. Hard Path-Portability Rule

Every E2E gate must run from a temporary directory outside the C64RE development
repo, using explicit project/media/trace paths.

The product requirement is:

```text
LLM can call MCP from any folder
LLM can say "I have this .d64/.crt/.duckdb here"
MCP tools open that artifact through project/absolute path resolution
no default workflow silently falls back to repo samples or cwd
```

Any default-tool E2E gate that only passes from the repo root is a failure.

## 1. Purpose

Prove the MCP default surface works as a product workflow. Unit-level tool
registration is not enough. The tool surface is accepted only when the main
LLM-human use-cases can be executed end-to-end with default tools.

These gates are workflow gates, not emulator fidelity gates. They should stay
small and fast.

## 2. Gate Principles

1. Use only default tools unless the use-case is explicitly advanced.
2. Do not use V3 WebSocket directly.
3. Do not set `C64RE_FULL_TOOLS=1`.
4. Persist findings/artifacts instead of relying on console text.
5. Keep fixtures tiny and deterministic.
6. Do not run the seven-game runtime proof unless runtime behavior changes.

## 3. Required E2E Gates

### 3.1 E2E-A — New Project + Media Inventory

Proves:

- an LLM can enter a project;
- the project may live outside the C64RE repo;
- media paths may be absolute or project-relative;
- inspect/extract media;
- register artifacts/findings;
- build a dashboard.

Default tools involved:

- `agent_onboard`
- `project_status`
- `start_re_workflow`
- `inspect_disk`
- `extract_disk`
- `extract_crt`
- `list_payloads`
- `save_finding`
- `build_project_dashboard`

### 3.2 E2E-B — Trace-First Runtime Discovery

Proves:

- an LLM can start Headless;
- mount media from an arbitrary user/project path;
- run/type/joystick;
- write a durable `trace.duckdb` to a project-relative or absolute path;
- mark phases;
- query trace rows;
- save a finding.
- reader wrappers consume the exact schema written by the live trace writer.

Default tools involved:

- `runtime_session_start`
- `runtime_media_mount`
- `runtime_type`
- `runtime_joystick`
- `runtime_session_run`
- `runtime_render_screen`
- `runtime_mark`
- `runtime_trace_finalize`
- `trace_store_info`
- `trace_store_top_pcs`
- `trace_store_bus_find`
- `runtime_query_events`
- `runtime_swimlane_slice`
- `save_finding`

This gate depends on Spec 726.

It fails if the writer creates `trace_run` / `trace_event` / `trace_mark` but
any convenience reader still queries old `meta` or `instructions` tables. Raw
`trace_store_query` success alone is not enough.

### 3.3 E2E-C — Disassembly-First + Trace Validation

Proves:

- static analysis can run first;
- later trace validates executed PCs and memory access;
- annotations/finding get evidence references.

Default tools involved:

- `analyze_prg`
- `disasm_prg`
- `runtime_session_start`
- `runtime_session_run`
- `runtime_mark`
- `runtime_trace_finalize`
- `trace_store_query`
- `runtime_resolve_pc`
- `propose_annotations`
- `save_finding`

### 3.4 E2E-D — Frozen Visual Inspect To Knowledge

Proves:

- a screen state can be captured;
- a pixel/cell can be resolved to VIC/RAM evidence;
- the evidence can be recorded and linked.

Default tools involved:

- `runtime_session_snapshot`
- `runtime_render_screen`
- `runtime_vic_inspect_at`
- `runtime_monitor_memory`
- `save_entity`
- `save_finding`
- `link_entities`

### 3.5 E2E-E — Change / Validation Loop

Proves:

- the workflow can record an intended change;
- run or trace after change;
- record result and next action.

Until Spec 711 code-overlay tools land, this gate may use a documented
lightweight fixture/intervention or stay expected-PENDING. It must not pretend
patch tooling exists if it does not.

### 3.6 E2E-F — VICE Is Internal-Dev-Only

Proves:

- no `vice_*` tool is visible in default;
- no normal product playbook requires `vice_*`;
- VICE descriptions say internal-dev-only oracle;
- external/default MCP workflows never suggest VICE as fallback.

### 3.7 E2E-G — Operator Tools Are Not Workflow Tools

Proves:

- maintenance/backfill/dedupe/bulk tools are not default;
- normal playbooks do not require them.

### 3.8 E2E-H — Path Portability

Proves:

- MCP is launched or called with a project outside the repo;
- `.d64`, `.crt`, `.prg` and `.duckdb` paths resolve correctly;
- no default workflow reads repo `samples/` unless explicitly passed;
- errors mention the requested path, not a hidden fallback.

Default tools involved:

- `agent_onboard`
- `inspect_disk`
- `extract_disk`
- `extract_crt`
- `runtime_session_start`
- `runtime_media_mount`
- `trace_store_info`

### 3.9 E2E-I — Trace Writer/Reader Schema Contract

Proves:

- a real 726-written `trace.duckdb` is readable through convenience wrappers;
- no product flow depends on raw SQL as a workaround;
- old Spec-217 schema names are gone from wrapper queries.

Fixture:

```text
/Users/alex/Development/C64/Cracking/Murder/traces/smoke/trace.duckdb
run_id = run_live-capture_mprewdk9
```

Required assertions:

- `trace_store_info` succeeds.
- `trace_store_top_pcs cpu=c64` returns PCs.
- `runtime_query_events family=cpu pc_start=$E5CD pc_end=$E5CD` returns at least
  one event when that PC exists.
- source grep or query-builder audit finds no `FROM meta` or
  `FROM instructions` in active trace-reader wrappers.

## 4. Scripts

Implement:

- `scripts/e2e-mcp-project-inventory.mjs`
- `scripts/e2e-mcp-trace-first.mjs`
- `scripts/e2e-mcp-disasm-trace-validation.mjs`
- `scripts/e2e-mcp-frozen-inspect.mjs`
- `scripts/e2e-mcp-tool-boundaries.mjs`
- `scripts/e2e-mcp-path-portability.mjs`
- `scripts/smoke-trace-store-writer-reader-e2e.mjs`

The scripts may call tool handlers in-process or boot a local MCP harness, but
they must use the same default tool gate as production.

## 5. Acceptance Gate

Add:

```sh
npm run check:mcp-product-surface
```

It runs:

```sh
npm run build:mcp
node scripts/probe-tool-surface.mjs
node scripts/probe-mcp-tool-usecase-matrix.mjs
node scripts/probe-mcp-llm-playbooks.mjs
node scripts/e2e-mcp-tool-boundaries.mjs
node scripts/e2e-mcp-project-inventory.mjs
node scripts/e2e-mcp-trace-first.mjs
node scripts/e2e-mcp-disasm-trace-validation.mjs
node scripts/e2e-mcp-frozen-inspect.mjs
node scripts/e2e-mcp-path-portability.mjs
node scripts/smoke-trace-store-writer-reader-e2e.mjs
```

If Spec 726 has not landed, the trace gates must be explicitly marked
PENDING with a clear missing tool reason. They must not silently skip.

## 6. Reporting

Each E2E gate reports:

- tools used;
- artifacts/findings created;
- trace/checkpoint paths if applicable;
- next action proposed;
- any advanced tool usage.

Any advanced tool usage in a default E2E gate is a failure unless the gate is
specifically testing advanced/oracle behavior.

## 7. Acceptance

The MCP product surface is accepted when a fresh LLM can execute the project
workflow end-to-end through these gates and the reports read like a coherent
C64RE product, not a collection of historical sprint tools.
