# Spec 136 — Headless M8.4: CI Profile

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 8, story M8.4
Depth: light
Predecessors: Spec 097 (M0.4), Spec 102 (M1.5)

## Motivation

CI must run small synthetic tests on every commit and skip sample-game
tests when local copies are absent. The CI profile defines what runs
where, with clear local-only vs CI-required tagging.

## Acceptance

- `docs/ci-profile.md` lists the test matrix split:
  - CI-required: synthetic fixtures only.
  - Local-only: MM, MOTM, IM2, LNR.
- CI config invokes `smoke:load --strict` (Spec 097) and
  `regress --ci` (Spec 102).
- Local-only fixtures skip cleanly with a logged reason when absent.
- Smoke: CI workflow runs to completion on a fresh clone with no
  sample disks.

## Deliverables

- `docs/ci-profile.md`
- EDIT CI config (e.g. `.github/workflows/*`)

## Dependencies

- Spec 097.
- Spec 102.

## Risks

- CI runner timeouts on long synthetic suites. Mitigation: budget
  per job, parallelise where independent.

## Out of scope

- Cross-OS CI (Linux only initially).
- Self-hosted runners.
