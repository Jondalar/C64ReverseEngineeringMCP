# Phase 5 Mini Phase 0 — Literal VIC Framebuffer Authority

Date: 2026-05-10
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Predecessor: Spec 302 (literal BA/AEC + CPU stall authority).
Successor spec: Spec 303.

## Goal

Make literal VIC port `vicii.dbuf` the default framebuffer source for
`renderToPng()` (and downstream MCP / UI consumers) when
`useLiteralPortVicFb` flag is on. Keep snapshot-based renderers
(`per-char-row`, `per-pixel`, `vice-rasterized`) selectable for
fallback / diff comparison.

## Current state

### VicIIVice → snapshot → renderer pipeline (current authority)

- VicIIVice emits `ScanlineState` snapshots per raster line
  (vic-ii-vice.ts:1211 `captureScanline()`).
- Three renderers consume snapshots → RGBA `framebuffer.pixels[]`
  (504×312 internal):
  - `per-char-row` (vic-renderer.ts:128-160) — default for
    `renderFrame()`
  - `per-pixel` (vic-renderer-pixel.ts) — uses per-cycle frame logs
  - `vice-rasterized` (vic-renderer-rasterized.ts) — VICE
    raster_changes lane-set pattern
- `renderToPng()` (integrated-session.ts:723-780) crops 384×272 + PNG
  encodes via `rgbaToPng` (peripherals/png-writer.ts).

### Literal port pipeline (already wired, opt-in)

- `vicii.dbuf` (Uint8Array, 520 bytes per line, palette indices).
- `vicii_draw_cycle()` per cycle: `draw_graphics8` → `draw_sprites8`
  → `draw_border8` → `draw_colors8` (vicii-draw-cycle.ts:633-648).
- `installLiteralPortRenderer.onCycle` hook (integrated-session.ts:1370-1390)
  copies `dbuf` into `literalPortFb` (520×312) on raster line
  transitions.
- `renderLiteralPortToPng()` (integrated-session.ts:1399-1450) crops
  to 384×272 (X=[96..480], Y=[16..288]) + palette lookup + PNG.
- `renderToPng({ renderer: "literal-port" })` already routes to it
  (integrated-session.ts:730-732).
- v3-ws-server uses `C64RE_LITERAL_VIC=1` env flag to pass
  `renderer: "literal-port"` (= existing UI-side opt-in).

### Consumers

- MCP `headless_render_screen` tool (server-tools/headless.ts:692):
  calls `session.renderToPng(path)` with no renderer opt → uses
  default. Currently default = snapshot path.
- UI v3-ws-server `session/render_frame` RPC: env flag chooses.
- Smoke scripts: most pass no renderer opt → default.
- No pixel-diff CI harness exists. samples/screenshots/ is reference
  only.

## Literal port pixel completeness vs VICE viciisc/vicii-draw-cycle.c

| Feature | Status | Notes |
|---|---|---|
| Mode 0 (text) | ✅ | full vbuf+cbuf decode |
| Mode 1 (MC text) | ✅ | cbuf 3-LSB triggers MCM |
| Mode 2 (bitmap) | ✅ | hires bitmap |
| Mode 3 (MC bitmap) | ✅ | cbuf 3-LSB |
| Mode 4 (ECM) | ✅ | D02X_EXT palette |
| Modes 5/6/7 (illegal) | ❌ | emit 0x00 (VICE = chargen noise) |
| Sprite priority | ❌ | renders highest-numbered, NOT priority-bit-ordered |
| Sprite multicolor | ✅ | sprite_mc_bits decode |
| Sprite X-expansion | ✅ | sprite_expx_bits decode |
| Sprite Y-expansion | ❌ | sbuf_expx_flops set but not consumed for height doubling |
| Sprite-sprite collision | ✅ | tracks via collision regs |
| Sprite-bg collision | ✅ | |
| Border main (T/B) | ✅ | main_border flag + COL_D020 |
| Border L/R geometric | ❌ | only main_border flag + CSEL within 8-px window; no raster-X boundary check |

