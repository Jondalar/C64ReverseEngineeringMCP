# Spec 085 — VIC raster IRQ cycle-perfect

## Problem

Headless VIC raster IRQ currently fires when `rasterLine` updates equal `compareLine`. This is "line-granular" — IRQ may be serviced anywhere in the line, not at cycle 0 of the target line. Demos, music players, and games with split-screen effects need IRQ to fire on cycle 0 of the new line so raster bars start at the right pixel.

## Decision

VIC.tick() raises IRQ at the EXACT cycle the raster counter changes to compare value. Integrated session services interrupts BEFORE the next CPU instruction step, so IRQ vector dispatch happens at the right cycle.

Stable raster (NMI workaround) is **out of scope** — added to REQUIREMENTS.md backlog for later spec.

## Scope

### VIC tick

```ts
tick(consumedCycles: number): VicTickResult {
  let irqRaised = false;
  for (let i = 0; i < consumedCycles; i++) {
    this.horizontalCycle++;
    if (this.horizontalCycle >= LINE_CYCLES_PAL) {
      this.horizontalCycle = 0;
      this.rasterLine = (this.rasterLine + 1) % FRAME_LINES_PAL;
      // raster compare: IRQ fires on cycle 0 of new line
      const compareLine = this.regs[0x12] | ((this.regs[0x11] & 0x80) << 1);
      if (this.rasterLine === compareLine) {
        this.irqStatus |= VIC_IRQ_RASTER;
        if (this.irqMask & VIC_IRQ_RASTER) irqRaised = true;
      }
    }
  }
  return { irq: irqRaised, stolenCycles: ... };
}
```

### CPU IRQ service ordering

Currently:
```ts
checkC64Interrupts(); // before step
this.c64Cpu.step();
```

Keep this — IRQ check before step ensures cycle-0 IRQ is taken before next instruction. Verify the IRQ flag latches across multiple cycles within a single instruction's bus access pattern (current 6510 model is instruction-atomic, so OK).

### Raster compare write

When game writes $D011 (bit 7 of compare) or $D012 (low 8 bits), update compareLine immediately. If new compare equals current rasterLine + horizontalCycle is 0, fire immediately (some demos rely on "IRQ now if compare match").

### IRQ ack via $D019

Already implemented (write-1-to-clear). Verify clear ack is cycle-stamped so re-fire only happens on next compare match, not same cycle.

## Out of scope

- Stable raster NMI workaround (REQUIREMENTS.md backlog).
- Sprite-sprite / sprite-bg IRQ exact timing (current line-granular OK for most games).
- Light pen IRQ.

## Acceptance

- Smoke: enable raster IRQ on line 100, IRQ vector PC = $EA31 (default) called → measure cycle delta from $D011/$D012 raster value at IRQ entry vs target → should be ≤ 7 cycles (IRQ dispatch overhead).
- Demo with raster bars: bars stable across frames (no jitter beyond ±1 line).
- Music players (SID-driven via raster IRQ) tempo correct.
