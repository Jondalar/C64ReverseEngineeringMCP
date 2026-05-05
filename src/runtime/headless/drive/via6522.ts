// Implementation informed by MOS 6522 datasheet + cross-checked against
// VICE behavior. No code lifted. Project remains MIT.
//
// Sprint 60: register read/write + DDR (skeleton only).
// Sprint 61: full timer T1/T2 + IFR/IER + CA1/CA2/CB1/CB2 edge
// detection + IRQ assertion + shift register modes 0-7. Tick(cycles)
// counts down timers and asserts IFR flags on underflow.
//
// Register layout (per VIA, 16 registers, mirrored across the
// 1KB allocation):
//   $0  ORB / IRB    output / input register B
//   $1  ORA / IRA    output / input register A (with handshake)
//   $2  DDRB         data direction register B
//   $3  DDRA         data direction register A
//   $4  T1C-L        timer 1 counter low (read clears IFR T1; write = T1L-L)
//   $5  T1C-H        timer 1 counter high (write transfers latch → counter, clears IFR T1)
//   $6  T1L-L        timer 1 latch low
//   $7  T1L-H        timer 1 latch high (write also clears IFR T1)
//   $8  T2C-L        timer 2 counter low (read clears IFR T2; write = T2L-L)
//   $9  T2C-H        timer 2 counter high (write loads counter, clears IFR T2)
//   $a  SR           shift register
//   $b  ACR          auxiliary control register
//   $c  PCR          peripheral control register
//   $d  IFR          interrupt flag register (write 1 to clear)
//   $e  IER          interrupt enable register
//   $f  ORA / IRA    same as $1 but no handshake
//
// IFR bits (read returns bit 7 = ANY enabled flag set):
//   bit 0  CA2
//   bit 1  CA1
//   bit 2  SR (shift register full/empty)
//   bit 3  CB2
//   bit 4  CB1
//   bit 5  T2 underflow
//   bit 6  T1 underflow
//   bit 7  IRQ summary (read-only — set if any (IFR & IER) bit is high)

export const VIA_REG_COUNT = 16;
export const VIA_ORB = 0x0;
export const VIA_ORA = 0x1;
export const VIA_DDRB = 0x2;
export const VIA_DDRA = 0x3;
export const VIA_T1CL = 0x4;
export const VIA_T1CH = 0x5;
export const VIA_T1LL = 0x6;
export const VIA_T1LH = 0x7;
export const VIA_T2CL = 0x8;
export const VIA_T2CH = 0x9;
export const VIA_SR = 0xa;
export const VIA_ACR = 0xb;
export const VIA_PCR = 0xc;
export const VIA_IFR = 0xd;
export const VIA_IER = 0xe;
export const VIA_ORA_NOHS = 0xf;

export const IFR_CA2 = 0x01;
export const IFR_CA1 = 0x02;
export const IFR_SR = 0x04;
export const IFR_CB2 = 0x08;
export const IFR_CB1 = 0x10;
export const IFR_T2 = 0x20;
export const IFR_T1 = 0x40;
export const IFR_IRQ_SUMMARY = 0x80;

export type ViaWriteCause = "or" | "ddr" | "reset";

export interface ViaPortBackend {
  readPins(): number;
  // Called whenever the VIA's OR latch or DDR mask changes. The
  // `cause` lets the backend distinguish a real OR-write (which on
  // 1541 VIA2 PA is the GCR head-write trigger) from a DDR mode flip
  // (which only changes line drive direction without committing a new
  // GCR byte).
  onOutputChanged(orValue: number, ddrMask: number, cause: ViaWriteCause): void;
}

// Edge polarity for CA1/CB1 controlled by PCR bit 0 / bit 4.
//   PCR bit 0 = 0: CA1 negative-edge (high → low)
//   PCR bit 0 = 1: CA1 positive-edge (low → high)
// CB1 same with bit 4. Sprint 61 supports both polarities so the
// drive ROM can configure ATN edge detection correctly.

