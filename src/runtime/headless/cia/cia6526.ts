// MOS 6526 CIA implementation, clean-room from datasheet + cross-checked
// against VICE source. No code lifted. Project remains MIT.
//
// Spec 064 Sprint 69a. Both CIA1 and CIA2 use this; they differ only
// in their port backend assignments (CIA1 = keyboard/joystick,
// CIA2 = IEC bus / VIC bank / RS232).
//
// Register layout (16 registers, mirrored across the 256-byte CIA
// allocation $DC00 / $DD00):
//   $0  PRA          port A data register (DDRA-aware read)
//   $1  PRB          port B
//   $2  DDRA         data direction A
//   $3  DDRB         data direction B
//   $4  TA-LO        timer A counter low (read = current, write = latch low)
//   $5  TA-HI        timer A counter high (write = latch high; if TA stopped also loads counter)
//   $6  TB-LO        timer B counter low
//   $7  TB-HI        timer B counter high
//   $8  TOD-10TH     time of day, tenths of second (BCD)
//   $9  TOD-SEC
//   $A  TOD-MIN
//   $B  TOD-HR       (with AM/PM bit 7)
//   $C  SDR          serial data register
//   $D  ICR          interrupt control register
//   $E  CRA          timer A control register
//   $F  CRB          timer B control register
//
// ICR semantics (the part that matters most for KERNAL serial timing):
//   Read: returns flags bits 0-4 + bit 7 = 1 if any flag is set AND
//         the corresponding mask bit is enabled. Side effect: ALL
//         flag bits are cleared after read. (Different from VIA which
//         clears per-bit on register-specific reads.)
//   Write: bit 7 = 1 → enable mask bits with v=1.
//          bit 7 = 0 → disable mask bits with v=1.
//
// Acknowledging the IRQ by reading ICR releases the IRQ line. KERNAL
// serial routines depend on this exact behavior.

export const CIA_PRA = 0x0;
export const CIA_PRB = 0x1;
export const CIA_DDRA = 0x2;
export const CIA_DDRB = 0x3;
export const CIA_TALO = 0x4;
export const CIA_TAHI = 0x5;
export const CIA_TBLO = 0x6;
export const CIA_TBHI = 0x7;
export const CIA_TOD_10TH = 0x8;
export const CIA_TOD_SEC = 0x9;
export const CIA_TOD_MIN = 0xa;
export const CIA_TOD_HR = 0xb;
export const CIA_SDR = 0xc;
export const CIA_ICR = 0xd;
export const CIA_CRA = 0xe;
export const CIA_CRB = 0xf;

export const ICR_TA = 0x01;
export const ICR_TB = 0x02;
export const ICR_TOD_ALARM = 0x04;
export const ICR_SP = 0x08;
export const ICR_FLAG = 0x10;
export const ICR_IRQ_SUMMARY = 0x80;

export type CiaWriteCause = "or" | "ddr" | "reset";

export interface CiaPortBackend {
  readPins(): number;
  onOutputChanged(orValue: number, ddrMask: number, cause: CiaWriteCause): void;
}

export class Cia6526 {
  // Port latches.
  public pra = 0;
  public prb = 0;
  public ddra = 0;
  public ddrb = 0;
  // Timers.
  public taCounter = 0;
  public taLatch = 0;
  public tbCounter = 0;
  public tbLatch = 0;
  // Control regs.
  public cra = 0;
  public crb = 0;
  // ICR.
  public icrFlags = 0;
  public icrMask = 0;
  // SDR (stub — not modeled).
  public sdr = 0;
  // TOD (stub — returns zeros).
  // Could implement a real TOD counter but no widely-used game depends
  // on its IRQ; defer.

  constructor(public readonly portA: CiaPortBackend, public readonly portB: CiaPortBackend) {}

