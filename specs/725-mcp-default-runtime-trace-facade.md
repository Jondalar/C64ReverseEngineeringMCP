# Spec 725 — MCP Default Runtime + Trace Facade

**Status:** DONE (2026-05-29) — tier-tools promotes the §3.7/3.8/3.9 facades to
default (default=73, cap 80); 31 facade descriptions rewritten capability-first;
probe-tool-surface reworked (dropped "no runtime_* in default", added the
facade-required positive guard + drive-only/diagnose negative guard). vice_* +
runtime_drive_* + maintenance stay advanced. build + probe-tool-surface 18/18 +
probe-single-path 25/25 GREEN. No emulator/UI change.  
**Owner:** MCP server / tool surface  
**Source:** `docs/llm-human-c64re-swimlane.md`  
**Purpose:** expose the tools an external LLM needs to run the C64RE workflow without enabling the full 271-tool debug surface.

## 1. Problem

Spec 722 made the MCP default surface small, but it overcorrected: the current default set is mostly static analysis + knowledge. That blocks the actual product workflow.

The product vision requires the LLM to do both:

- static project work: extract, inspect, disassemble, annotate, persist findings;
- runtime work: start Headless, mount media, type/joystick, run, render, checkpoint, inspect, trace, query DuckDB.

Therefore `runtime_*` and `trace_store_*` are not automatically advanced. Raw runtime internals stay advanced, but the curated Headless Runtime + TraceDB facade must be visible by default.

## 2. Rule

Default MCP surface = normal LLM project workflow.

That includes:

1. Agent/workflow tools.
2. Project knowledge tools.
3. Media extraction tools.
4. Static analysis/disassembly tools.
5. Headless Runtime facade.
6. Monitor/frozen-inspect facade.
7. TraceDB/evidence query facade.

Advanced MCP surface = rare/debug/oracle/maintenance.

That includes:

- all `vice_*`;
- drive-only debug tools;
- maintenance/backfill/dedupe/repair/bulk;
- legacy/runtime mode switches;
- raw scenario batch/debug tools;
- low-level format forensic tools unless promoted explicitly later.

## 3. Default Tool Set

### 3.1 Agent / Workflow

Keep default:

- `agent_onboard`
- `c64re_whats_next`
- `agent_propose_next`
- `agent_record_step`
- `agent_set_role`
- `project_status`
- `get_project_profile`
- `start_re_workflow`
- `run_prg_reverse_workflow`

### 3.2 Project Knowledge

Keep default:

- `list_artifacts`
- `list_payloads`
- `list_findings`
- `list_open_questions`
- `list_entities`
- `list_flows`
- `read_artifact`
- `get_artifact_lineage`
- `save_finding`
- `save_entity`
- `save_open_question`
- `propose_annotations`
- `import_annotations_as_findings`
- `link_payload_to_asm`
- `link_entities`
- `ram_report`

### 3.3 Media / Extraction

Keep default:

- `inspect_disk`
- `extract_disk`
- `extract_crt`
- `disk_sector_allocation`

### 3.4 Static Analysis / Disassembly

Keep default:

- `analyze_prg`
- `disasm_prg`
- `disasm_menu`
- `inspect_address_range`
- `assemble_source`
- `c64ref_lookup`

### 3.5 Views / Docs

Keep default:

- `build_all_views`
- `build_project_dashboard`
- `build_memory_map`
- `build_annotated_listing_view`
- `render_docs`

### 3.6 Depack Facade

Keep default:

- `suggest_depacker`
- `try_depack`

### 3.7 Headless Runtime Facade

Promote to default:

- `runtime_session_start`
- `runtime_session_status`
- `runtime_session_run`
- `runtime_session_snapshot`
- `runtime_media_browse`
- `runtime_media_mount`
- `runtime_media_unmount`
- `runtime_media_swap`
- `runtime_type`
- `runtime_joystick`
- `runtime_load_prg`
- `runtime_render_screen`

These are the LLM's normal way to run the product runtime. Do not require the LLM to use the V3 WebSocket server for these operations.

### 3.8 Monitor / Inspect Facade

Promote to default:

- `runtime_monitor_registers`
- `runtime_monitor_memory`
- `runtime_monitor_disasm`
- `runtime_step_into`
- `runtime_step_over`
- `runtime_until`
- `runtime_resolve_pc`
- `runtime_vic_inspect_at`

These are normal agent tools for understanding live or frozen execution state.

### 3.9 TraceDB / Evidence Facade

Promote to default:

- `runtime_query_events`
- `runtime_swimlane_slice`
- `runtime_trace_taint`
- `runtime_follow_path`
- `runtime_profile_loader`
- `trace_store_info`
- `trace_store_query`
- `trace_store_top_pcs`
- `trace_store_bus_find`
- `trace_store_anchor_list`
- `trace_store_anchor_find`

