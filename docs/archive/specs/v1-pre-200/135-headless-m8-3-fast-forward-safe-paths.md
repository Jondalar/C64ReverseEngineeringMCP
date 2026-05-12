# Spec 135 — Headless M8.3: Fast-Forward Safe Paths

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 8, story M8.3
Depth: light
Predecessors: Spec 098 (M1.1)

## Motivation

Some idle-loop patterns (BASIC IDLE wait, KERNAL keyboard scan idle)
do not change externally visible state and can be safely fast-forwarded
to save wall time. This must never apply in TrueDrive mode where
timing fidelity is the contract.

## Acceptance

- A small registry of safe-skip patterns (entry PC + idle predicate).
- Skip activates only in `mode: "fast-trap"`.
- Skips are observable via a counter exposed in `modeReport()`.
- Smoke: synthetic fixture in fast-trap measures wall time;
  same fixture in true-drive does not skip.

## Deliverables

- NEW `src/runtime/headless/perf/safe-skips.ts`
- Smoke fixtures.

## Dependencies

- Spec 098.

## Risks

- Incorrect skip masks a real bug. Mitigation: skips disabled in
  `true-drive` and `debug-vice-compare` modes by design.
- Skip predicates drift from real behavior. Mitigation: each skip
  pattern has a fixture that asserts state-pre/state-post equivalence.

## Out of scope

- JIT compilation.
- Speculative execution.