**Estimated overall pixel completeness: 95% on text-mode BASIC ready
scenario; lower on sprite-heavy or illegal-mode scenes.**

## Risks for the slice

| # | Risk | Mitigation |
|---|------|------------|
| 1 | BASIC ready text frame may differ from VicIIVice render in border bands due to L/R border simplification | Diff harness sets pixel-delta tolerance (= bordered-area count vs threshold) |
| 2 | Sprite-heavy scenes will show priority bugs | Out of scope for Spec 303; documented as follow-up sub-spec |
| 3 | Illegal modes 5/6/7 will render wrong (black 0x00 vs noise) | No corpus games use illegal modes during boot; not a Phase 5 blocker |
| 4 | Y-expansion missing → tall sprites render half-height | Out of scope; follow-up |
| 5 | UI / MCP defaults stay as snapshot until env flag flips → no UI breakage from this slice | Spec 303 only changes session-internal default routing when flag opted in |
| 6 | Crop coordinates differ between two paths (snapshot crops at X=0 Y=15, literal crops at X=96 Y=16) | Diff harness uses literal-port output dimensions as authority; document the slight crop offset |

## Slice scope (Spec 303)

In:
1. Add `useLiteralPortVicFb?: boolean` session option, defaults to
   `useLiteralPortVicReads`.
2. In `renderToPng()`: when `opts?.renderer === undefined &&
   this.useLiteralPortVicFb && this.literalPortFb`, route to
   `renderLiteralPortToPng()` instead of snapshot path.
3. Pixel-diff harness `scripts/smoke-vic-303-fb-diff.mjs`:
   - boot BASIC ready
   - render twice: explicit `vice-rasterized` + explicit
     `literal-port`
   - read both PNGs, decode RGBA, compute per-pixel delta
   - output: pixel-match %, distinct-color count, worst-bands report
4. BASIC-ready acceptance test
   `scripts/smoke-vic-303-basic-ready.mjs`:
   - render literal-port, assert non-empty (>50% pixels non-zero
     in text area)
   - assert palette in valid C64 16-color range

## Slice scope (out — follow-up specs)

- Sprite priority correctness (Spec 304).
- Sprite Y-expansion (Spec 305).
- Illegal modes 5/6/7 chargen noise (Spec 306; was attempted in Spec
  284 but not in literal port).
- L/R border geometric boundaries (Spec 307).
- v3-ws-server default flip (= UI opt-out env flag becomes opt-in).
- MCP `headless_render_screen` tool: add explicit `renderer` param
  (separate spec).
- Pixel-diff CI harness against VICE export goldens.

## Acceptance gates

1. Existing 297 + 300 + 301 + 302 tests + harnesses still green.
2. Build green.
3. Pixel-diff harness:
   - render BASIC ready frame both ways
   - report per-pixel match % (no hard threshold gate yet — informational)
   - assert no PNG-encoding crash from literal path
4. BASIC-ready test:
   - literal frame has >50% non-background pixels in text region
   - palette indices all in [0, 15]
5. motm boot smoke: still reaches BASIC READY (no regression beyond
   what 300/301/302 accept).

## Deliverables

- `docs/vic-ii-literal-port-phase5-mini-phase0-2026-05-10.md` (this)
- `specs/303-literal-vic-fb-authority.md`
- `scripts/smoke-vic-303-fb-diff.mjs`
- `scripts/smoke-vic-303-basic-ready.mjs`
- Patch to `src/runtime/headless/integrated-session.ts`:
  - new `useLiteralPortVicFb` option + field
  - default-routing branch in `renderToPng()`

## Do-not-investigate (this slice)

1. Sprite priority / Y-expansion / illegal mode pixel correctness
   (separate sub-specs after Phase 5 routing lands).
2. UI default flip (separate sub-spec).
3. MCP `headless_render_screen` renderer param exposure.
4. VICE pixel-perfect golden-image diff CI infrastructure.
5. Renderer removal (Phase 6 work).
6. Performance tuning of literal pixel pipeline.
7. Game-level pixel debugging (motm, MM, IM2, LNR pixel comparisons).