These are normal agent tools for durable runtime evidence. DuckDB trace is a product feature, not an internal debug escape hatch.

## 4. Explicitly Advanced

Keep advanced:

- every `vice_*` tool;
- every `runtime_drive_*` and `runtime_drive_session_*` tool;
- `runtime_diagnose_mm`;
- scenario batch/debug tools unless a later workflow promotes a small scenario facade;
- input-config/vicerc tools;
- audio/video export tools unless a later UI/export spec promotes them;
- maintenance/backfill/dedupe/repair/register/bulk/sandbox tools;
- G64/format-forensic tools not used by the normal workflow.

## 5. Implementation Tasks

1. Update `src/server-tools/tier-tools.ts`.
   - Add the tools from §3.7, §3.8 and §3.9 to `DEFAULT_TOOLS`.
   - Raise `DEFAULT_TIER_CAP` from 45 to a documented cap large enough for the facade. Use `80`.
   - Update comments: default is not "static only"; default is "normal project workflow including Headless runtime and TraceDB evidence".

2. Rewrite descriptions for newly default tools.
   - No `Spec NNN`.
   - First sentence says capability.
   - Include "Use when ..." and "Not for ..." or "use ... instead".
   - Do not expose old mode language: no fast-trap, no real-kernal, no lockstep, no legacy CPU/drive.

3. Update `scripts/probe-tool-surface.mjs`.
   - Remove the guard `no runtime_* in default`.
   - Add positive guards:
     - required Headless Runtime facade tools are default;
     - required Monitor/Inspect facade tools are default;
     - required TraceDB/Evidence facade tools are default.
   - Keep negative guards:
     - no `vice_*` in default;
     - no `headless_*` in default;
     - no `runtime_drive_*` or `runtime_drive_session_*` in default;
     - no maintenance/backfill/dedupe/repair/bulk/sandbox in default;
     - no old runtime mode switches or lockstep inputs.

4. Refresh the tool-surface inventory docs.
   - `docs/tool-surface-inventory.json`
   - `docs/tool-surface-inventory.md`
   - `docs/tool-surface-classification.md` if it still says runtime is advanced by default.

5. Update Spec 722 status text.
   - Mark the old "no runtime in default" result as superseded by this spec.
   - State that the default facade includes Headless Runtime + TraceDB.

## 6. Gates

Run only surface/build gates. Do not run runtime proof for this change; no emulator behavior should change.

Required:

```sh
npm run build:mcp
node scripts/probe-tool-surface.mjs
node scripts/probe-single-path.mjs
```

Optional, only if a tool handler is edited beyond description/tier wiring:

```sh
node scripts/smoke-runtime-mcp.mjs
```

Do not run the 7-game runtime proof unless runtime implementation code changes.

## 7. Acceptance

Pass when:

- MCP default surface includes runtime session, monitor/inspect and trace query facade tools.
- MCP default surface does not include VICE, drive-only debug, maintenance or legacy-mode tools.
- Default tool descriptions are capability-first and contain no spec numbers.
- `C64RE_FULL_TOOLS=1` still exposes the full advanced surface.
- A fresh external LLM can execute the swimlane in `docs/llm-human-c64re-swimlane.md` without using WebSocket directly and without enabling `C64RE_FULL_TOOLS`.

## 8. Prompt For Implementation Session

```text
Implement Spec 725.

Goal: expose the MCP default tool surface required by docs/llm-human-c64re-swimlane.md.

Do not change emulator/runtime behavior. Do not expose VICE by default. Do not use C64RE_FULL_TOOLS as the solution.

Tasks:
1. Update src/server-tools/tier-tools.ts:
   - Default must include the curated Headless Runtime, Monitor/Inspect, and TraceDB/Evidence facade tools from Spec 725 §3.7-§3.9.
   - Raise DEFAULT_TIER_CAP to 80.
   - Keep vice_*, runtime_drive_*, runtime_drive_session_*, maintenance/bulk/debug internals advanced.

2. Rewrite descriptions for every newly-default runtime/trace tool:
   - capability-first;
   - no Spec NNN;
   - include Use-trigger and Not-for/use-instead guidance;
   - no fast-trap/real-kernal/lockstep/legacy wording.

3. Update scripts/probe-tool-surface.mjs:
   - remove "no runtime_* in default";
   - add positive guards for required runtime, monitor/inspect and trace facade tools;
   - keep negative guards for vice/headless/drive-only/maintenance/legacy-mode exposure.

4. Refresh docs/tool-surface-inventory.json, docs/tool-surface-inventory.md and any stale 722/classification text that still says runtime is advanced-only.

Gates:
   npm run build:mcp
   node scripts/probe-tool-surface.mjs
   node scripts/probe-single-path.mjs

No runtime:proof unless runtime implementation code changes.

Report:
- default tool count;
- full tool count;
- list of newly default runtime/trace tools;
- confirmation that vice_* remains advanced-only;
- gate results.
```
