# Spec 002: Agent Onboarding Gate

Status: initial onboarding audit summary exists.

## Problem

Agents can start deep analysis before they know whether the project is
fresh, stale, fragmented, or partially imported. That leads to repeated
work and missing JSON state.

## Change

Update `agent_onboard` so it runs or embeds `project_audit` in read-only
mode and returns workflow-safe next actions.

## Required Behavior

`agent_onboard` must report:

- resolved project root
- current phase/status
- artifact/entity/finding/task/question counts
- audit severity
- stale or fragmented state
- ranked next actions

If high-severity audit findings exist, the first proposed actions should
be repair/import/build actions, not new reverse-engineering work.

## Output Contract

The first lines of agent-facing output should make state obvious:

```text
Project root: ...
Knowledge: ok | stale | fragmented | incomplete
Views: fresh | stale | missing
Recommended next action: ...
```

## Acceptance Criteria

- A new agent can call `agent_onboard` and know whether to analyze,
  import, repair, or build views next.
- On fragmented knowledge, onboarding does not silently recommend a new
  analysis pass.
- On stale views, onboarding recommends `build_all_views`.

## Tests

- Smoke test for clean project.
- Smoke test for fragmented project.
- Smoke test for stale views.
