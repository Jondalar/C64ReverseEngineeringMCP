# Spec 125 — Headless M5.4: Scenario DSL

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 5, story M5.4
Depth: light
Predecessors: Spec 107 (M2.5), Spec 120 (M4.4)

## Motivation

M2.5 introduced a minimal scenario format; M4.4 added macros. M5.4
formalises the full scenario DSL: media, reset profile, typed input,
joystick scripts, breakpoints, run limits, expected state, artifacts
to emit.

## Acceptance

- Scenario file (YAML or JSON) shape:
  ```
  version: 1
  media: { disk?: "...", crt?: "...", prg?: "..." }
  resetProfile: "pal-default"
  mode: "true-drive"
  steps: [ ... ]
  expect: [ ... ]
  artifacts: [ ... ]
  ```
- Versioned schema (`version: 1`); JSON schema doc committed.
- CLI `npm run scenario -- <file.yaml>` runs end-to-end.
- Existing M2.5 / M4.4 minimal scenarios upgrade by adding `version`.

## Deliverables

- NEW `src/runtime/headless/scenario/dsl.ts`
- `docs/scenario-dsl.md` + JSON schema file
- Example scenarios under `samples/scenarios/`
- `package.json`: `scenario`

## Dependencies

- Spec 107.
- Spec 120.

## Risks

- Schema sprawl. Mitigation: version field; minimal core; extension
  fields go through a follow-up version bump.

## Out of scope

- Visual scenario editor.
- Multi-machine scenarios (more than one C64 in a scenario).
