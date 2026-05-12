# Spec 084 — VIC bad-line + sprite DMA cycle stealing

## Problem

VIC-II steals CPU cycles via the BA/AEC bus-arbitration pins:
- **Bad line**: every 8 raster lines in display window, VIC fetches the character matrix → 40 cycles stolen from CPU (BA pulled low ~3 cycles before, AEC takes bus for c-access).
- **Sprite DMA**: every active sprite at its Y position uses 2 cycles for s-access (sprite data fetch).

Headless currently ignores both — VIC.tick() advances raster but doesn't pause CPU. Result: timing-sensitive code (raster bars, music sync, demo effects, some games' raster-IRQ-driven main loops) runs at wrong tempo. Also: ACPTR / KERNAL serial routines that interleave with VIC depend on bad-line stalls for IEC bit timing on real HW.

## Decision

VIC.tick() returns "stolen cycles" to the integrated session, which subtracts them from the CPU cycle budget. Bad-line + sprite DMA modelled together (both happen in the same VIC tick path, share the BA/AEC mechanism).

## Scope

### Bad-line detection

```ts
isBadLine(): boolean {
  // bad lines occur in raster lines 0x30..0xF7 inclusive when DEN=1
  if (!(this.regs[0x11] & 0x10)) return false; // DEN bit
  if (this.rasterLine < 0x30 || this.rasterLine > 0xF7) return false;
  return ((this.rasterLine & 7) === (this.regs[0x11] & 7)); // YSCROLL match
}
```

### Sprite DMA detection per raster line

Each sprite enabled in $D015 + Y position matches current raster line → 2 cycles stolen at the sprite's fetch slot (cycles 55-15 horizontally — but for our purposes, sum stolen cycles per line).

```ts
spriteDmaCycles(): number {
  if ((this.regs[0x15] & 0xff) === 0) return 0;
  let stolen = 0;
  for (let s = 0; s < 8; s++) {
    if (!(this.regs[0x15] & (1 << s))) continue;
    const yMatch = this.rasterLine === this.regs[0x01 + s*2];
    if (yMatch) stolen += 2;
  }
  return stolen;
}
```

### tick() returns stolen cycles

```ts
tick(cycles: number): { irq: boolean; stolenCycles: number } {
  let stolen = 0;
  // advance horizontalCycle, rasterLine
  // when entering a new raster line:
  if (justEnteredNewLine) {
    if (this.isBadLine()) stolen += 40;
    stolen += this.spriteDmaCycles();
  }
  return { irq: irqAsserted, stolenCycles: stolen };
}
```

### Integration in `stepC64Instruction`

```ts
const consumed = this.c64Cpu.cycles - before;
const { stolenCycles } = this.vic.tick(consumed);
this.c64Cpu.cycles += stolenCycles; // CPU pause = "extra cycles passed" without instruction
this.cia1.tick(consumed + stolenCycles); // CIA timers count Φ2 = real time
this.cia2.tick(consumed + stolenCycles);
```

Net effect: CPU does 1 instruction, but emulator advances "wall clock" by instruction_cycles + VIC_stolen_cycles. CIA + drive accumulator advance accordingly.

### Edge cases

- DEN $D011 bit 4 toggles mid-frame: bad lines stop / start.
- YSCROLL change mid-frame: changes which raster lines become bad.
- Sprite enable mid-line: only counts for next line.
- Sprite Y change: only counts for next match.

## Out of scope

- Cycle-exact placement of stolen cycles within a line (we approximate by deducting all at line start).
- VIC color RAM access steals (always 1 cycle per c-access — already part of bad-line 40).
- Pixel-accurate VIC chip vs CPU access timing.

## Acceptance

- Spiele die raster-IRQ + main-loop synced erwarten laufen ohne tempo-drift.
- Smoke test: enable VIC display, set $D012 raster IRQ on line 100, count CPU cycles between 2 IRQs → should equal (63 cycles/line PAL × 312 lines) - bad lines for that line if applicable.
- VICE trace diff: instruction count per frame nahe (~95%+) VICE für identisches Spiel-State.
