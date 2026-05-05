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
import type { BusAccessTraceProducer } from "../trace/bus-access.js";
import { IecBusCore } from "./iec-bus-core.js";

export type IecMode = "vice-cache" | "live";

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

export interface IecEdgeRecord {
  cycle: number;
  side: "c64" | "drive";
  atn: 0 | 1;
  clk: 0 | 1;
  data: 0 | 1;
  c64Atn: 0 | 1;
  c64Clk: 0 | 1;
  c64Data: 0 | 1;
  drvClk: 0 | 1;
  drvData: 0 | 1;
  drvAtnAck: 0 | 1;
}

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

  // Spec 093: optional cycle-stamped edge trace.
  private traceEnabled = false;
  private traceCapacity = 256;
  private trace: IecEdgeRecord[] = [];
  public timeSource?: () => number;

  // Spec 142: optional bus-access trace producer. null = no overhead.
  public busAccessProducer?: BusAccessTraceProducer;
  // CIA2 PA address — passed in by integrated session for trace event addr field.
  // Defaults to $DD00 (standard C64 wiring).
  public cia2PaAddr = 0xdd00;

  // Spec 140: VICE-compatible cached IEC core. When iecMode = "vice-cache",
  // setC64Output and setDriveOutput update this core; drive PB reads
  // route through `core.driveReadPbByte()` instead of buildDrivePbInputBits.
  public readonly core = new IecBusCore();
  public iecMode: IecMode = "live";

  // Spec 140 v2 diagnostic: compare live vs vice-cache reads on every
  // drive $1800 access. Emits via callback when they differ. Used to
  // pinpoint bit-polarity divergence without breaking drive boot.
  public diagnoseReadDivergence?: (info: {
    driveCycle: number;
    drivePc: number;
    prb: number;
    ddrb: number;
    deviceId: number;
    liveByte: number;
    viceByte: number;
    drv_port: number;
    cpu_bus: number;
  }) => void;

  enableTrace(capacity = 256): void {
    this.traceEnabled = true;
    this.traceCapacity = Math.max(8, capacity);
    this.trace = [];
  }
  disableTrace(): void { this.traceEnabled = false; this.trace = []; }
  getTrace(): IecEdgeRecord[] { return this.trace.slice(); }
  clearTrace(): void { this.trace = []; }
  isTraceEnabled(): boolean { return this.traceEnabled; }
  private recordEdge(side: "c64" | "drive", prev: { atn: boolean; clk: boolean; data: boolean }): void {
    if (!this.traceEnabled) return;
    const atn = this.atnLine, clk = this.clkLine, data = this.dataLine;
    if (atn === prev.atn && clk === prev.clk && data === prev.data) return;
    const cycle = this.timeSource ? this.timeSource() : 0;
    const rec: IecEdgeRecord = {
      cycle, side,
      atn: atn ? 1 : 0, clk: clk ? 1 : 0, data: data ? 1 : 0,
      c64Atn: this.c64AtnReleased ? 1 : 0,
      c64Clk: this.c64ClkReleased ? 1 : 0,
      c64Data: this.c64DataReleased ? 1 : 0,
      drvClk: this.driveClkReleased ? 1 : 0,
      drvData: this.driveDataReleased ? 1 : 0,
      drvAtnAck: this.driveAtnAckReleased ? 1 : 0,
    };
    this.trace.push(rec);
    if (this.trace.length > this.traceCapacity) this.trace.shift();
  }

  // Optional drive VIA1 to pulse CA1 on ATN edges.
  private driveVia1?: Via6522;
  // Sprint 66 hack: optional pointer to drive RAM so we can poke the
  // ATN-pending flag at $7C directly. Standard 1541 ROM idle loop at
  // $EBFF reads $7C and only jumps to ATN handler if non-zero. The
  // IRQ handler normally sets $7C from CA1 IRQ, but our model misses
  // some edges due to the boot-order race. Direct poke unsticks the
  // common case.
  // Spec 096 (Bug 40): poke is now edge-triggered only — set on
  // ATN high→low transition, not while continuously low. The
  // level-trigger version caused the drive to re-enter the ATN
  // handler / command parser on every C64 IEC write while ATN was
  // held low (e.g. during ACPTR retry), abandoning TALK byte-send.
  private driveRamForAtnPoke?: Uint8Array;
  private prevAtnLow = false;

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

  // C64 → bus: CIA2 PA writes update these.
  // CIA2 has 7406 INVERTERS between PA latch and IEC transistor bases:
  // PA latch bit=1 (DDR=output) → transistor pulls line LOW (asserted).
  // KERNAL writes ORA #$38 to $DD00 to assert ATN+CLK+DATA. KERNAL's
  // $EE8E (`ORA #$10` then store) is "pull CLK low" — confirms bit=1=pull.
  setC64Output(cia2Pa: number, ddrMask: number): void {
    // VICE-style: flush drive cycles BEFORE bus state changes so the
    // drive sees its previous bus state for full duration before this
    // new one. Symmetric with read-side flush.
    if (this.beforeC64Read) this.beforeC64Read();
    const prev = { atn: this.atnLine, clk: this.clkLine, data: this.dataLine };
    const driveAtn = (ddrMask & CIA2_PA_ATN_OUT) !== 0;
    const driveClk = (ddrMask & CIA2_PA_CLK_OUT) !== 0;
    const driveData = (ddrMask & CIA2_PA_DATA_OUT) !== 0;
    const atnBit = (cia2Pa & CIA2_PA_ATN_OUT) !== 0;
    const clkBit = (cia2Pa & CIA2_PA_CLK_OUT) !== 0;
    const dataBit = (cia2Pa & CIA2_PA_DATA_OUT) !== 0;
    // Inverted: bit=1 AND DDR=output → line pulled; bit=0 OR DDR=input → released.
    this.c64AtnReleased = !driveAtn || !atnBit;
    this.c64ClkReleased = !driveClk || !clkBit;
    this.c64DataReleased = !driveData || !dataBit;
    // Spec 140: maintain VICE-cache state in parallel with live flags.
    // CRITICAL (Spec 140 v2 fix): VICE c64cia2.c:150 inverts the PA
    // latch byte (`tmp = ~byte`) BEFORE passing to iec_update_cpu_bus.
    // Convention: cpu_bus bit set = c64 NOT asserting (line HIGH).
    // Without this inversion our cpu_bus had inverted polarity vs
    // VICE → drv_port wrong → drive PB read wrong.
    this.core.iecUpdateCpuBus((~cia2Pa) & 0xff, ddrMask);
    this.core.iecUpdatePorts();
    this.notifyAtnChanged();
    this.recordEdge("c64", prev);
    // Spec 142: emit bus-access event AFTER bus state mutated, so the
    // event's iec snapshot reflects the new state.
    this.busAccessProducer?.emitC64Access({ op: "write", addr: this.cia2PaAddr, value: cia2Pa & 0xff });
  }

  // Drive → bus: VIA1 PB writes update these.
  // 1541 hardware INVERTS PB output bits before driving the open-
  // collector IEC transistors, so the polarity is REVERSED vs CIA2:
  // PB bit=1 (with DDR=output) → transistor pulls line LOW.
  // PB bit=0 (with DDR=output) → transistor releases line.
  // Confirmed during Sprint 75 iteration on Maniac Mansion drive code.
  setDriveOutput(via1PbOr: number, ddrMask: number): void {
    const prev = { atn: this.atnLine, clk: this.clkLine, data: this.dataLine };
    const drvData = (ddrMask & PB_DATA_OUT) !== 0;
    const drvClk = (ddrMask & PB_CLK_OUT) !== 0;
    const drvAtnAck = (ddrMask & PB_ATN_ACK) !== 0;
    const dataBit = (via1PbOr & PB_DATA_OUT) !== 0;
    const clkBit = (via1PbOr & PB_CLK_OUT) !== 0;
    const atnAckBit = (via1PbOr & PB_ATN_ACK) !== 0;
    // PB1 (DATA_OUT), PB3 (CLK_OUT): inverted via 7406 → bit=1 = pulled.
    this.driveDataReleased = !drvData || !dataBit;
    this.driveClkReleased = !drvClk || !clkBit;
    // PB4 (ATN_ACK): NOT a line driver. Feeds AND-gate UE5 with ATN
    // line. bit=1 = drive acknowledged ATN = auto-pull DISABLED (i.e.
    // released). 1541 ATN handler $E876 does ORA #$10 to acknowledge.
    this.driveAtnAckReleased = !drvAtnAck || atnAckBit;
    // Spec 140: maintain VICE-cache state in parallel.
    // VICE store_prb passes the RAW OR latch (not DDR-gated) — VICE
    // drives drv_data = ~byte unconditionally. Per via1d1541.c:228.
    this.core.driveStorePb(via1PbOr & 0xff, 8);
    this.recordEdge("drive", prev);
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

  // Spec 083 / VICE-style: caller can hook to ensure drive CPU has
  // caught up to the current cycle before C64 reads bus state. Without
  // this, drive lag causes serial bit timing to fail (drive can't
  // respond fast enough to CLK/DATA changes).
  public beforeC64Read?: () => void;

  // Read-side helper for CIA2 stub: build the input bits CIA2 sees on PA.
  buildC64InputBits(): number {
    if (this.beforeC64Read) this.beforeC64Read();
    let bits = 0;
    bits |= CIA2_PA_VIC_BANK_LO | CIA2_PA_VIC_BANK_HI; // input bits float high (we ignore VIC bank)
    if (this.clkLine) bits |= CIA2_PA_CLK_IN;
    if (this.dataLine) bits |= CIA2_PA_DATA_IN;
    const result = bits & 0xff;
    this.busAccessProducer?.emitC64Access({ op: "read", addr: this.cia2PaAddr, value: result });
    return result;
  }

  // Read-side helper for VIA1 PB backend (legacy "live" mode).
  // Spec 140 v2: kept for trace/test back-compat. Real drive PB read
  // now goes through `core.driveReadPbByte()` via via1-iec.ts
  // readPbFull, which applies VICE's `((PRB & 0x1A) | drv_port) ^
  // 0x85 | (devId<<5)` formula.
  //
  // NOTE polarity here is "1 = line LOW/asserted" (legacy
  // convention). Real 1541 PB inputs are non-inverting so bit = 1
  // means line HIGH — but our existing trap-fast / KERNAL serial
  // paths and unit tests have been calibrated against this inverted
  // convention. Keeping it for back-compat. Production drive read
  // now bypasses this helper.
  buildDrivePbInputBits(deviceId: number): number {
    let bits = 0;
    if (!this.atnLine) bits |= PB_ATN_IN;     // line LOW → bit = 1 (LEGACY)
    if (!this.clkLine) bits |= PB_CLK_IN;
    if (!this.dataLine) bits |= PB_DATA_IN;
    // Sprint 96 / Bug 39: device ID jumpers (read as PB5/PB6).
    // Real 1541 schematic: J1, J2 are PCB traces; CUTTING a trace
    // adds 1 (J1) or 2 (J2) to base device address 8. UNCUT jumper
    // grounds the PB pin → reads 0 (active-low to ground). Default
    // device 8 = both uncut = both bits 0.
    const offset = deviceId - 8;            // 0..3
    const cutHi = (offset & 0x02) !== 0;
    const cutLo = (offset & 0x01) !== 0;
    if (cutLo) bits |= PB_DEV_ID0; else bits &= ~PB_DEV_ID0;
    if (cutHi) bits |= PB_DEV_ID1; else bits &= ~PB_DEV_ID1;
    return bits & 0xff;
  }

  attachDriveRam(ram: Uint8Array): void {
    this.driveRamForAtnPoke = ram;
  }

  // Sprint 72: synthesize drive CLK ACK after a trap-handled M-W or
  // similar drive-command completion. Many games wait for CLK to be
  // released by the drive after a command — we release it here so
  // the C64 exits the wait loop immediately.
  releaseDriveClk(): void {
    this.driveClkReleased = true;
  }

  releaseDriveData(): void {
    this.driveDataReleased = true;
  }

  private notifyAtnChanged(): void {
    if (this.driveVia1) {
      this.driveVia1.pulseCa1(this.atnLine);
    }
    // Sprint 66 hack, Spec 096 fix: edge-triggered poke of drive
    // ATN-pending flag at $7C. Standard 1541 ROM idle loop reads $7C
    // and jumps to ATN-handler when non-zero; the IRQ handler
    // normally sets it from CA1 IRQ. Setting only on ATN high→low
    // transition matches the real edge-pulse semantics. The earlier
    // level-trigger version repeatedly re-poked $7C on every C64
    // IEC write while ATN was held low, which caused drive to
    // re-enter the command parser during ACPTR retries and
    // abandon TALK byte-send (Bug 40).
    const atnLow = !this.atnLine;
    if (atnLow && !this.prevAtnLow && this.driveRamForAtnPoke) {
      this.driveRamForAtnPoke[0x7c] = 0x80;
    }
    this.prevAtnLow = atnLow;
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
    this.prevAtnLow = false;
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
