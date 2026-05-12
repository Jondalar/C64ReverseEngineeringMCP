# Spec 133 — Headless M8.1: Run Budgets

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 8, story M8.1
Depth: light
Predecessors: Spec 099 (M1.2)

## Motivation

Long headless runs need clear cycle, instruction, and frame budgets,
plus partial-result returns when a budget exhausts.

## Acceptance

- `runFor(budget, { partialOnTimeout: true })` returns
  `{ exitReason: "budget", cyclesElapsed, partial: true }` on
  exhaustion rather than running silently to completion or crashing.
- Budget unit configurable: `cycles`, `instructions`, `frames`,
  `wallSeconds`.
- All step APIs in Spec 099 honour the budget.

## Deliverables

- EDIT `src/runtime/headless/stepping.ts`
- Smoke fixtures asserting partial returns on overrun.

## Dependencies

- Spec 099.

## Risks

- Wall-second budget non-deterministic. Mitigation: declare wall
  budgets as best-effort, document.

## Out of scope

- Distributed budget enforcement.
- Multi-machine timeouts.
