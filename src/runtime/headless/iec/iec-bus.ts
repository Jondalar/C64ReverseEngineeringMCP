// IEC bus state model for headless C64 + 1541 drive coupling.
//
// Bus is open-collector wired-AND: each driver pulls its line LOW or
// releases (HIGH default via pull-up resistors). Effective line state
// = AND across all drivers (LOW wins).
//
// Standard IEC has 3 active lines:
//   ATN  (attention) — driven only by C64 (via CIA2 PA bit 3 inverted)
//   CLK  (clock)     — driven by C64 (CIA2 PA bit 4) AND drive (VIA1 PB bit 3)
//   DATA (data)      — driven by C64 (CIA2 PA bit 5) AND drive (VIA1 PB bit 1)
//                      AND drive's ATN_ACK (VIA1 PB bit 4) when ATN is low
//
// C64 reads CLK_IN ($DD00 bit 6) and DATA_IN ($DD00 bit 7).
// Drive reads ATN_IN ($1800 bit 7), CLK_IN ($1800 bit 2), DATA_IN
// ($1800 bit 0).
//
// Sign convention: bus uses negative-true logic (LOW = asserted = TRUE
// in the IEC sense). To stay sane in code we model line state as
// "released" (HIGH = true) by default; "pulled" = false.

import type { Via6522 } from "../drive/via6522.js";
import {
  PB_DATA_OUT, PB_CLK_OUT, PB_ATN_ACK,
  PB_DATA_IN, PB_CLK_IN, PB_ATN_IN,
  PB_DEV_ID0, PB_DEV_ID1,
} from "../drive/via1-iec.js";

// CIA2 PA bit assignments (CIA2 not yet implemented — these constants
// are for the cia2-stub.ts that wires the bus on $DD00 writes).
export const CIA2_PA_VIC_BANK_LO = 1 << 0;
export const CIA2_PA_VIC_BANK_HI = 1 << 1;
export const CIA2_PA_RS232 = 1 << 2;       // RS232 TXD; ignored
export const CIA2_PA_ATN_OUT = 1 << 3;     // active low when bit = 0 → ATN pulled
export const CIA2_PA_CLK_OUT = 1 << 4;
export const CIA2_PA_DATA_OUT = 1 << 5;
export const CIA2_PA_CLK_IN = 1 << 6;
export const CIA2_PA_DATA_IN = 1 << 7;

export class IecBus {
  // C64-side drivers. true = released (high), false = pulling low.
  private c64AtnReleased = true;
  private c64ClkReleased = true;
  private c64DataReleased = true;

  // Drive-side drivers.
  private driveClkReleased = true;
  private driveDataReleased = true;
  // ATN_ACK on drive side: when ATN is asserted (low), the drive must
  // ACK by pulling DATA low. The drive ROM does this in its ATN handler.
  private driveAtnAckReleased = true;

  // Optional drive VIA1 to pulse CA1 on ATN edges.
  private driveVia1?: Via6522;
  // Sprint 66 hack: optional pointer to drive RAM so we can poke the
  // ATN-pending flag at $7C directly. Standard 1541 ROM idle loop at
  // $EBFF reads $7C and only jumps to ATN handler if non-zero. The
  // IRQ handler normally sets $7C from CA1 IRQ, but our model misses
  // some edges due to the boot-order race. Direct poke unsticks the
  // common case.
  private driveRamForAtnPoke?: Uint8Array;

  attachDriveVia1(via: Via6522): void {
    this.driveVia1 = via;
    // Initialize CA1 baseline state.
    via.pulseCa1(this.atnLine);
    // Sprint 66: when drive ROM enables CA1 IRQ later, re-evaluate
    // against current ATN level (workaround for boot-order race —
    // see Via6522.reevaluateCa1Level doc).
    via.onCa1IerEnabled = () => {
      via.reevaluateCa1Level(this.atnLine);
    };
  }

  // C64 → bus: CIA2 PA writes update these. Standard CIA2 mapping
  // is "0 in PA bit = pull line low" (active low; bit inverted).
  setC64Output(cia2Pa: number, ddrMask: number): void {
    // Only output bits (ddrMask=1) drive the line; input bits
    // (ddrMask=0) leave the line floating (= released).
    const driveAtn = (ddrMask & CIA2_PA_ATN_OUT) !== 0;
    const driveClk = (ddrMask & CIA2_PA_CLK_OUT) !== 0;
    const driveData = (ddrMask & CIA2_PA_DATA_OUT) !== 0;
    const atnBit = (cia2Pa & CIA2_PA_ATN_OUT) !== 0;
    const clkBit = (cia2Pa & CIA2_PA_CLK_OUT) !== 0;
    const dataBit = (cia2Pa & CIA2_PA_DATA_OUT) !== 0;
    // Active-low: bit=0 AND DDR=output → line pulled. bit=1 OR DDR=input → released.
    const newAtn = !driveAtn || atnBit;
    this.c64AtnReleased = !driveAtn || atnBit;
    this.c64ClkReleased = !driveClk || clkBit;
    this.c64DataReleased = !driveData || dataBit;
    if (this.driveVia1 && newAtn !== this.atnLineRaw(undefined)) {
      // ATN line changed — pulse drive VIA1 CA1 with new ATN level.
    }
    this.notifyAtnChanged();
  }

