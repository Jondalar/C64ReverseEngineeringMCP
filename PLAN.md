# PLAN — Pointer

This file is intentionally short. The historical PLAN.md is archived at
`docs/archive/PLAN-2026-05-06.md`.

## Canonical Sources

- **`README.md`** — high-level project overview. C64RE MCP is the
  whole workbench; the Headless Runtime is one subsystem.
- **`EPIC_ROADMAP.md`** — V1/V2/V3 product goals, spec cut, sprint
  plan, test profiles. Read this for forward-looking work.
- **`docs/adr-headless-machine-kernel.md`** — Accepted 2026-05-06.
  Binding architecture authority for emulator-core work.
- **`docs/workflow.md`** — project-first reverse-engineering workflow.
- **`docs/semantic-ui-layer.md`** — knowledge store, Workspace UI, and
  V3 UI relationship.
- **`BUGREPORT.md`** — Project-wide bug tracking (not headless-only).
- **`REQUIREMENTS.md`** — Refinement / enhancement backlog.

## Working Process (CLAUDE.md anchor)

Before any task:

1. Read `BUGREPORT.md`.
2. Read `REQUIREMENTS.md`.
3. Read `EPIC_ROADMAP.md` for runtime, UI, trace-store, and roadmap
   work. Read `docs/workflow.md` for RE-project work.
4. For kernel-core work also read the ADR.

Spec-driven flow:

- Runtime/kernel changes use the 200-series and ADR.
- V2 LLM workbench changes use the 230-250 series.
- V3 human emulator UI changes use 260-series technical specs and
  350-series UX specs.
- VIC/drive fidelity follow-ups currently use 280-297.
- Knowledge/UI/workflow changes still need a spec when behavior or data
  contracts change, but not every docs-only update needs one.

API-first remains the rule. The Headless Runtime, VICE integration,
Workspace UI, and Emulator UI are clients of the same project APIs and
knowledge model.
