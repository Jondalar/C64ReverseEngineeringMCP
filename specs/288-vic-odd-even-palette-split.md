# Spec 288 — VIC-II odd/even line palette split

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 282

## Goal

Per-line palette alternation (= even raster lines use one 16-RGB
table, odd lines use another). VICE optional via
`SEPERATE_ODD_EVEN_COLORS` (default ON for TOBIAS_COLORS). Subtle
chroma scanline ripple visible on CRT, mostly invisible on LCD.

## VICE source

- `vicii-color.c:367+` — per-revision `_even` / `_odd` 16-RGB
  tables for 6569r1, 6569r5, 8565r2.

## Plan

- 288a: Extend `palettes.ts` shape: each measured palette gains
  optional `even: Palette16` + `odd: Palette16` siblings.
- 288b: Renderer per-line: select palette based on `line & 1`.
  Default behavior: if no even/odd siblings present, use base.
- 288c: Pre-compute even/odd RGB tables for 6569r1, 6569r5,
  8565r2 (= 3 chip revisions VICE ships with split tables).

## OQs

- **OQ1:** Default: enabled or disabled? (a) On for chips that
  have tables, (b) Off by default + opt-in. Default (a) match
  VICE default.
- **OQ2:** Pepto/Colodore split? They're computed (no measured
  even/odd). VICE only splits TOBIAS palettes. Skip pepto/colodore
  split? Default skip — only Tobias chips.
- **OQ3:** Test gate: (a) byte-equal even/odd table values vs
  reference, (b) line-N pixel uses even table, line-N+1 odd. (c)
  281+282 regression intact. Default all three.

## Acceptance

- [ ] 6569r1, 6569r5, 8565r2 each have _even + _odd 16-RGB tables
- [ ] Renderer alternates palette per line for those chips
- [ ] Pepto / Colodore unaffected (single table)
- [ ] All previous smokes still pass