  read(reg: number): number {
    switch (reg & 0xf) {
      case CIA_PRA: {
        const pins = this.portA.readPins();
        return ((this.pra & this.ddra) | (pins & ~this.ddra)) & 0xff;
      }
      case CIA_PRB: {
        const pins = this.portB.readPins();
        return ((this.prb & this.ddrb) | (pins & ~this.ddrb)) & 0xff;
      }
      case CIA_DDRA: return this.ddra;
      case CIA_DDRB: return this.ddrb;
      case CIA_TALO: return this.taCounter & 0xff;
      case CIA_TAHI: return (this.taCounter >> 8) & 0xff;
      case CIA_TBLO: return this.tbCounter & 0xff;
      case CIA_TBHI: return (this.tbCounter >> 8) & 0xff;
      case CIA_TOD_10TH: case CIA_TOD_SEC:
      case CIA_TOD_MIN: case CIA_TOD_HR: return 0; // stub
      case CIA_SDR: return this.sdr;
      case CIA_ICR: {
        // Read returns current flags + IRQ-summary bit. Side effect:
        // clears all flag bits + drops IRQ line.
        const flags = this.icrFlags & 0x1f;
        const summary = (flags & this.icrMask) !== 0 ? ICR_IRQ_SUMMARY : 0;
        this.icrFlags = 0;
        return flags | summary;
      }
      case CIA_CRA: return this.cra;
      case CIA_CRB: return this.crb;
      default: return 0;
    }
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    switch (reg & 0xf) {
      case CIA_PRA:
        this.pra = v;
        this.portA.onOutputChanged(this.pra, this.ddra, "or");
        return;
      case CIA_PRB:
        this.prb = v;
        this.portB.onOutputChanged(this.prb, this.ddrb, "or");
        return;
      case CIA_DDRA:
        this.ddra = v;
        this.portA.onOutputChanged(this.pra, this.ddra, "ddr");
        return;
      case CIA_DDRB:
        this.ddrb = v;
        this.portB.onOutputChanged(this.prb, this.ddrb, "ddr");
        return;
      case CIA_TALO:
        this.taLatch = (this.taLatch & 0xff00) | v;
        return;
      case CIA_TAHI:
        this.taLatch = (this.taLatch & 0x00ff) | (v << 8);
        // If timer A is stopped, writing TAHI also reloads counter.
        if ((this.cra & 0x01) === 0) this.taCounter = this.taLatch;
        return;
      case CIA_TBLO:
        this.tbLatch = (this.tbLatch & 0xff00) | v;
        return;
      case CIA_TBHI:
        this.tbLatch = (this.tbLatch & 0x00ff) | (v << 8);
        if ((this.crb & 0x01) === 0) this.tbCounter = this.tbLatch;
        return;
      case CIA_TOD_10TH: case CIA_TOD_SEC:
      case CIA_TOD_MIN: case CIA_TOD_HR: return; // stub
      case CIA_SDR: this.sdr = v; return;
      case CIA_ICR:
        if ((v & 0x80) !== 0) this.icrMask |= (v & 0x1f);
        else this.icrMask &= ~(v & 0x1f);
        return;
      case CIA_CRA:
        // Bit 4 (FORCE LOAD): copy latch → counter, no IRQ.
        if ((v & 0x10) !== 0) this.taCounter = this.taLatch;
        this.cra = v & 0xef; // clear FORCE LOAD bit (it's strobe-only)
        return;
      case CIA_CRB:
        if ((v & 0x10) !== 0) this.tbCounter = this.tbLatch;
        this.crb = v & 0xef;
        return;
    }
  }

  // Tick the CIA forward by N CPU cycles. Decrements active timers;
  // sets ICR flags + asserts IRQ on underflow per ICR mask.
  tick(cycles: number): void {
    if (cycles <= 0) return;
    this.tickTimerA(cycles);
    this.tickTimerB(cycles);
  }

  private tickTimerA(cycles: number): void {
    // Bit 0 = START. Bit 5 = IN-MODE (0=Φ2, 1=CNT). We only model Φ2.
    if ((this.cra & 0x01) === 0) return;
    if ((this.cra & 0x20) !== 0) return; // CNT mode not modeled
    let remaining = cycles;
    const oneShot = (this.cra & 0x08) !== 0;
    while (remaining > 0) {
      if (remaining <= this.taCounter) {
        this.taCounter -= remaining;
        return;
      }
      remaining -= (this.taCounter + 1);
      this.taCounter = this.taLatch;
      this.icrFlags |= ICR_TA;
      if (oneShot) {
        this.cra &= ~0x01; // clear START
        return;
      }
    }
  }

  private tickTimerB(cycles: number): void {
    if ((this.crb & 0x01) === 0) return;
    // Bits 5-6: 00=Φ2, others not modeled (CNT, TA-underflow chain).
    if ((this.crb & 0x60) !== 0) return;
    let remaining = cycles;
    const oneShot = (this.crb & 0x08) !== 0;
    while (remaining > 0) {
      if (remaining <= this.tbCounter) {
        this.tbCounter -= remaining;
        return;
      }
      remaining -= (this.tbCounter + 1);
      this.tbCounter = this.tbLatch;
      this.icrFlags |= ICR_TB;
      if (oneShot) {
        this.crb &= ~0x01;
        return;
      }
    }
  }

  // True iff the CIA's IRQ line should be asserted.
  irqAsserted(): boolean {
    return (this.icrFlags & this.icrMask & 0x1f) !== 0;
  }

  reset(): void {
    this.pra = 0; this.prb = 0;
    this.ddra = 0; this.ddrb = 0;
    this.taCounter = 0; this.taLatch = 0;
    this.tbCounter = 0; this.tbLatch = 0;
    this.cra = 0; this.crb = 0;
    this.icrFlags = 0; this.icrMask = 0;
    this.sdr = 0;
    this.portA.onOutputChanged(0, 0, "reset");
    this.portB.onOutputChanged(0, 0, "reset");
  }
}
