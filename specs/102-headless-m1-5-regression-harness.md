# Spec 102 — Headless M1.5: Regression Harness

Status: **DONE 2026-05-04 (v1).** Regression matrix runner shipped: `regress.matrix.json` (JSON for v1 — YAML migration deferred), `src/runtime/headless/regress/runner.ts` reads the matrix and runs each entry's scenario (boot/type/wait/joystick steps), `scripts/regress.mjs` CLI emits per-entry result + JSONL artifact at `samples/regress/run-<timestamp>.jsonl`. `npm run regress` PASS 4/4 (L2 + L3 + L7 LOAD scenarios + L8 cold-boot ready) in ~36s. HTML report template deferred to follow-up; JSONL is enough to gate CI for now. Matrix expansion (more disks, more scenarios) is open for ongoing additions without code changes.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 1, story M1.5
Depth: light
Predecessors: Spec 097 (M0.4 LOAD smoke), Spec 098 (M1.1), Spec 101 (M1.4)

## Motivation

Spec 097 covers LOAD smoke. M1.5 generalizes it: a compatibility matrix
across many disks, PRGs, and CRTs that records pass/fail plus artifacts
per target. This becomes the long-running regression dashboard, run on a
slower cadence than smoke.

## Acceptance

- CLI `npm run regress` runs the matrix and emits HTML + JSONL summary.
- Matrix entry shape:
  `{ id, fixturePath, mode, scenario, expectedArtifact }`.
  Scenario = ordered list of `{ kind: "type" | "wait" | "joystick" | "snapshot", ... }`.
- Result per target: pass/fail, artifacts (snapshot, screen PNG,
  trace if failed).
- Matrix file `regress.matrix.yaml` committed; agents add entries
  without code change.
- Smoke (Spec 097) and regress run on different cadences: smoke
  per-commit, regress nightly or pre-release.

## Deliverables

- `src/runtime/headless/regress/runner.ts`
- `regress.matrix.yaml` (initial seed = M0.4 targets + 3 PRGs)
- `scripts/regress.mjs`
- `templates/regress-report.html`
- `package.json`: `regress`

## Dependencies

- Spec 097 (smoke pattern reused).
- Spec 098.
- Spec 101 (snapshot for artifacts).

## Risks

- Sample fixture drift: matrix entries reference local-only fixtures.
  Mitigation: skip-with-reason; never hard-fail on missing local
  fixtures.
- Artifact dir bloat. Mitigation: rotate by run, keep newest 10.

## Out of scope

- VICE oracle compare per-run (Spec 095 covers compare).
- Distributed/cloud regress runs.
