# Spec 120 — Headless M4.4: Input Macros

Status: **DONE 2026-05-04 (v1).** scenario-player extended with `joystickScript` composite (port + sequence of state+durationFrames entries). 2/2 checks. YAML loader still gated on Spec 124. Doc: `docs/visual-runtime-notes.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 4, story M4.4
Depth: light
Predecessors: Spec 107 (M2.5)

## Motivation

The scenario player from M2.5 covers per-frame input. M4.4 adds
composite macros so common patterns — typed text, joystick scripts,
key holds — read naturally in scenario files.

## Acceptance

- Scenario format extended with composite actions:
  - `type: "LOAD\"X\",8,1<RET>"` — typed text plus special keys.
  - `holdKey: { key, frames }` — key down for N frames.
  - `joystickScript: [...]` — sequence of stick states with frame
    durations.
- Existing per-frame action format remains supported.
- Smoke: scenario file with each macro replays deterministically.

## Deliverables

- EDIT `src/runtime/headless/input/scenario-player.ts`
- New macro examples under `samples/scenarios/`
- Smoke fixtures.

## Dependencies

- Spec 107.

## Risks

- Special-key encoding (`<RET>`, `<F1>`, etc.) needs a documented
  mapping. Mitigation: document the full table in
  `docs/input-fidelity-notes.md` (Spec 107 deliverable).

## Out of scope

- Mouse input.
- Lightpen.
- 1351 mouse paddle input (M2.5 paddle bridge covers paddle pots).
