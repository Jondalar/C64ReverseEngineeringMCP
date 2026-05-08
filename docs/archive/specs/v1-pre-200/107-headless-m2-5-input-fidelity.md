# Spec 107 — Headless M2.5: Input Fidelity

Status: **DONE 2026-05-04 (v1: M2.5a-d shipped; YAML loader for scenario player + per-cycle joystick resolution + paddle ramp timing deferred to v2 / Spec 124).** New: joystick port 1 wired through CIA1 PB (ANDed with keyboard rows), session methods `setJoystick1` / `setPaddle` / `triggerRestoreNmi`, `ScenarioPlayer` JSON-shape scheduler. Tests: 21/21 across joystick ports 1+2 independence, paddle 4-slot storage, RESTORE NMI sets CIA2 ICR FLAG bit, scenario player sort + tick. `npm run smoke:input-fidelity` 21/21; `npm run regress` 5/5. Doc: `docs/input-fidelity-notes.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.5
Depth: deep
Predecessors: Sprint 79 (scriptable keyboard), Sprint 93.1
(keyboard + joystick port), Spec 098 (M1.1), Spec 104 (M2.2 keyboard
matrix)

## Motivation

Keyboard typing and joystick port are working end-to-end. Edge cases
are still open: key debounce, RESTORE/NMI integration, paddle input
via the SID POT pins, frame-scheduled input macros, and a replayable
scenario format that other sprints (M5.4 scenario DSL) can extend.

## Acceptance

- Typed text macros continue to work end-to-end (regression check).
- Joystick port 1 + port 2: 8 directions + fire button, settable per
  cycle or per frame.
- RESTORE key drives CIA2 PB6 NMI; software-key-sense path is
  documented and asserted.
- Paddle inputs: 4 paddles across 2 ports, 256 values each, exposed
  via `session.setPaddle(port, idx, value)`.
- Scripted input file format: YAML or JSON with
  `{ frame, action, target, value }` entries, replayable across runs.
- All of the above asserted via synthetic fixtures.

## Sub-stories

- **M2.5a** Joystick port refinements: per-cycle vs per-frame
  resolution, neutral-state contract.
- **M2.5b** RESTORE NMI integration: assert NMI fires within HW-spec
  cycle window after key press.
- **M2.5c** Paddle bridge: SID POT pin readback wired to paddle
  values (paired with Spec 108).
- **M2.5d** Scenario player module: read YAML/JSON, schedule actions
  per frame.
- **M2.5e** Documentation: `docs/input-fidelity-notes.md`.

## Deliverables

- EDIT `src/runtime/headless/c64/keyboard.ts`
- EDIT `src/runtime/headless/c64/joystick.ts`
- NEW `src/runtime/headless/c64/paddle.ts`
- NEW `src/runtime/headless/input/scenario-player.ts`
- `docs/input-fidelity-notes.md`
- New synthetic fixtures + scenario examples
- Smoke: typed text fixture, joystick fixture, paddle fixture,
  RESTORE NMI fixture.

## Dependencies

- Spec 098.
- Spec 104 (keyboard matrix).
- Spec 108 (SID POT readback for paddles).

## Risks and mitigations

- **Paddle ↔ SID coupling**: paddle values surface through SID POT
  pins. Mitigation: define the bridge interface here, implement SID
  side in M2.6.
- **Scenario format conflict with M5.4**: Mitigation: minimal shape
  here, M5.4 extends without breaking changes.
- **Frame-scheduled input drift**: PAL vs NTSC frame length differs.
  Mitigation: scenario format expresses time in cycles or frames
  with a profile tag.

## Out of scope

- Tape input.
- IEEE-488 expansion port input.
- Light pen.

## File-touch list

- EDIT `src/runtime/headless/c64/keyboard.ts`
- EDIT `src/runtime/headless/c64/joystick.ts`
- NEW `src/runtime/headless/c64/paddle.ts`
- NEW `src/runtime/headless/input/scenario-player.ts`
- NEW `docs/input-fidelity-notes.md`
- NEW `samples/synthetic/input/*.prg`
- NEW `samples/scenarios/*.yaml`
