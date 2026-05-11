# Spec 293 — VIC-II light pen $D013/$D014

**Sprint:** 144  **Status:** RESOLVED 2026-05-09  **Depends:** 292

**Resolved:** Functional API + MCP tool + $D019 bit-3 wiring; test
= synth + regression.

## Goal

Functional light-pen impl. Today $D013/$D014 stub returns 0. VICE
records X/Y on `vicii_trigger_light_pen(x, y)` callback + asserts
$D019 bit 3 (LP IRQ).

## VICE source

- `vicii.c:702 vicii_trigger_light_pen(x, y)` — sets light_pen.x +
  light_pen.y, asserts LP IRQ via vicii_irq.
- `vicii-mem.c` reads of $D013 / $D014 return latched x/y.

## Plan

- 293a: Add `lightPen: { x: number; y: number; triggered: boolean }`
  to vic state.
- 293b: `IntegratedSession.triggerLightPen(x, y)` → updates state +
  asserts $D019 bit 3 via Spec 292 IRQ state machine.
- 293c: $D013/$D014 read returns latched values.
- 293d: MCP tool `headless_trigger_light_pen` for V3 introspection.

## Acceptance

- [ ] triggerLightPen(x, y) sets $D013/$D014 + $D019 bit 3
- [ ] $D013/$D014 reads return latched x/y
- [ ] MCP tool callable
- [ ] All previous smokes pass
