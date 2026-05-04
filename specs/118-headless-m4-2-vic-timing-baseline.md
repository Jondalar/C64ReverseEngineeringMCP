# Spec 118 — Headless M4.2: VIC Timing Baseline

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 4, story M4.2
Depth: light
Predecessors: Spec 105 (M2.3)

## Motivation

VIC fidelity work in M2.3 is implementation-heavy. M4.2 is the
documentation + lightweight test scaffold that records what the
runtime guarantees and what it does not.

## Acceptance

- `docs/vic-timing-limits.md` documents:
  - raster counter accuracy contract
  - badline cycle position
  - sprite DMA timing
  - IRQ delivery cycle window (jitter ≤ 7)
  - border state model
  - mid-frame register write semantics
  - PAL vs NTSC scanline differences
- A small baseline test suite (~6 tests) asserts each documented
  guarantee on synthetic fixtures.

## Deliverables

- `docs/vic-timing-limits.md`
- `src/runtime/headless/c64/vic-timing-baseline-tests.ts`

## Dependencies

- Spec 105 (implementation source of truth).

## Risks

- Documentation drifts from implementation. Mitigation: each
  documented guarantee has a test that fails if behavior diverges.

## Out of scope

- Implementation work (lives in Spec 105).
- Cycle-perfect register-write effects beyond what M2.3 ships.