  // Drive → bus: VIA1 PB writes update these. VIA1 PB bit polarity
  // matches the bus (1 = released, 0 = pulled when DDR=output).
  // ATN_ACK is special: drive code sets PB4 to actively pull DATA low
  // when ATN is asserted, even if DATA_OUT bit isn't pulling.
  setDriveOutput(via1PbOr: number, ddrMask: number): void {
    const drvData = (ddrMask & PB_DATA_OUT) !== 0;
    const drvClk = (ddrMask & PB_CLK_OUT) !== 0;
    const drvAtnAck = (ddrMask & PB_ATN_ACK) !== 0;
    const dataBit = (via1PbOr & PB_DATA_OUT) !== 0;
    const clkBit = (via1PbOr & PB_CLK_OUT) !== 0;
    const atnAckBit = (via1PbOr & PB_ATN_ACK) !== 0;
    // bit=0 AND DDR=output → line pulled. bit=1 OR DDR=input → released.
    this.driveDataReleased = !drvData || dataBit;
    this.driveClkReleased = !drvClk || clkBit;
    this.driveAtnAckReleased = !drvAtnAck || atnAckBit;
    // No ATN edge on drive output side — drive doesn't drive ATN.
  }

  // Wired-AND line states. true = released (high), false = pulled (low).
  get atnLine(): boolean {
    return this.c64AtnReleased; // only C64 drives ATN
  }
  get clkLine(): boolean {
    return this.c64ClkReleased && this.driveClkReleased;
  }
  get dataLine(): boolean {
    // The 1541 has a hardware AND gate: when ATN is asserted (low) AND
    // the drive has NOT released ATN_ACK (PB4 still low), the gate
    // pulls DATA low. The drive's ATN service routine releases ATN_ACK
    // (sets PB4 high) once it has noticed the ATN edge, removing the
    // auto-pull and letting normal DATA bit-bang resume.
    const atnAckAutoPullActive = !this.atnLine && !this.driveAtnAckReleased;
    if (atnAckAutoPullActive) return false;
    return this.c64DataReleased && this.driveDataReleased;
  }

  // Read-side helper for CIA2 stub: build the input bits CIA2 sees on PA.
  buildC64InputBits(): number {
    let bits = 0;
    bits |= CIA2_PA_VIC_BANK_LO | CIA2_PA_VIC_BANK_HI; // input bits float high (we ignore VIC bank)
    if (this.clkLine) bits |= CIA2_PA_CLK_IN;
    if (this.dataLine) bits |= CIA2_PA_DATA_IN;
    return bits & 0xff;
  }

  // Read-side helper for VIA1 PB backend.
  buildDrivePbInputBits(deviceId: number): number {
    // Always-high default for input bits (PB5/PB6 jumpers, others
    // floating high then masked by drive activity).
    let bits = 0xff;
    if (!this.atnLine) bits &= ~PB_ATN_IN;
    if (!this.clkLine) bits &= ~PB_CLK_IN;
    if (!this.dataLine) bits &= ~PB_DATA_IN;
    // Device ID jumpers (read as input bits PB5/PB6).
    let jumperHi: boolean, jumperLo: boolean;
    switch (deviceId) {
      case 8:  jumperLo = true;  jumperHi = true;  break;
      case 9:  jumperLo = false; jumperHi = true;  break;
      case 10: jumperLo = true;  jumperHi = false; break;
      case 11: jumperLo = false; jumperHi = false; break;
      default: throw new Error(`Unsupported device id ${deviceId}`);
    }
    if (jumperLo) bits |= PB_DEV_ID0; else bits &= ~PB_DEV_ID0;
    if (jumperHi) bits |= PB_DEV_ID1; else bits &= ~PB_DEV_ID1;
    return bits & 0xff;
  }

  attachDriveRam(ram: Uint8Array): void {
    this.driveRamForAtnPoke = ram;
  }

  private notifyAtnChanged(): void {
    if (this.driveVia1) {
      this.driveVia1.pulseCa1(this.atnLine);
    }
    // Sprint 66 hack: while ATN is low, force-set the standard 1541
    // ATN-pending flag at $7C on every C64-side IEC write so the
    // idle loop at $EBFF picks it up. Standard 1541 ROM idle loop
    // reads $7C; the IRQ handler normally sets it from CA1 IRQ +
    // PB7 read. We synthesize that here unconditionally to avoid
    // having to model the drive-ROM PB7 polling fallback exactly.
    if (!this.atnLine && this.driveRamForAtnPoke) {
      this.driveRamForAtnPoke[0x7c] = 0x80;
    }
  }

  // Internal helper used by setC64Output to detect change before update.
  private atnLineRaw(_pendingC64Released?: boolean): boolean {
    return this.c64AtnReleased;
  }

  reset(): void {
    this.c64AtnReleased = true;
    this.c64ClkReleased = true;
    this.c64DataReleased = true;
    this.driveClkReleased = true;
    this.driveDataReleased = true;
    this.driveAtnAckReleased = true;
  }

  // Diagnostic snapshot for tools / tests.
  snapshot(): {
    line: { atn: boolean; clk: boolean; data: boolean };
    c64: { atnReleased: boolean; clkReleased: boolean; dataReleased: boolean };
    drive: { clkReleased: boolean; dataReleased: boolean; atnAckReleased: boolean };
  } {
    return {
      line: { atn: this.atnLine, clk: this.clkLine, data: this.dataLine },
      c64: { atnReleased: this.c64AtnReleased, clkReleased: this.c64ClkReleased, dataReleased: this.c64DataReleased },
      drive: { clkReleased: this.driveClkReleased, dataReleased: this.driveDataReleased, atnAckReleased: this.driveAtnAckReleased },
    };
  }
}
