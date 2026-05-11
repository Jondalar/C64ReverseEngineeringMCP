# Spec 303 — Literal VIC-II Framebuffer Authority

Status: open
Date: 2026-05-10
Predecessor: Spec 302 (literal BA/AEC + CPU stall authority)
Mini Phase 0: `docs/vic-ii-literal-port-phase5-mini-phase0-2026-05-10.md`
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 5 of migration plan

## Goal

Make literal port `vicii.dbuf` accumulator (= `literalPortFb`) the
default framebuffer source for `renderToPng()` when
`useLiteralPortVicFb` flag is on. Snapshot renderers
(`per-char-row` / `per-pixel` / `vice-rasterized`) remain selectable
via explicit `opts.renderer`.

See mini Phase 0 doc for full pipeline audit, literal port pixel
completeness table (~95% text-mode), risk list, and follow-up
sub-spec backlog (sprite priority, Y-expansion, illegal modes,
border L/R geometry).

## Scope (in)

1. Add `useLiteralPortVicFb?: boolean` session option, defaults to
   `useLiteralPortVicReads`.
2. In `renderToPng()` (integrated-session.ts:723), add default
   routing branch:
   ```ts
   if (opts?.renderer === undefined &&
       this.useLiteralPortVicFb &&
       this.literalPortFb) {
     return this.renderLiteralPortToPng(path);
   }
   ```
3. Pixel-diff harness `scripts/smoke-vic-303-fb-diff.mjs`:
   - boot BASIC ready
   - render twice: explicit `vice-rasterized` + explicit
     `literal-port`
   - decode both PNGs (= reuse `rgba` from in-memory render or read
     PNGs back via existing PNG decoder if available)
   - compute per-pixel match %, distinct-color count, dump worst rows
4. BASIC-ready test `scripts/smoke-vic-303-basic-ready.mjs`:
   - render literal-port output
   - assert non-empty + palette range valid

## Scope (out)

- Sprite priority bug (Spec 304 follow-up).
- Sprite Y-expansion (Spec 305).
- Illegal modes 5/6/7 (Spec 306).
- L/R border geometric boundaries (Spec 307).
- v3-ws-server default flip.
- MCP `headless_render_screen` renderer param.
- Snapshot renderer removal (Phase 6).
- Game-level pixel debugging.

## Acceptance gates

1. 297 + 300 + 301 + 302 still green.
2. Build green.
3. Pixel-diff harness produces output JSON + console summary; no
   crash on literal path; literal frame non-empty.
4. BASIC-ready test:
   - >50% non-background pixels in text region (col 50..330, row
     50..220)
   - all palette indices in [0, 15]
5. motm BASIC-ready smoke unchanged.

## Implementation

### Field + flag

```ts
public useLiteralPortVicFb: boolean = false;
this.useLiteralPortVicFb = opts.useLiteralPortVicFb ?? this.useLiteralPortVicReads;
```

### renderToPng default branch

```ts
renderToPng(path, opts) {
  if (opts?.renderer === "literal-port" && this.literalPortFb) {
    return this.renderLiteralPortToPng(path);
  }
  // Spec 303: default to literal-port when flag opted in.
  if (opts?.renderer === undefined &&
      this.useLiteralPortVicFb &&
      this.literalPortFb) {
    return this.renderLiteralPortToPng(path);
  }
  // ... existing snapshot path ...
}
```

### Diff harness shape

```text
Spec 303 framebuffer diff — BASIC ready
literal: 384×272 = 104448 px
vice:    384×272 = 104448 px
exact match: 87234 px (83.5%)
delta:       17214 px (16.5%) — mostly border bands (L/R differ)
worst row 12: 384 px differ
worst row 271: 384 px differ
```

## Deliverables

- `specs/303-literal-vic-fb-authority.md` (this)
- `docs/vic-ii-literal-port-phase5-mini-phase0-2026-05-10.md`
- `scripts/smoke-vic-303-fb-diff.mjs`
- `scripts/smoke-vic-303-basic-ready.mjs`
- Patch to `src/runtime/headless/integrated-session.ts`

## Results (v1)

- Build green.
- 297a + 297k + 300 + 301 + 302 regressions all PASS.
- **Pixel-diff harness (BASIC ready):**
  - rendered 384×272 both via `vice-rasterized` and `literal-port`
  - exact pixel match: **98800 / 104448 = 94.59%**
  - differ: 5648 px (border bands; worst rows = 35, 235 = 320 px each
    = top/bottom border edge offset; lines 59-65 ≈ 150 px = L/R
    border edge; matches Phase 0 risk #6 documented crop offset)
  - distinct colors: vice=2, literal=2 (BASIC ready = 2-color scene)
  - PASS: literal frame non-empty
- **BASIC-ready acceptance:**
  - dimensions = 384×272 ✓
  - central region non-background: 47465/48280 = 98.31% ✓
  - distinct colors = 2 (= bg + screen color, expected for boot)
  - out-of-palette pixels = 0 (all RGBs in colodore palette) ✓

### Notes

- The 5.4% pixel diff is structural: VicIIVice snapshot crop is
  (X=0, Y=15), literal port crop is (X=96, Y=16). Top/bottom rows 35
  and 235 differ across full width (= border boundary offset by 1
  px). Inner-region L/R border bands of 30-50 px differ similarly.
  Within the screen display area (cols 50-330, rows 50-220) the
  match approaches 100% because both paths converge on the same
  text-mode pixel decode.
- Documented crop alignment is a follow-up (out of Spec 303 scope per
  Phase 0.6 do-not-investigate list).

## Next slice

Phase 5 follow-ups — Spec 304 (sprite priority), Spec 305 (Y-expansion),
Spec 306 (illegal modes), Spec 307 (L/R border) — each as own sub-spec
with own mini Phase 0 + acceptance.

After Phase 5 follow-ups: Phase 6 = remove dual truth (VicIIVice →
facade → removed in fidelity mode).
