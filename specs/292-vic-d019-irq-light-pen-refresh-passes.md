# Spec 292 — D019 IRQ state machine + light pen + refresh + 2-pass renderer

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 281

## Goal

Four medium gaps bundled:

1. **$D019 IRQ state machine**: full vicii-irq.c port (165 LOC of
   edge-tracked IRQ flag state machine). Currently we re-fire the
   alarm + maintain bit-7 summary, but VICE's edge tracking
   handles mid-cycle edge cases (level-vs-edge, multiple edges
   in one instruction).
2. **Light pen $D013/$D014**: stub returns 0. Real VICE models
   light-gun via viewport scanner callback. Functional impl.
3. **Refresh cycles 11-15**: explicit modeling of 5 refresh
   cycles (currently sandwiched in badline DMA).
4. **Foreground/background renderer pass split**: VICE has
   explicit 2-pass pattern (bg pass + fg pass over bg). We
   merge into one mode emitter; refactor for parity introspection.

## VICE source

- `vicii-irq.c` — full IRQ state machine.
- `vicii.c:702 light_pen` — `vicii_trigger_light_pen` callback.
- `vicii-fetch.c` — refresh cycles in r-access slot.
- `vicii-draw.c` — `draw_*_background` + `draw_*_foreground` 2-pass.

## Plan

- 292a: Port vicii_irq_check_state (165 LOC) → ts equivalent.
  Edge-triggered state for raster-line, sprite-bg-coll,
  sprite-sp-coll, light-pen.
- 292b: Light pen functional impl: `triggerLightPen(x, y)`
  records X/Y in `$D013`/`$D014`, asserts bit 3 of `$D019`.
- 292c: Refresh cycles: bus-trace events for 5 r-access cycles
  per line.
- 292d: 2-pass renderer split: extract `draw_*_background` +
  `draw_*_foreground` pair per mode. Background pass writes bg
  colors only; foreground pass overdraws fg pixels.

## OQs

- **OQ1:** Bundle scope. (a) All 4 in one spec (= as drafted). (b)
  Split into 4 specs (292/293/294/295). Default (a) — keep tight,
  small total LOC.
- **OQ2:** Light pen UI hookup? Currently no UI consumer. (a)
  Just functional API + MCP tool, (b) skip light pen. Default
  (a) — full parity ALLES.
- **OQ3:** 2-pass refactor risk. Current 1-pass renderer works.
  (a) Refactor (= touches active path), (b) keep 1-pass + just
  expose pass labels in trace. Default (b) — minimal risk, get
  introspection without rewrite.
- **OQ4:** Test gate per sub-feature: (a) synthetic IRQ edge
  test + (c) regression. Default both.

## Acceptance

- [ ] vicii-irq.c full port (165 LOC equivalent)
- [ ] Light pen X/Y trigger + $D019 bit 3 assert
- [ ] Refresh-cycle bus events emitted (5 per line)
- [ ] Renderer pass labels in trace (1-pass impl, 2-pass labels)
- [ ] All previous smokes pass
