# Spec 751 — Effective-segments overlay reuse (BUG-034)

**Status:** DONE (2026-06-02) — option D shipped; gate `e2e:751` 27/27.
**Closes:** BUG-034. **Lineage:** Spec 055 (effective-segments overlay) hardening.
**Doc anchor:** `pipeline/src/lib/effective-segments.ts:72` (`buildEffectiveSegments`);
non-destructive gate `specs/720-disasm-output-quality.md:109`.

## 0. Goal
An annotation that reclassifies a segment (`SegmentAnnotation`, e.g. a mis-disassembled
data region → `data`) must be reflected **everywhere a segment is shown** — not only in
the `disasm_prg` text — **without** mutating `_analysis.json` (non-destructive stays).

## 1. Root cause (BUG-034)
The Spec 055 overlay (`buildEffectiveSegments`) runs **only inside the disasm render pass**
(`prg-disasm.ts:2648-2656`) into a transient `analysisContext.segments`, then discarded.
`disasm_prg` is the ONLY path that applies it. Six consumers read raw `_analysis.json`
segments with no overlay; a seventh re-implements it incorrectly:

| # | Consumer | File:line | Note |
|---|----------|-----------|------|
| 1 | `inspect_address_range` | `src/server-tools/inspect-range.ts:230` | raw, no annotations loaded |
| 2 | runtime PC-resolve | `src/runtime/headless/v2/resolve-pc.ts:171-194` | **append-not-overlay** + `alreadyCovered` skip = buggy 3rd impl |
| 3 | graphics view | `src/workspace-ui/graphics-view.ts:150,169` | raw |
| 4 | annotated-listing view | `src/project-knowledge/view-builders.ts:2525` | raw |
| 5 | memory-map (entities) | `src/project-knowledge/analysis-import.ts:367,542` | minted 1:1 from raw segments |
| 6 | disk-layout view | `src/project-knowledge/view-builders.ts:251` | raw `raw.segments` |
| — | `emitAnnotationFindings` | `src/project-knowledge/service.ts:2532` | inline `effectiveOwnerAt`/`effectiveSegmentEndAt` = 2nd impl |

**Not a doctrine violation.** Non-write-back is correct (byte-identical gate; findings
already persist reclassifications via `emitAnnotationFindings`). The gap is **overlay
reuse**: render-private algorithm, duplicated 3×.

## 2. The dual-build wrinkle (why a naive "just export it" fails)
`buildEffectiveSegments` lives in `pipeline/` (CommonJS, `dist/pipeline/*.cjs`). The 6
consumers live in `src/` (ESM, `dist/*.js`). ESM-importing the pipeline CJS across the
build boundary is exactly why `service.ts` re-implemented it inline. So the fix needs a
**shared server-side module**, not a cross-build import.

## 3. Design — option D
### 3.1 (A core) One shared server-side overlay module
- New `src/project-knowledge/effective-segments.ts` — a dependency-light port of the pure
  algorithm (`buildEffectiveSegments`; inputs are plain `Segment[]` + overlay shapes, no
  pipeline deps). Plus a loader `loadEffectiveSegments(analysisPath, annotationsPath)` that
  reads both JSONs and returns the merged segment list.
- Route all 6 consumers through it. Collapse `service.ts:2532` inline pair onto it. Fix
  `resolve-pc.ts:171-194` (replace append-with-skip by the real overlay).
- Pipeline keeps its own copy (disasm path already correct, separate build world). Net:
  the SERVER has exactly one overlay impl (was 2 + a bug); the pipeline has one. Two copies
  total, each reused, no cross-build hack.

### 3.2 (D surfacing) "reclassified by annotation" hint
Where a consumer shows a segment whose **effective owner differs** from the raw analysis
kind, mark it reclassified using the already-persisted Spec 055 findings (`emitAnnotation
Findings`). So the override is visible, not silent (closes the loop the agent wanted).