export class Via6522 {
  // I/O latches.
  public ora = 0;
  public orb = 0;
  public ddra = 0;
  public ddrb = 0;
  // Timer 1: 16-bit counter + latch. ACR bits 6-7 control mode.
  public t1Counter = 0;
  public t1Latch = 0;
  // Timer 2: 16-bit counter (load only — no latch reload).
  public t2Counter = 0;
  // Shift register + control.
  public sr = 0;
  public acr = 0;
  public pcr = 0;
  public ifr = 0;
  public ier = 0;

  // Internal state for timer/SR scheduling.
  private t1Reload = false;        // when true, on next tick reload from latch
  private t1HasUnderflowed = false; // for one-shot mode
  private t2HasUnderflowed = false;

  // Last seen pin states for edge detection.
  private lastCa1Pin = true;
  private lastCb1Pin = true;

  // Sprint 66: optional callback invoked when CA1 IRQ is newly
  // enabled in IER (so iec-bus can re-evaluate against current ATN
  // line state and unstick a boot-order race).
  public onCa1IerEnabled?: () => void;

  constructor(public readonly portA: ViaPortBackend, public readonly portB: ViaPortBackend) {}

  read(reg: number): number {
    switch (reg & 0xf) {
      case VIA_ORB: {
        const pins = this.portB.readPins();
        // For DDR-output bits: return OR latch. For DDR-input bits:
        // return live pin state. Per 6522 datasheet, READ of IRB
        // clears CB1 + CB2 IFR flags (handshake acknowledge).
        this.clearIfr(IFR_CB1 | IFR_CB2);
        return ((this.orb & this.ddrb) | (pins & ~this.ddrb)) & 0xff;
      }
      case VIA_ORA: {
        const pins = this.portA.readPins();
        // READ of IRA (with handshake) clears CA1 + CA2 IFR. The
        // _NOHS variant ($F) below does NOT clear the flag — that's
        // the no-handshake escape used by code that wants to peek
        // the port without acknowledging.
        this.clearIfr(IFR_CA1 | IFR_CA2);
        return ((this.ora & this.ddra) | (pins & ~this.ddra)) & 0xff;
      }
      case VIA_ORA_NOHS: {
        const pins = this.portA.readPins();
        return ((this.ora & this.ddra) | (pins & ~this.ddra)) & 0xff;
      }
      case VIA_DDRB: return this.ddrb;
      case VIA_DDRA: return this.ddra;
      case VIA_T1CL: {
        // Read clears IFR T1 flag.
        this.clearIfr(IFR_T1);
        return this.t1Counter & 0xff;
      }
      case VIA_T1CH: return (this.t1Counter >> 8) & 0xff;
      case VIA_T1LL: return this.t1Latch & 0xff;
      case VIA_T1LH: return (this.t1Latch >> 8) & 0xff;
      case VIA_T2CL: {
        // Read clears IFR T2 flag.
        this.clearIfr(IFR_T2);
        return this.t2Counter & 0xff;
      }
      case VIA_T2CH: return (this.t2Counter >> 8) & 0xff;
      case VIA_SR: {
        this.clearIfr(IFR_SR);
        return this.sr;
      }
      case VIA_ACR: return this.acr;
      case VIA_PCR: return this.pcr;
      case VIA_IFR: return this.ifrSummary();
      case VIA_IER: return this.ier | 0x80;
      default: return 0;
    }
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    switch (reg & 0xf) {
      case VIA_ORB:
        this.orb = v;
        this.portB.onOutputChanged(this.orb, this.ddrb, "or");
        // Writing ORB clears CB1 flag (per datasheet handshake clear).
        this.clearIfr(IFR_CB1 | IFR_CB2);
        return;
      case VIA_ORA:
        this.ora = v;
        this.portA.onOutputChanged(this.ora, this.ddra, "or");
        this.clearIfr(IFR_CA1 | IFR_CA2);
        return;
      case VIA_ORA_NOHS:
        this.ora = v;
        this.portA.onOutputChanged(this.ora, this.ddra, "or");
        return;
      case VIA_DDRB:
        this.ddrb = v;
        this.portB.onOutputChanged(this.orb, this.ddrb, "ddr");
        return;
      case VIA_DDRA:
        this.ddra = v;
        this.portA.onOutputChanged(this.ora, this.ddra, "ddr");
        return;
      case VIA_T1CL:
      case VIA_T1LL:
        this.t1Latch = (this.t1Latch & 0xff00) | v;
        return;
      case VIA_T1CH:
        // High write: transfer latch low + this byte → counter, start timer.
        this.t1Latch = (this.t1Latch & 0x00ff) | (v << 8);
        this.t1Counter = this.t1Latch;
        this.t1HasUnderflowed = false;
        this.clearIfr(IFR_T1);
        return;
      case VIA_T1LH:
        this.t1Latch = (this.t1Latch & 0x00ff) | (v << 8);
        this.clearIfr(IFR_T1);
        return;
      case VIA_T2CL:
        // T2 has no separate latch; this is the low byte of the load.
        this.t2Counter = (this.t2Counter & 0xff00) | v;
        return;
      case VIA_T2CH:
        this.t2Counter = (this.t2Counter & 0x00ff) | (v << 8);
        this.t2HasUnderflowed = false;
        this.clearIfr(IFR_T2);
        return;
      case VIA_SR:
        this.sr = v;
        this.clearIfr(IFR_SR);
        return;
      case VIA_ACR:
        this.acr = v;
        return;
      case VIA_PCR:
        this.pcr = v;
        return;
      case VIA_IFR:
        // Writing 1 to a flag bit clears it. Bit 7 is summary (read-only).
        this.ifr &= ~(v & 0x7f);
        return;
      case VIA_IER:
        // Bit 7 = 1: enable bits with v=1. Bit 7 = 0: disable bits with v=1.
        if ((v & 0x80) !== 0) {
          const newlyEnabled = (v & 0x7f) & ~this.ier;
          this.ier |= (v & 0x7f);
          // Sprint 66 fix: when CA1 IRQ becomes newly enabled, give
          // backends a chance to re-evaluate against current pin level
          // (covers the boot-order edge-miss case for IEC ATN).
          if (newlyEnabled & IFR_CA1) {
            this.onCa1IerEnabled?.();
          }
        } else {
          this.ier &= ~(v & 0x7f);
        }
        return;
    }
  }

