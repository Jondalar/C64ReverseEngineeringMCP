# Spec 126 — Headless M5.5: Knowledge Integration

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 5, story M5.5
Depth: light
Predecessors: Spec 122, Spec 101 (M1.4)

## Motivation

Diagnostic runs produce traces, snapshots, and renders. Those
artifacts should land in project knowledge automatically when the
scenario opts in, so agents can reference them later through the
existing MCP knowledge tools.

## Acceptance

- Scenario-driven runs with `knowledge: true` automatically register
  produced artifacts via `register_existing_files`.
- Optional `findings: [...]` block in the scenario writes
  `save_finding` entries on completion.
- Optional `tasks: [...]` block writes `save_task` entries.
- Scenarios without these blocks produce no knowledge writes.
- Smoke: scenario with `knowledge: true` produces N registered
  artifacts; scenario without it produces 0.

## Deliverables

- EDIT `src/runtime/headless/scenario/dsl.ts` (knowledge hooks)
- New scenario examples that use the knowledge blocks
- Smoke fixtures.

## Dependencies

- Spec 122.
- Spec 101.

## Risks

- Knowledge-base spam from over-eager scenarios. Mitigation: opt-in
  per scenario; default off.
- Drift between scenario fields and `save_finding` schema.
  Mitigation: validate against the MCP tool's input schema at scenario
  parse time.

## Out of scope

- New finding categories.
- Knowledge-base UI changes.
