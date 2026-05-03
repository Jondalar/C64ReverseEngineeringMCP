// VIC II model — Spec 065 phased implementation.
//
// Phase 65a (this sprint): registers $D000-$D02E + memory pointer
// helpers. No rendering yet — just the data plumbing so KERNAL +
// games that read/write VIC registers see consistent state. Replaces
// the Sprint-66 vic-stub minimum.
//
// Phase 65b adds the framebuffer + text-mode renderer.
// Phase 65c wires raster IRQ to the C64 6510 IRQ line.
// Phase 65d-g per spec.

import type { HeadlessMemoryBus } from "../memory-bus.js";

export const VIC_BASE = 0xd000;

// Register indices (offset from $D000). Mirrored to fill $D000-$D3FF
// (VIC's 1KB allocation): regs 0-46 valid, others read $FF / write
// ignored.
export const VIC_NUM_REGS = 0x2f;

export const VIC_R_SP_X_LO = 0x00; // $D000-$D00E even = sprite X low
export const VIC_R_SP_Y    = 0x01; // $D001-$D00F odd = sprite Y
export const VIC_R_SP_X_MSB = 0x10;
export const VIC_R_CTRL1   = 0x11;
export const VIC_R_RASTER  = 0x12;
export const VIC_R_LIGHTPEN_X = 0x13;
export const VIC_R_LIGHTPEN_Y = 0x14;
export const VIC_R_SP_ENABLE = 0x15;
export const VIC_R_CTRL2   = 0x16;
export const VIC_R_SP_Y_EXP = 0x17;
export const VIC_R_MEM_PTR = 0x18;
export const VIC_R_IRQ_STATUS = 0x19;
export const VIC_R_IRQ_MASK = 0x1a;
export const VIC_R_SP_PRIO = 0x1b;
export const VIC_R_SP_MC   = 0x1c;
export const VIC_R_SP_X_EXP = 0x1d;
export const VIC_R_SP_SP_COLL = 0x1e;
export const VIC_R_SP_BG_COLL = 0x1f;
export const VIC_R_BORDER_COL = 0x20;
export const VIC_R_BG_COL_0 = 0x21;
export const VIC_R_BG_COL_1 = 0x22;
export const VIC_R_BG_COL_2 = 0x23;
export const VIC_R_BG_COL_3 = 0x24;
export const VIC_R_SP_MC_COL_1 = 0x25;
export const VIC_R_SP_MC_COL_2 = 0x26;
export const VIC_R_SP_COL_BASE = 0x27; // $D027-$D02E

// IRQ source bits in $D019.
export const VIC_IRQ_RASTER = 0x01;
export const VIC_IRQ_SP_BG = 0x02;
export const VIC_IRQ_SP_SP = 0x04;
export const VIC_IRQ_LIGHTPEN = 0x08;
export const VIC_IRQ_SUMMARY = 0x80;

export class VicII {
  // Register backing store. Reads-with-side-effects implemented in
  // the read switch; otherwise this array is the source of truth.
  public readonly regs = new Uint8Array(VIC_NUM_REGS + 1);
  // Current raster line (0-311 PAL / 0-262 NTSC). Distinct from the
  // $D012 latch register because the latch is also writable as the
  // raster-IRQ compare value. Sprint 78 (Phase 65c): ticks per CPU
  // cycle.
  public rasterLine = 0;
  public horizontalCycle = 0; // 0..62 PAL, 0..64 NTSC
  public maxRasterLine = 311; // PAL
  public cyclesPerLine = 63;  // PAL
  // IRQ status bits.
  public irqStatus = 0;
  // Pre-computed raster compare value (D012 low + D011 bit 7).
  // Recomputed lazily on read of irqAsserted / on write of those regs.

