# Spec 306 — Delete Snapshot Renderer Files (Phase 6b2)

Status: open
Date: 2026-05-10
Predecessor: Spec 305 (cycle-pumped strip + UI flip)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 6b2

## Goal

Delete the now-orphaned snapshot renderer files + their support
graph. After Spec 305, no in-tree consumer wires them; they are
reachable only through historical opts.renderer values that this
spec also strips.

## Scope (in)

### Files to delete (16)

**Snapshot renderer cluster:**
- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts`
- `src/runtime/headless/peripherals/vic-renderer-pixel.ts`

**Rasterized infrastructure (only consumer = rasterized):**
- `src/runtime/headless/vic/raster-changes-builder.ts`
- `src/runtime/headless/vic/raster-changes.ts`
- `src/runtime/headless/vic/raster-state.ts`
- `src/runtime/headless/vic/raster-cache.ts`
- `src/runtime/headless/vic/renderer-2pass.ts`
- `src/runtime/headless/vic/sprite-render.ts`
- `src/runtime/headless/vic/mc-mask-table.ts`

**Cycle-pumped infrastructure (consumers also dying):**
- `src/runtime/headless/vic/cycle-pumped-renderer.ts`
- `src/runtime/headless/vic/cycle-pixel-composite.ts`
- `src/runtime/headless/vic/cycle-driven-line-renderer.ts`
- `src/runtime/headless/vic/cycle-table-pal.ts`
- `src/runtime/headless/vic/display-pipe.ts`
- `src/runtime/headless/vic/fetch-phi1.ts`
- `src/runtime/headless/vic/border-state.ts`
- `src/runtime/headless/vic/sprite-cycle.ts`
- `src/runtime/headless/vic/sprite-collision-latch.ts`
- `src/runtime/headless/vic/sprite-quirks.ts`

### integrated-session.ts edits

- Drop imports of `renderFrameRasterized`, `renderFramePixelPerfect`.
- Strip the snapshot-renderer branches from `renderFrame()` (only
  `per-char-row` left).
- Narrow `renderToPng()` opts.renderer union to
  `"per-char-row" | "literal-port"` only.
- Throw at runtime on unknown renderer string (= safety net for
  callers passing legacy values).

### v3-ws-server.ts edits

- Drop `vice-rasterized` from renderer type.
- Remove `C64RE_LEGACY_VIC` env handling.
- Always literal-port (= no fallback option remains in this layer).

### Scripts handling

**Keep + update (4):** rewrite renderer reference to literal-port
or omit:
- `scripts/test-motm-screenshots.mjs`
- `scripts/test-motm-vsf.mjs`
- `scripts/test-motm-direct.mjs`
- `scripts/start-v3-server.mjs`

**Archive via git mv (18):** move to
`scripts/archive/spec-306-deleted-renderers/`. These referenced
deleted renderers; preserved for history.

## Scope (out — follow-up specs)

- VicIIVice cleanup / facade / deletion (Spec 307).
- Phase 7 perf pass.

## Acceptance gates

1. Build green.
2. Spec 300/301/302 + 298k + 303 basic-ready smokes still PASS.
3. Spec 303 fb-diff is archived (dual-truth source removed).
4. motm scripts can run without TS error (= renderer strings valid).
5. UI server starts; literal-port screen renders.

## Implementation

### Strip + narrow

```ts
// integrated-session.ts:
opts?: { frameAligned?: boolean; renderer?: "per-char-row" | "literal-port" }

renderFrame(opts?: { renderer?: "per-char-row" }): void {
  // only per-char-row remains. drop vice-rasterized + per-pixel
  // branches.
  renderTextModeFrame(this.framebuffer, { ... });
}
```

### v3-ws-server.ts

```ts
// always literal-port; no env fallback
s.renderToPng(path, { renderer: "literal-port" });
```

## Deliverables

- `specs/306-literal-vic-renderer-file-deletion.md` (this)
- 16 file deletions + 18 script archives
- Patches to integrated-session.ts + v3-ws-server.ts
- Edits to 4 retained scripts

## Next slice

Spec 307 — VicIIVice cleanup / facade / deletion (Phase 6c+d).
