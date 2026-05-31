# Bug: Agent/audit recommends tools that are not exposed in MCP surface

- **ID:** BUG-005
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** mcp-tool
- **Severity:** blocker
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: mcp default / agent_onboard / audit / UI
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `agent_onboard`, project audit, workspace UI

## What happened

`agent_onboard`, the audit output, and the UI recommend tools that are not available to the consuming LLM in the MCP tool surface. Reported examples: `register_existing_files`, `scan_registration_delta`, `import_manifest_artifact`. Tool discovery returns no matching callable tools. The agent is instructed to call tools it cannot call, which creates a workflow dead end.

## Expected

Every recommendation shown by `agent_onboard`, audit, UI, or playbooks must point to a callable default tool, or explicitly state that it is an internal/manual maintenance action with a callable alternative. A fresh external LLM must not be sent to non-exposed tools.

## Repro steps

1. Start/resume the DDD project via MCP default surface.
2. Run `agent_onboard` and inspect audit/UI recommendations.
3. Try to locate the recommended tools in the MCP tool surface.
4. Observe that the recommended tools are not available.

Minimal command / call:

```text
agent_onboard on DDD project; inspect recommended next tools.
```

## Evidence

- Error / output (verbatim):

```text
agent_onboard + Audit + UI sagen:
register_existing_files, scan_registration_delta, import_manifest_artifact.
Keins davon in meiner MCP-Tool-Oberfläche freigegeben.
ToolSearch: "No matching deferred tools".
Agent kriegt Anweisung auf nicht-aufrufbare Tools → Sackgasse.
```

- Artifacts: DDD agent_onboard/audit output.

## Scope guess (optional)

Agent/audit recommendation layer, MCP default surface classification, project workflow docs/playbooks.

## Notes / follow-up

- This is product-critical for the LLM-first workflow.
- This is not just a missing-tool exposure bug. It is a workflow-orchestration concept issue: the MCP must own phase/step state and recommend only callable default actions, not leak internal tool names to the LLM.
- Planned resolution spec: `specs/730-mcp-workflow-step-orchestrator.md` — MCP Workflow Step Orchestrator + Project Inventory Sync.
- Expected shape: `agent_next_step` / `agent_run_step` / `project_inventory_sync` or equivalent default façade. Internal tools such as `register_existing_files`, `scan_registration_delta`, and `import_manifest_artifact` may be used internally, but must not be normal LLM instructions.
- Fix can be either exposing a proper façade or changing recommendations to existing callable tools, but the preferred product direction is a phase/step orchestrator owned by MCP.
- No workaround via `C64RE_FULL_TOOLS` for normal product flow.

---

## Resolution

- **Root cause:** the MCP had no phase/step orchestrator, so the recommendation
  surfaces (`agent_onboard`, project audit, UI registration banner, dashboard
  focus text) named the *internal maintenance action* directly —
  `register_existing_files`, `scan_registration_delta`, `import_manifest_artifact`
  — instead of a callable product facade. Those tools are `advanced` tier, not in
  the default surface, so a default-surface LLM was sent to a tool it cannot call
  → workflow dead end. It was a workflow-orchestration concept gap, not a missing
  tool exposure.
- **Fix:** Spec 730 MCP Workflow Step Orchestrator.
  - `project_inventory_sync` default facade wraps register/import/rebuild; the
    internal helpers stay advanced and are called only inside the facade.
  - `agent_next_step` (deterministic §5.2 ladder over a typed workflow model) +
    `agent_run_step` own phase/step state and recommend ONLY callable default
    tools; internal tools appear only in `do_not_call`.
  - Every recommendation surface (onboard, audit, UI banner, playbooks, dashboard)
    rewritten to the facade — audit found ZERO remaining leakage.
  - `agent_next_step` emits a machine-readable JSON block
    (`phase, step, reason, primary_action{tool,args,label}, secondary_actions[],
    blocked_by[], human_question?, ui_hint?, do_not_call[]`) so the LLM parses a
    structured callable next-action instead of scraping prose.
- **Fix commits:** Spec 730 series `6de615e`…`2b4d9ca` (orchestrator + facades +
  recommendation rewrite) + the machine-readable shape commit (this slice).
- **Gate proving the fix:**
  - `e2e-mcp-step-loop` (31/31) — live MCP stdio, default surface, external
    project: fresh→`project-init`, loose files→`inventory-sync` facade, run-step,
    advance past inventory; machine shape required-fields + `primary_action.tool`
    callable + no internal in primary/secondary + `ui_hint` + no dead end.
  - `e2e-mcp-no-internal-recommendations` (10/10) — scans onboard/audit/UI
    banner/playbooks/tool descriptions; forbidden names only inside `do_not_call`.
  - `e2e-mcp-project-inventory` (29/29) — facade default; internal helpers off the
    default surface; idempotent sync.
  - `probe-tool-surface` (23/23) — `agent_next_step`/`agent_run_step`/
    `project_inventory_sync` default; internal/`vice_*` advanced.
- **Regression risk:** low — additive (a JSON block + gate assertions); no tool
  semantics changed. The no-internal-recommendations gate guards against future
  leakage on every product surface.