  // Read returns DDR-aware semantics for the few special registers
  // ($D011 raster bit 8, $D012 raster low, $D019 status with bit 7
  // summary, $D01E/$D01F collisions clear-on-read).
  read(reg: number): number {
    const r = reg & 0x3f;
    switch (r) {
      case VIC_R_CTRL1:
        // Bit 7 = current raster line bit 8 (live).
        return (this.regs[VIC_R_CTRL1]! & 0x7f) | ((this.rasterLine & 0x100) >> 1);
      case VIC_R_RASTER:
        return this.rasterLine & 0xff;
      case VIC_R_IRQ_STATUS: {
        // Returns pending flags + bit 7 summary if any masked source.
        const masked = this.irqStatus & this.regs[VIC_R_IRQ_MASK]! & 0x0f;
        const summary = masked !== 0 ? VIC_IRQ_SUMMARY : 0;
        return (this.irqStatus & 0x0f) | summary;
      }
      case VIC_R_SP_SP_COLL: {
        const v = this.regs[VIC_R_SP_SP_COLL]!;
        this.regs[VIC_R_SP_SP_COLL] = 0; // read-clears
        return v;
      }
      case VIC_R_SP_BG_COLL: {
        const v = this.regs[VIC_R_SP_BG_COLL]!;
        this.regs[VIC_R_SP_BG_COLL] = 0;
        return v;
      }
      default:
        if (r > VIC_NUM_REGS) return 0xff; // unmapped
        return this.regs[r]!;
    }
  }

  write(reg: number, value: number): void {
    const r = reg & 0x3f;
    const v = value & 0xff;
    switch (r) {
      case VIC_R_CTRL1:
        // Bit 7 of $D011 also writes the raster-IRQ-compare bit 8.
        this.regs[VIC_R_CTRL1] = v;
        // Sprint 85: re-evaluate compare immediately if write changes
        // bit 8 such that we now match current rasterLine.
        this.checkRasterCompareImmediate();
        return;
      case VIC_R_RASTER:
        // Write = raster IRQ compare value (low byte). Bit 8 is in
        // $D011 bit 7. We store separately from rasterLine.
        this.regs[VIC_R_RASTER] = v;
        this.checkRasterCompareImmediate();
        return;
      case VIC_R_IRQ_STATUS:
        // Write 1-to-clear semantics on bits 0-3.
        this.irqStatus &= ~(v & 0x0f);
        return;
      case VIC_R_IRQ_MASK:
        this.regs[VIC_R_IRQ_MASK] = v & 0x0f;
        return;
      default:
        if (r > VIC_NUM_REGS) return;
        this.regs[r] = v;
        return;
    }
  }

  // True iff the VIC's IRQ line should be asserted (any masked status
  // bit set). Phase 65c wires this into the IntegratedSession IRQ
  // check.
  irqAsserted(): boolean {
    return (this.irqStatus & this.regs[VIC_R_IRQ_MASK]! & 0x0f) !== 0;
  }

  // Sprint 85: re-evaluate raster compare on $D011/$D012 writes. If
  // current rasterLine matches new compare value, set IFR_RASTER so
  // IRQ fires before next CPU instruction. Real chip: latches on cycle
  // boundary; we approximate by firing immediately on write.
  private checkRasterCompareImmediate(): void {
    const compare = this.regs[VIC_R_RASTER]! | ((this.regs[VIC_R_CTRL1]! & 0x80) ? 0x100 : 0);
    if (this.rasterLine === compare) {
      this.irqStatus |= VIC_IRQ_RASTER;
    }
  }

  // Memory pointer ($D018) decoded into the on-bank addresses VIC
  // fetches from. VIC sees a 16KB bank selected by CIA2 PA bits 0-1
  // (0=$0000-$3FFF, 1=$4000-$7FFF, 2=$8000-$BFFF, 3=$C000-$FFFF —
  // actually inverted on the chip, but conventional documentation
  // reverses; details matter for Phase 65b).
  screenRamOffset(): number { return ((this.regs[VIC_R_MEM_PTR]! >> 4) & 0x0f) << 10; }
  charRomOffsetWithinBank(): number { return ((this.regs[VIC_R_MEM_PTR]! >> 1) & 0x07) << 11; }
  bitmapBaseWithinBank(): number { return ((this.regs[VIC_R_MEM_PTR]! & 0x08) !== 0) ? 0x2000 : 0x0000; }

