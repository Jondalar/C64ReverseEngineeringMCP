# Spec 130 — Headless M7.1: SID Register and Readback Model

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 7, story M7.1
Depth: light
Predecessors: Spec 108 (M2.6)

## Motivation

Spec 108 ships baseline SID readback. M7.1 hardens it with stable
read/write, oscillator/noise readback, paddle reads, ADSR state, and
envelope counter timing close enough that polling code behaves
correctly.

## Acceptance

- All 29 register addresses accept writes; readable registers return
  correct values per data sheet.
- Oscillator and noise readback per voice computed live each cycle.
- ADSR envelope counter advance matches data-sheet rates.
- Paddle pot readback (Spec 107 bridge) returns within ±1 of set
  value.
- 6581 vs 8580 differences documented; default 6581.

## Deliverables

- EDIT `src/runtime/headless/c64/sid.ts`
- New synthetic fixtures
- `docs/sid-fidelity-notes.md`

## Dependencies

- Spec 108.

## Risks

- Real-time ADSR rate accuracy is hard. Mitigation: target poll-correct
  values, not audible accuracy.

## Out of scope

- Audio output.
- Filter-emulation accuracy (no audio path needed).