## 4. Worked example (the live case, Wasteland)
A region the heuristic force-decoded as code — actually data:
```
.byte $EB,$A5              ; undoc SBC  ($EB)
bit  $C9                   ; $24 $C9
.byte $FF,$F0,$13          ; undoc ISC  ($FF)
lda #$7E / jsr $1F03       ; coincidental "print '~'"-shaped bytes
lda #$5B / jsr $1F03       ; coincidental "print '['"-shaped bytes
dec $23 / dec $23 / dec $24
.byte $4B,$01              ; undoc ALR  ($4B)
ora ($01,x)  ×14           ; = a 28-byte run of $01 $01 …  ← the tell: data
```
Undoc-opcode salad ($EB/$FF/$4B) + the 28-byte `$01` run = the disassembler walked into
data. Reclassify region → `data` via `SegmentAnnotation`; with this spec that shows in
inspect / memory-map / graphics / disk-layout, not just the disasm.

## 5. Slices (all DONE 2026-06-02)
- **751.1 — DONE.** `src/project-knowledge/effective-segments.ts` (pure generic port +
  `loadEffectiveSegments` + `annotationSegmentsToOverlays` + `overlayCovering`). Parity vs.
  the pipeline algorithm proven on 5 fixtures (`e2e:751`).
- **751.2 — DONE.** Routed consumers **1, 3, 4** through `loadEffectiveSegments`
  (inspect_address_range, graphics-view, annotated-listing). **Consumer 6 was a FALSE
  POSITIVE** — `view-builders.ts:251` (`readSemanticAnnotationSummary`) reads annotation
  *comments*, not analysis segment kinds; no overlay needed.
- **751.3 — DONE.** Collapsed the `service.ts` inline overlay onto the shared
  `annotationSegmentsToOverlays` + `overlayCovering`; `effectiveSegmentEndAt` keeps its
  kind+source walk so routine-end + segclass findings are byte-for-byte unchanged.
- **751.4 — DONE.** `resolve-pc.ts` now uses the real overlay (was append-with-skip that
  dropped a reclassify of an already-covered range). Latent bug killed.
- **751.5 — DONE.** Resolved the refinement decision as **view-time** (import-time was
  flawed — annotations arrive after import). `buildMemoryMapView` overlays the annotation
  kind onto regions minted from analysis segments, scoped per entity→analysis-artifact,
  + a `reclassifiedByAnnotation` flag. Entity records untouched (non-destructive).
- **751.6 — DONE.** (D) hint: `inspect_address_range` marks `[reclassified by annotation]`
  inline; memory-map carries the explicit flag; annotated-listing/regions already link the
  Spec 055 segclass finding.
- **751.7 — DONE.** Gate `e2e:751` **27/27**: unit parity (incl. the resolve-pc
  full-override case) + integration (memory-map kind+flag, annotated-listing kind,
  emitAnnotationFindings parity) + **non-destructive at BOTH the entity-record and on-disk
  `_analysis.json` levels**. Regressions green: e2e:024 15/15, e2e:741 13/13, smoke:741
  50/50, e2e:bug031 14/14, project-knowledge smoke.

> **UI note:** the memory-map + annotated-listing builders run in the 4310 workspace-ui
> server (recomputed live per request) — a builder CODE change needs a **4310 restart** to
> show in the browser. `inspect_address_range` / `resolve-pc` are MCP-side → **`/mcp
> reconnect`**.

## 6. Non-goals
- NOT changing the heuristic / code-discovery (why it over-reached = separate, Spec 047
  code-island demotion). This spec makes the **annotation override** propagate; it does not
  make the heuristic smarter.
- NO write-back to `_analysis.json`. NO new sidecar artifact (rejected option B). NO
  `materialize` tool that mutates source (rejected option C).
- Byte-identical rebuild gate (`specs/720:109`) preserved — annotations never touch bytes.
- **Deliberate exclusions (completeness audit 2026-06-02):** `service.ts`
  `computeQualityMetrics` (≈3503) reads RAW segments on purpose — it measures the
  *analyzer's* output quality (unknown-byte ratio, confidence), not a region-kind display;
  overlaying annotations would conflate "heuristic quality" with "human understanding".
  The graphics confirm/reject endpoints (`service.ts` ≈2912/2977/3031) operate on a
  separate axis (asset confirm-state), not kind display. `analysis-import` entity minting
  stays heuristic at import (the 751.5 view-time decision overlays at display). These are
  intentional, not missed surfaces.