  // Sprint 78: tick raster forward by N CPU cycles. Sets IFR_RASTER
  // when the line counter matches the compare value (D012 low + D011
  // bit 7 = bit 8 of compare).
  //
  // Sprint 84 (Spec 084): also returns stolen cycles for bad-line +
  // sprite-DMA. Caller charges these to the wall clock (CIA + drive
  // tick budgets advance accordingly) but CPU does not execute during
  // the stolen window — VIC has bus.
  tick(cycles: number): { stolenCycles: number } {
    if (cycles <= 0) return { stolenCycles: 0 };
    let stolen = 0;
    let remaining = cycles;
    while (remaining > 0) {
      const stepThisLine = Math.min(this.cyclesPerLine - this.horizontalCycle, remaining);
      this.horizontalCycle += stepThisLine;
      remaining -= stepThisLine;
      if (this.horizontalCycle >= this.cyclesPerLine) {
        this.horizontalCycle = 0;
        this.rasterLine = (this.rasterLine + 1) % (this.maxRasterLine + 1);
        // Compare match.
        const compare = this.regs[VIC_R_RASTER]! | ((this.regs[VIC_R_CTRL1]! & 0x80) ? 0x100 : 0);
        if (this.rasterLine === compare) {
          this.irqStatus |= VIC_IRQ_RASTER;
        }
        // Sprint 84: bad-line + sprite-DMA stealing on this new line.
        if (this.isBadLine()) stolen += 40;
        stolen += this.spriteDmaCycles();
      }
    }
    return { stolenCycles: stolen };
  }

  // Bad line per VIC chip spec: in display window (raster 0x30..0xF7)
  // when DEN=1 and (raster & 7) == YSCROLL. VIC fetches char matrix
  // for 40 cycles, CPU pauses.
  isBadLine(): boolean {
    const ctrl1 = this.regs[VIC_R_CTRL1]!;
    if (!(ctrl1 & 0x10)) return false; // DEN
    if (this.rasterLine < 0x30 || this.rasterLine > 0xf7) return false;
    return (this.rasterLine & 7) === (ctrl1 & 7);
  }

  // Sprite DMA: each enabled sprite at its Y position uses 2 cycles
  // for s-access. Approximation: charge them all at line start.
  spriteDmaCycles(): number {
    const enable = this.regs[VIC_R_SP_ENABLE]!;
    if (enable === 0) return 0;
    let stolen = 0;
    for (let s = 0; s < 8; s++) {
      if (!(enable & (1 << s))) continue;
      const yMatch = this.rasterLine === this.regs[VIC_R_SP_Y + s * 2]!;
      if (yMatch) stolen += 2;
    }
    return stolen;
  }

  setNtsc(): void {
    this.maxRasterLine = 262;
    this.cyclesPerLine = 65;
  }

  reset(): void {
    this.regs.fill(0);
    this.rasterLine = 0;
    this.horizontalCycle = 0;
    this.irqStatus = 0;
  }
}

export function installVicII(bus: HeadlessMemoryBus): VicII {
  const vic = new VicII();
  for (let r = 0; r < VIC_NUM_REGS + 1; r++) {
    const addr = VIC_BASE + r;
    bus.registerIoHandler(addr, {
      read: () => vic.read(r),
      write: (_a, value) => vic.write(r, value),
    });
  }
  // VIC mirrors across $D000-$D3FF — pre-register the mirrors too so
  // game code that pokes $D040 etc. hits the right register.
  for (let mirror = 0x40; mirror < 0x400; mirror += 0x40) {
    for (let r = 0; r < VIC_NUM_REGS + 1; r++) {
      const addr = VIC_BASE + mirror + r;
      bus.registerIoHandler(addr, {
        read: () => vic.read(r),
        write: (_a, value) => vic.write(r, value),
      });
    }
  }
  return vic;
}
