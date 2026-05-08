# Spec 250 — Regression vs known-good baselines

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 231 replay, 232 trace store, 236 vice-divergence
**Master:** 230 / 240

## Goal

Run a scenario, compare its event-stream to a stored known-good
baseline, report drift. Two flavors:

- **Self-regression:** baseline = previous git-commit's run of same
  scenario. Catches accidental emu drift.
- **VICE-baseline:** baseline = VICE trace (already covered by
  Spec 236, this spec extends to multi-baseline).

## Baseline storage

```
samples/regression-baselines/
  <scenario-id>/
    <commit-sha>/
      trace.jsonl
      ram-end.bin
      screenshot.png
      meta.json   { date, headlessVersion, eventCount, classification }
```

Latest commit per scenario tracked in `latest.json`.

## CLI

```
npm run regress:capture <scenario-id>     # write new baseline
npm run regress:compare <scenario-id>     # compare against latest
npm run regress:report                    # all scenarios, summary table
```

## Surface

```ts
interface RegressionResult {
  scenarioId: string;
  baselineCommit: string;
  currentCommit: string;
  identical: boolean;
  divergence?: DivergenceRecord;          // (Spec 236 shape)
  classification: "no_drift" | "minor_drift" | "structural_change" | "broken";
  narrative: string;                       // 1-line agent-friendly
}

regressionCompare(scenarioId: string): RegressionResult;
regressionCaptureBaseline(scenarioId: string): { path: string; hashes: Hashes };
```

## Open questions

- **OQ1:** Baseline tracking — git LFS, separate baselines repo, or
  inline tarball checked-in?
- **OQ2:** Auto-update baseline on `master` merge, or always
  manual?
- **OQ3:** Cycle-budget tolerance (= same end-state but +50 cycles
  longer) — fail or warn?
- **OQ4:** Cross-platform — VICE/HL match required, or HL self-
  consistency enough?
- **OQ5:** CI integration — quick-tier runs all-baseline compare
  too aggressive?

## Acceptance (draft)

- Capture baseline for `c64-ready`, `motm-full-boot`, `mm-s1-boot`,
  `im2-boot`, `lnr-s1-boot` at current commit.
- `regress:compare` returns `no_drift` for all 5 if no code change.
- Synthetic drift introduced → regression detected with classification.
- Reporter outputs <30 lines for a clean run, focused on drifts.