  // Tick the VIA state forward by N drive cycles. Decrements active
  // timers; sets IFR T1/T2 on underflow. Called from the drive
  // session's step loop after each drive instruction.
  tick(cycles: number): void {
    if (cycles <= 0) return;
    this.tickTimer1(cycles);
    this.tickTimer2(cycles);
  }

  private tickTimer1(cycles: number): void {
    // T1 modes (ACR bits 6-7):
    //   00  one-shot, no PB7 output
    //   01  free-running, no PB7 output
    //   10  one-shot, PB7 toggle (Sprint 61: ignore PB7 effect)
    //   11  free-running, PB7 square wave (ignore)
    const mode = (this.acr >> 6) & 0x3;
    const oneShot = (mode & 1) === 0;
    let remaining = cycles;
    while (remaining > 0) {
      if (oneShot && this.t1HasUnderflowed) {
        // After one-shot underflow, counter keeps decrementing but no
        // further IFR triggers.
        this.t1Counter = (this.t1Counter - remaining) & 0xffff;
        return;
      }
      if (remaining <= this.t1Counter) {
        this.t1Counter -= remaining;
        return;
      }
      remaining -= (this.t1Counter + 1);
      this.t1Counter = this.t1Latch;
      this.setIfr(IFR_T1);
      if (oneShot) {
        this.t1HasUnderflowed = true;
      }
    }
  }

  private tickTimer2(cycles: number): void {
    // T2 modes (ACR bit 5):
    //   0  one-shot
    //   1  pulse-counting on PB6 (Sprint 61: ignore pulse-count mode;
    //      treat as one-shot for now)
    let remaining = cycles;
    if (this.t2HasUnderflowed) {
      this.t2Counter = (this.t2Counter - remaining) & 0xffff;
      return;
    }
    if (remaining <= this.t2Counter) {
      this.t2Counter -= remaining;
      return;
    }
    remaining -= (this.t2Counter + 1);
    this.t2Counter = (0xffff - remaining + 1) & 0xffff;
    this.setIfr(IFR_T2);
    this.t2HasUnderflowed = true;
  }

