# Spec 045: Self-Documenting Errors

## Problem

When a tool call is refused or fails, today's response is a generic
error envelope. Agent has to guess the right next action. codemcp
pattern: every error teaches the next correct call.

Examples of today's poor signaling:

- `c64re_whats_next` before `agent_onboard` → generic "no project
  metadata" error.
- `agent_advance_phase` to a non-existent artifact → bare "artifact
  not found".
- `apply_patch_recipe` against drifted bytes → already structured
  (Spec 027), good.
- Phase-gate refused (Sprint 34) → already structured, good.

## Goal

Every refusal or no-op response from the agent_* tool family ends
with "Recommended next action: ..." plus the exact tool call to
make. The agent never has to guess.

## Approach

### Error-shape extension

Helper `nextStepError(toolName, message, recommended)` returns a
`ToolTextResult` with:

```
# c64re error — {toolName}

{message}

Recommended next action: {recommended}
```

`recommended` is a one-line tool call expression like
`agent_onboard(project_dir="/abs/path")`.

### Tools updated

| Tool | Error case | Recommended next action |
|------|-----------|--------------------------|
| `c64re_whats_next` | called before `agent_onboard` | `agent_onboard(project_dir=...)` |
| `agent_advance_phase` | artifact not found | `list_artifacts()` then re-run with valid id |
| `agent_advance_phase` | backward jump | "phases only move forward; create a new artifact if you need to redo earlier work" |
| `agent_freeze_artifact` | artifact not found | `list_artifacts()` |
| `agent_record_step` | first call after restart, no prior state | `agent_onboard(project_dir=...)` |
| `agent_propose_next` | empty project | `project_init(name=..., project_dir=...)` |
| `agent_set_role` | unknown role | "valid roles: analyst, cartographer, implementer, cracker" |
| `register_load_context` | artifact not found | `list_artifacts()` |
| `declare_loader_entrypoint` | artifact not found | `list_artifacts()` |
| `apply_patch_recipe` | unknown id | `list_patch_recipes()` |

### Implementation

`src/server-tools/error-helpers.ts` exports `nextStepError`.
Existing `safeHandler` callers use it on the explicit no-op /
refused branches; `safeHandler`'s catch path adds a generic
"investigate the failing phase and re-run" recommendation that
already approximates this.

### Coverage

Limit to the agent_* family + the orchestration-critical tools
(load_context, loader_entrypoint, patch_recipe). Other tools'
errors stay as today.

## Acceptance Criteria

- Calling `c64re_whats_next` without prior `agent_onboard` returns
  a self-documenting message naming `agent_onboard` as the next
  action.
- Calling `agent_advance_phase` against an unknown id returns the
  helpful "list_artifacts then re-run" message.
- Tools not in the covered list keep their existing behavior.

## Tests

- Smoke: per covered tool, induce the error and assert the
  "Recommended next action" line.

## Out Of Scope

- Translating error messages.
- Auto-suggesting fixes beyond a single tool call.

## Dependencies

- Spec 012 safeHandler.
- Spec 043 whats_next.
