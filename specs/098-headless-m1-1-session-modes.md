# Spec 098 — Headless M1.1: Session Modes

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 1, story M1.1
Depth: light
Predecessors: Milestone 0 specs (094-097)

## Motivation

Session configuration is currently a set of implicit booleans
(`useCycleLockstep`, `useMicrocodedCpu`, `useTraps`). Tools and agents
cannot ask "what mode is this?" without inspecting a bag of flags. There
is no canonical name to record in artifacts or to ship in a smoke
matrix.

A small enum and a resolver fixes this without changing emulator
behavior.

## Acceptance

- Explicit `SessionMode` enum:
  - `fast-trap` — KERNAL/IO/file traps on, legacy CPU, no lockstep.
  - `real-kernal` — traps off, real KERNAL ROM, legacy CPU.
  - `true-drive` — real KERNAL + microcoded drive CPU + cycle lockstep.
  - `debug-vice-compare` — `true-drive` plus EOF channels enabled
    (Spec 095).
  - `custom` — escape hatch; existing booleans drive resolution.
- `startIntegratedSession({ mode })` resolves to the boolean set.
- `session.mode` is a readable field; `session.modeReport()` returns
  `{ mode, traps, microcoded, lockstep, channels }`.
- Every MCP tool that returns runtime state includes `mode` in its
  response.
- All call sites migrated to `mode`. Boolean overrides remain as
  `custom` mode and warn-on-use in dev builds.

## Deliverables

- `src/runtime/headless/session-modes.ts`
- EDIT `src/runtime/headless/integrated-session-manager.ts`
- EDIT MCP tool response schemas that report runtime state
- Smoke: each mode boots successfully, `modeReport()` matches expected.

## Dependencies

- None — pure refactor.

## Risks

- Migration churn across many call sites. Mitigation: keep boolean
  overrides during transition under `custom`.
- Four modes may not cover all combos. Mitigation: explicit `custom`
  preserves arbitrary boolean configs.

## Out of scope

- New emulator behavior.
- Changing trap implementations.