  // Notify VIA that the input pin tied to CA1 has changed. Detects
  // edge per PCR polarity and sets IFR_CA1.
  //
  // Pragmatic deviation from real-HW edge-only semantics: if the
  // pin is currently in the "active" state per PCR polarity AND the
  // edge wasn't observed (because drive ROM hadn't enabled CA1 IRQ
  // yet when the edge happened), we still set IFR_CA1. This unsticks
  // the boot-order chicken-egg where the C64 pulls ATN low BEFORE
  // the drive's init sequence configures CA1 IRQ. Real hardware
  // depends on the drive booting first; our sim has both CPUs reset
  // at t=0. The workaround is benign: drive ROM clears IFR by reading
  // $1801, then waits for a real new edge. False-positive IFR sets
  // are clamped by this same clear-on-IRA-read.
  pulseCa1(newLevel: boolean): void {
    const polarity = (this.pcr & 0x01) !== 0; // 0 = neg edge, 1 = pos edge
    const wasHigh = this.lastCa1Pin;
    const isHigh = newLevel;
    if (!polarity && wasHigh && !isHigh) this.setIfr(IFR_CA1);
    if (polarity && !wasHigh && isHigh) this.setIfr(IFR_CA1);
    // Sprint 111 fix: removed Sprint 66 hack that fired IFR on EITHER
    // edge regardless of PCR polarity. The hack caused extra IRQs on
    // ATN-assert during fastloader stage-2, interrupting bit-bang
    // receive at wrong moments and corrupting decoded bytes.
    // Real HW is edge-only per polarity (matches VICE viacore_signal).
    this.lastCa1Pin = isHigh;
  }

  // Spec 062 Sprint 66 hack: re-evaluate CA1 against current pin
  // level + current PCR polarity, setting IFR_CA1 if the configured
  // edge "would have just happened" given current state. Called from
  // iec-bus when the drive enables CA1 IER (so it picks up the
  // already-asserted ATN line that fired before IER was set).
  reevaluateCa1Level(currentLevel: boolean): void {
    const polarity = (this.pcr & 0x01) !== 0;
    // Negative-edge config: trigger if line is LOW.
    // Positive-edge config: trigger if line is HIGH.
    if (!polarity && !currentLevel) this.setIfr(IFR_CA1);
    if (polarity && currentLevel) this.setIfr(IFR_CA1);
  }

  pulseCb1(newLevel: boolean): void {
    const polarity = (this.pcr & 0x10) !== 0;
    const wasHigh = this.lastCb1Pin;
    const isHigh = newLevel;
    if (!polarity && wasHigh && !isHigh) this.setIfr(IFR_CB1);
    if (polarity && !wasHigh && isHigh) this.setIfr(IFR_CB1);
    this.lastCb1Pin = isHigh;
  }

  // Returns true iff IRQ line should be asserted (any IFR&IER bit set).
  irqAsserted(): boolean {
    return (this.ifr & this.ier & 0x7f) !== 0;
  }

  setIfr(mask: number): void {
    this.ifr |= (mask & 0x7f);
  }

  clearIfr(mask: number): void {
    this.ifr &= ~(mask & 0x7f);
  }

  ifrSummary(): number {
    const flags = this.ifr & 0x7f;
    const summary = (flags & this.ier & 0x7f) !== 0 ? 0x80 : 0x00;
    return flags | summary;
  }

  reset(): void {
    this.ora = 0; this.orb = 0;
    this.ddra = 0; this.ddrb = 0;
    this.t1Counter = 0; this.t1Latch = 0;
    this.t2Counter = 0;
    this.sr = 0;
    this.acr = 0; this.pcr = 0;
    this.ifr = 0; this.ier = 0;
    this.t1Reload = false;
    this.t1HasUnderflowed = false;
    this.t2HasUnderflowed = false;
    this.lastCa1Pin = true;
    this.lastCb1Pin = true;
    this.portA.onOutputChanged(0, 0, "reset");
    this.portB.onOutputChanged(0, 0, "reset");
  }
}
