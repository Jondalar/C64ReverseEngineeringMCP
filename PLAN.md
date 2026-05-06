# PLAN — Pointer

This file is intentionally short. The historical PLAN.md is archived at
`docs/archive/PLAN-2026-05-06.md`.

## Canonical Sources

- **`EPIC_ROADMAP.md`** — V1/V2/V3 product goals, spec cut (200-series),
  sprint plan, test profiles. Read this for forward-looking work.
- **`docs/adr-headless-machine-kernel.md`** — Accepted 2026-05-06.
  Binding architecture authority for emulator-core work.
- **`BUGREPORT.md`** — Project-wide bug tracking (not headless-only).
- **`REQUIREMENTS.md`** — Refinement / enhancement backlog.

## Working Process (CLAUDE.md anchor)

Before any task:

1. Read `BUGREPORT.md`.
2. Read `REQUIREMENTS.md`.
3. Read `EPIC_ROADMAP.md` (for kernel/runtime work) or this pointer
   (for non-kernel work).
4. For kernel-core work also read the ADR.

Spec-driven flow: every kernel-core change requires a 200-series spec
under `specs/`. Legacy specs ≥137 are superseded — see `EPIC_ROADMAP.md`
mapping table.

API-first via headless. UI follows once API stable.
