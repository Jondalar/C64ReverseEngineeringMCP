// Implementation informed by MOS 6522 datasheet + cross-checked against
// VICE behavior. No code lifted. Project remains MIT.
//
// Sprint 60 scope: register read/write + DDR (data direction registers).
// NO timers, NO IRQ assertion, NO shift register, NO handshake — those
// land in Sprint 61. The skeleton lets drive code do basic
// register-poke patterns without faulting.
//
// 6522 register layout (per VIA, 16 registers, mirrored across the
// 1KB allocation):
//   $0  ORB / IRB    output / input register B
//   $1  ORA / IRA    output / input register A (with handshake)
//   $2  DDRB         data direction register B
//   $3  DDRA         data direction register A
//   $4  T1C-L        timer 1 counter low (read-only at this addr)
//   $5  T1C-H        timer 1 counter high
//   $6  T1L-L        timer 1 latch low
//   $7  T1L-H        timer 1 latch high
//   $8  T2C-L        timer 2 counter low
//   $9  T2C-H        timer 2 counter high
//   $a  SR           shift register
//   $b  ACR          auxiliary control register
//   $c  PCR          peripheral control register
//   $d  IFR          interrupt flag register
//   $e  IER          interrupt enable register
//   $f  ORA / IRA    same as $1 but no handshake

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

export interface ViaPortBackend {
  // External pin state read by the VIA when CPU reads IRB/IRA.
  // Typically returned as the bus state (open-collector wired-AND
  // across all drivers). When DDR bit = 1 (output), the corresponding
  // bit in this read is overridden by the OR latch — that logic lives
  // in the VIA itself; the backend just supplies the raw bus state.
  readPins(): number;
  // Called when the CPU writes ORB/ORA. The backend may drive its
  // pins low (open-collector) according to the OR value AND the DDR
  // mask. Output-disabled bits (DDR=0) leave the line floating high.
  onOutputChanged(orValue: number, ddrMask: number): void;
}

export class Via6522 {
  // Output / input latches. ORA/ORB are CPU-written outputs; pin reads
  // (IRA/IRB) reflect bus state (DDR-input bits) ORed with OR-latch
  // (DDR-output bits).
  public ora = 0;
  public orb = 0;
  public ddra = 0;
  public ddrb = 0;
  // Sprint 60: timers, SR, ACR, PCR, IFR, IER stored as plain bytes
  // with no behavioral effect. Sprint 61 wires them up.
  public t1cl = 0;
  public t1ch = 0;
  public t1ll = 0;
  public t1lh = 0;
  public t2cl = 0;
  public t2ch = 0;
  public sr = 0;
  public acr = 0;
  public pcr = 0;
  public ifr = 0;
  public ier = 0;

  constructor(public readonly portA: ViaPortBackend, public readonly portB: ViaPortBackend) {}

  read(reg: number): number {
    switch (reg & 0xf) {
      case VIA_ORB: {
        // For DDR-output bits: return OR latch. For DDR-input bits:
        // return live pin state. (Real 6522 returns OR-latch for
        // output bits when CB2 latching disabled — Sprint 60 ignores
        // the latching-mode subtlety.)
        const pins = this.portB.readPins();
        return (this.orb & this.ddrb) | (pins & ~this.ddrb & 0xff);
      }
      case VIA_ORA:
      case VIA_ORA_NOHS: {
        const pins = this.portA.readPins();
        return (this.ora & this.ddra) | (pins & ~this.ddra & 0xff);
      }
      case VIA_DDRB: return this.ddrb;
      case VIA_DDRA: return this.ddra;
      case VIA_T1CL: return this.t1cl;
      case VIA_T1CH: return this.t1ch;
      case VIA_T1LL: return this.t1ll;
      case VIA_T1LH: return this.t1lh;
      case VIA_T2CL: return this.t2cl;
      case VIA_T2CH: return this.t2ch;
      case VIA_SR: return this.sr;
      case VIA_ACR: return this.acr;
      case VIA_PCR: return this.pcr;
      case VIA_IFR: return this.ifr;
      case VIA_IER: return this.ier | 0x80;
      default: return 0;
    }
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    switch (reg & 0xf) {
      case VIA_ORB:
        this.orb = v;
        this.portB.onOutputChanged(this.orb, this.ddrb);
        return;
      case VIA_ORA:
      case VIA_ORA_NOHS:
        this.ora = v;
        this.portA.onOutputChanged(this.ora, this.ddra);
        return;
      case VIA_DDRB:
        this.ddrb = v;
        this.portB.onOutputChanged(this.orb, this.ddrb);
        return;
      case VIA_DDRA:
        this.ddra = v;
        this.portA.onOutputChanged(this.ora, this.ddra);
        return;
      case VIA_T1CL: this.t1cl = v; return;
      case VIA_T1CH: this.t1ch = v; return;
      case VIA_T1LL: this.t1ll = v; return;
      case VIA_T1LH: this.t1lh = v; return;
      case VIA_T2CL: this.t2cl = v; return;
      case VIA_T2CH: this.t2ch = v; return;
      case VIA_SR: this.sr = v; return;
      case VIA_ACR: this.acr = v; return;
      case VIA_PCR: this.pcr = v; return;
      case VIA_IFR:
        // Writing 1 to a flag bit clears it. Bit 7 ignored on write.
        this.ifr &= ~(v & 0x7f);
        return;
      case VIA_IER:
        // Bit 7: 1 = enable bits with v=1, 0 = disable bits with v=1.
        if ((v & 0x80) !== 0) this.ier |= (v & 0x7f);
        else this.ier &= ~(v & 0x7f);
        return;
    }
  }

  reset(): void {
    this.ora = 0; this.orb = 0;
    this.ddra = 0; this.ddrb = 0;
    this.t1cl = this.t1ch = this.t1ll = this.t1lh = 0;
    this.t2cl = this.t2ch = 0;
    this.sr = 0;
    this.acr = 0; this.pcr = 0;
    this.ifr = 0; this.ier = 0;
    this.portA.onOutputChanged(0, 0);
    this.portB.onOutputChanged(0, 0);
  }
}
