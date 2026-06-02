# BUG-034 — Effective-segments overlay (Spec 055) not reused by analysis-consuming views/tools

**Severity:** medium (annotation reclassifications invisible outside disasm; one consumer re-implements the overlay incorrectly)
**Area:** analysis / knowledge views / effective-segments overlay (Spec 055)
**Status:** open (root-caused; fix = Spec 751, option D)

## Repro (Wasteland-Claude, hit 3×)
1. `analyze_prg` a PRG → `_analysis.json` (heuristic segments; a code region misclassified as `unknown`/data).
2. Reclassify the region via `_annotations.json` (a `SegmentAnnotation`, e.g. `unknown → code`).
3. `disasm_prg` → the **disasm** honours the reclassification (correct).
4. Look at the region in `inspect_address_range`, the memory-map view, the graphics view, the annotated-listing view, runtime PC-resolve → **still shows the old heuristic kind**.

## Expected
Annotation segment reclassifications are reflected everywhere a segment is shown, not only in the disasm text — without mutating `_analysis.json` (non-destructive doctrine stays).

## Actual
- The effective-segments overlay (Spec 055, `buildEffectiveSegments` @ `pipeline/src/lib/effective-segments.ts:72`) is computed **only inside the `disasm_prg` render pass** (`pipeline/src/lib/prg-disasm.ts:2648-2656`) into a transient `analysisContext.segments`, then discarded. `disasm_prg` is the ONLY path that applies it.
- Workarounds the agent fell back to: (1) re-run `analyze_prg` with `entry_points` (`analysis-workflow.ts:166-177`) = a full heuristic re-run that **blows away** any hand edits; (2) hand-patch `_analysis.json` (no supported tool). Both bad.

## Friction surfaces (read raw `_analysis.json` segments, no overlay)
| # | Consumer | File:line |
|---|----------|-----------|
| 1 | `inspect_address_range` | `src/server-tools/inspect-range.ts:230` |
| 2 | runtime PC-resolve — **divergent re-impl** (append-not-overlay + `alreadyCovered` skip) | `src/runtime/headless/v2/resolve-pc.ts:171-194` |
| 3 | graphics view builder | `src/workspace-ui/graphics-view.ts:150,169` |
| 4 | annotated-listing view builder | `src/project-knowledge/view-builders.ts:2525` |
| 5 | memory-map view (entities minted 1:1 at import) | `src/project-knowledge/analysis-import.ts:367,542` |
| 6 | disk-layout view (same `raw.segments` pattern) | `src/project-knowledge/view-builders.ts:251` |

Plus the third copy of the algorithm: `src/project-knowledge/service.ts:2532` (`effectiveOwnerAt`/`effectiveSegmentEndAt`, inline in `emitAnnotationFindings`).

## Design vs. gap
Not a doctrine violation. Non-write-back is **correct + intended** — non-destructive overlay, byte-identical rebuild gate (`specs/720-disasm-output-quality.md:109`), reclassifications already materialise durably as **findings** via `emitAnnotationFindings`. The gap is **overlay reuse**: the algorithm is render-private and duplicated 3× (pipeline `buildEffectiveSegments` / `service.ts` inline / `resolve-pc` buggy append), so the 6 consumers above show stale segmentation. The dual-build boundary (pipeline CJS vs. server ESM) is *why* `service.ts` re-implemented it instead of importing the pipeline one.

## Suggested fix — Spec 751 (option D)
- **(A core)** One shared **server-side** overlay module (`src/.../effective-segments.ts`) — a dependency-light port of the pure algorithm (only `Segment` + overlay shapes). Route all 6 consumers through `loadEffectiveSegments(analysisPath, annotationsPath)`; collapse the `service.ts` inline pair and fix the `resolve-pc` append-bug onto it. Read-only, no write-back, no new artifact. Pipeline keeps its own copy (disasm path already correct, separate build world).
- **(D surfacing)** Where a consumer shows a segment whose **effective owner differs** from the raw analysis kind, mark it "reclassified by annotation" using the already-persisted Spec 055 findings — so the reclassification is visible, not silent.

## Resolution
_(pending Spec 751 implementation — gate `e2e:bug034` / `e2e:751` TBD)_
