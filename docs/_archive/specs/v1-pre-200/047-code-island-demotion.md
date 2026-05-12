# Spec 047: Classifier-Side Code-Island Demotion

## Problem

Sprint 16 v1 fixed Bug 8 (text encoding) and Bug 11 (sprite
over-eager). The third Spec-019 deferred work — Bug 5/6 follow-up —
ships defensive renderer-side fixes that emit `<segment-label>+<offset>`
or raw `$XXXX` when branches don't resolve. The build stays green
but the underlying classification is wrong: a code island whose
branches land in unknown / data and which contains JAM opcodes is
clearly **not code**. It should be classified as `data` so the
renderer emits `.byte` rows naturally, not as broken code with
fall-through workarounds.

## Goal

Add a classifier-side demote pass that runs after segment
resolution. Walks every `code` segment, applies four heuristics,
demotes to `data` (or `unknown`) when the confidence drops below
0.3. Iterates until no further demote happens (min 3 passes, max 10
safety cap).

## Heuristics

| Rule | Confidence reduction |
|------|----------------------|
| JAM opcode somewhere in the island (any of `$02, $12, $22, $32, $42, $52, $62, $72, $92, $B2, $D2, $F2`) | -0.4 |
| ≥2 adjacent undocumented opcodes | -0.3 |
| Relative branch target lands inside `unknown` or `data` segment | -0.2 per offending branch |
| First instruction at island start is invalid 6502 | -0.5 |

Final confidence = `originalConfidence - sum(reductions)`. If
result < 0.3 → demote to `data` (or `unknown` if surrounding
segments are also unknown).

## Iteration

```ts
let passNumber = 0;
let changed = true;
while (changed || passNumber < 3) {
  changed = runDemotePass(segments);
  passNumber += 1;
  if (passNumber > 10) break; // safety cap
}
```

Min 3 passes (so a demote in pass 1 can cascade-resolve dependent
demotes in passes 2 and 3). Then iterate until stable. Cap at 10
to avoid infinite loops on pathological inputs.

## Project Profile Toggle

`projectProfile.disasmDemoteAggressive` (boolean, default `false`).
When `false`, the pass runs but the demote threshold is `0.3` and
heuristics are conservative. When `true`, threshold becomes `0.45`
(more eager demote, lets-me-byte-kram-statt-broken-code mode).

## Where it lands

`pipeline/src/analysis/pipeline.ts` — new `demoteBrokenCodeIslands(segments, codeSemantics)` pass after `resolveSegments` and before `demoteStatefulSpriteSegments`. Mirrors the existing pattern.

## Acceptance Criteria

- A synthetic fixture under `fixtures/code-island-demotion/`
  (committed) reproduces the BVC-into-stochastic-data pattern from
  BUGREPORT Bug 6. After the demotion pass, the byte sequence
  renders as `.byte` and rebuilds byte-identical.
- Existing C64 PRGs (fixture HELLO + Murder corpus when locally
  available) keep their byte-identical rebuild — no regressions.
- `disasmDemoteAggressive=true` demotes more aggressively (proven
  via fixture with marginal-confidence islands).

## Tests

- Smoke (CI-required): synthetic fixture with JAM + branch-into-data,
  assert demotion happened and rebuild is byte-identical.
- Optional smoke (local): Murder corpus rebuild-verify against
  baseline.

## Out Of Scope

- Inverse promotion (data → code based on heuristics).
- Cross-segment heuristics (e.g. neighboring data segments).

## Dependencies

- Existing `demoteStatefulSpriteSegments` pattern.
- Spec 026 project profile (for the `disasmDemoteAggressive` flag).
