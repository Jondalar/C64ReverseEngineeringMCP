# Spec 046: Workflow Templates

## Problem

C64RE today treats every project as full-RE: 7 phases per artifact,
master/worker pattern, audit, cracker freeze. Real projects have
narrower goals — a one-PRG bug-fix, a cracker port that ignores
asset PRGs, an analyst-deep dive on a single loader. Forcing the
full workflow on a 1-hour bug-fix is friction.

codemcp/workflows defines workflow templates (waterfall, EPCC,
TDD, bugfix, greenfield) and selects one at session start. C64RE
should mirror this for its domain.

## Goal

A small set of workflow templates the user (or `start_re_workflow`)
picks at the beginning. The phase plan, cracker / analyst
defaults, and propose_next ranking adapt to the chosen workflow.

## Workflow templates

| Template | Use case | Phases active |
|----------|----------|---------------|
| `full-re` | Default. Reverse a multi-PRG title from scratch. | 1..7 per artifact |
| `cracker-only` | Crack/port focus. Asset PRGs auto-frozen at phase 3. | loader/protection/save go full 1..7; assets stop at 3 |
| `analyst-deep` | Single-PRG deep analysis (research, port plan). | 1..7 with extra emphasis on phase 4-5 iteration |
| `targeted-routine` | Fix one routine in one PRG. No project-wide audit pressure. | 3..5 only on the target artifact |
| `bugfix` | Reproduce a known bug, patch, verify. | 1, 5 (annotation), 7 (rebuild + scenario diff) |

### Schema

ProjectProfile (Spec 026) gains:

```ts
workflow?: "full-re" | "cracker-only" | "analyst-deep" | "targeted-routine" | "bugfix";
workflowSelectedAt?: string;
```

Default `full-re` when absent.

### Phase activation

`PHASE_TOOLS` allow-list (Spec 034) is unchanged; the active
workflow filters which phases are *required* in the per-artifact
status checklist:

| Workflow | Required phases (analyst) | Required phases (cracker) |
|----------|---------------------------|---------------------------|
| full-re | 1,2,3,4,5,6,7 | 1,2,3 (assets) / 1..7 (loader, protection, save) |
| cracker-only | 1,2,3 (assets) / 1..7 (loader, protection, save) | same |
| analyst-deep | 1,2,3,4,5,6,7 | n/a (cracker not used) |
| targeted-routine | 3,4,5 on target only | n/a |
| bugfix | 1,5,7 | 1,5,7 |

### MCP tool

```
start_re_workflow(workflow, project_dir?, force?)
```

Sets the workflow on the project profile. Refuses if a workflow is
already set unless `force=true`.

`agent_onboard` and `c64re_whats_next` read the workflow and adapt
their output (e.g. cracker-only quotes cracker doctrine, bugfix
hides phase 4-6 from propose_next).

### Auto-detection

`start_re_workflow` may be called by the user explicitly or
proposed by `agent_propose_next` based on hints:

- One PRG only + recent `analyze_prg` → `targeted-routine`
- CRT in the project + `payloadFormat: ROML` → `cracker-only`
- Bug report file present (`BUGREPORT_*.md`) → `bugfix`
- Default → `full-re`

The agent confirms before flipping.

## Acceptance Criteria

- `start_re_workflow(workflow="bugfix")` writes the workflow into
  project-profile.json.
- `agent_propose_next` against a `bugfix` workflow lists only
  phases 1, 5, 7 in the per-artifact section; hides 2, 3, 4, 6.
- `c64re_whats_next` quotes the chosen workflow at the top.
- Re-running `start_re_workflow` without `force` refuses with a
  self-documenting message (Spec 045).

## Tests

- Smoke: set bugfix workflow, assert per-artifact-status filters
  required phases accordingly.
- Smoke: agent_propose_next output shows workflow name.

## Out Of Scope

- Workflow definition customization (fixed set in v1).
- Per-artifact workflow override (project-wide only in v1).

## Dependencies

- Spec 026 project profile.
- Spec 034 phase model.
- Spec 022 per-artifact status — checklist filtering.
- Spec 043 whats_next — uses workflow context.
