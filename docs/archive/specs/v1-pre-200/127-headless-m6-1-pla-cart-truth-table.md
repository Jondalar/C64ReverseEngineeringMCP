# Spec 127 — Headless M6.1: PLA Cart Truth-Table Tests

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 6, story M6.1
Depth: light
Predecessors: Spec 106 (M2.4)

## Motivation

Spec 106 covers RAM/ROM/I/O banking. M6.1 specifically asserts cart
mapping cases: 8K cart, 16K cart, Ultimax, EXROM/GAME combinations
beyond the baseline test set.

## Acceptance

- Per-cart-type PLA truth tables tested as fixtures.
- Coverage: 8K, 16K, Ultimax, EXROM=1/GAME=0, EXROM=0/GAME=1,
  EXROM=0/GAME=0 (RAM-only), EXROM=1/GAME=1 (no cart).
- Each fixture sets EXROM/GAME pins, asserts each address range maps
  correctly.

## Deliverables

- NEW `src/runtime/headless/c64/pla-cart-tests.ts`
- Synthetic CRT fixtures per case
- EDIT `docs/pla-fidelity-notes.md` to reference cart cases.

## Dependencies

- Spec 106.

## Risks

- Cart pin behavior couples to CRT loader. Mitigation: simulate the
  pins directly in tests; do not require a running cart.

## Out of scope

- Bank-switching mappers (M6.2).
- Cart-side software behavior.
