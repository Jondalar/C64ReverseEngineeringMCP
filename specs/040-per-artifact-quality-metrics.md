# Spec 040: Per-Artifact Quality Metrics

## Problem

Spec 022 declared a `qualityMetrics` field on the per-artifact
status response but the implementation never populated it.
REQUIREMENTS R13.

Without metrics the dashboard cannot rank PRGs by analysis maturity
("which PRGs have the most unknown spans?") and the agent cannot
prioritise low-quality artifacts.

## Goal

Compute and surface four per-artifact quality metrics, cached so
the dashboard stays responsive on large projects.

## Metrics

| Metric | Computation |
|--------|-------------|
| `bytesByKind` | bytes covered per `SegmentKind` (code, data, text, sprite, charset, unknown, …) from `*_analysis.json` |
| `avgConfidence` | mean of segment confidence values |
| `largeUnknownCount` | count of `unknown` segments whose length > `largeUnknownThreshold` (project-profile config, default 16) |
| `namedLabelRatio` | named labels / total labels in `*_disasm.asm` |

Named label regex: `^[A-Za-z_][A-Za-z0-9_]*` (named); raw `WXXXX`
labels match `^W[0-9A-F]{4}$`. Other formats counted as named.

## Approach

### Configuration

Project profile (Spec 026) gains:

```ts
qualityMetrics?: {
  largeUnknownThreshold?: number;   // default 16
}
```

### Helper

`computeQualityMetrics(analysisJsonPath, listingPath?)` returns the
metric record. Pure function over file inputs.

### Cache

Per-artifact cache at `knowledge/.cache/quality-metrics/<artifactId>.json`
with fingerprint:

```ts
{ analysisMtimeMs, listingMtimeMs?, computedAt, metrics }
```

`getPerArtifactStatus` (Spec 022) reads cache; if mtime changed,
recompute + persist. Audit cache pattern (Spec 009) reused.

### Dashboard

The per-artifact-status row gains three sortable columns:

1. `completionPct` — Spec 022, role-aware
2. `qualityScore` — derived from metrics: `avgConfidence × (1 -
   min(1, largeUnknownCount / max(1, totalSegments) × 5))`
3. `relevanceRank` — Spec 041 (placeholder column here, populated
   by R25 sprint)

Columns rendered separately, no combined weighting (transparency).

## Acceptance Criteria

- A fixture artifact's per-artifact status carries all four metric
  fields with sensible values.
- A second call to `getPerArtifactStatus` reads from cache (no
  recompute when mtimes unchanged).
- Editing the analysis JSON invalidates the cache.
- Project profile `qualityMetrics.largeUnknownThreshold = 32`
  changes the `largeUnknownCount` value accordingly.

## Tests

- Smoke: build per-artifact status on the fixture, assert
  `bytesByKind` totals equal the analysis file segment span sum.
- Smoke: change the large-unknown threshold via project profile,
  assert `largeUnknownCount` recomputes.
- Smoke: cache-hit assertion (mtime unchanged → no
  recompute by hash).

## Out Of Scope

- Per-segment quality scores (artifact-level only).
- Cross-artifact quality aggregation (project-level rollup).

## Dependencies

- Spec 022 per-artifact status — extend payload with metrics.
- Spec 026 project profile — `qualityMetrics.largeUnknownThreshold`.
- Spec 009 audit cache — pattern reuse.
