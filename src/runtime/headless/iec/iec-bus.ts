// Spec 140 v3 — IEC bus 1:1 VICE port.
//
// Mirrors VICE 3.7.1 behavior with single source of truth =
// IecBusCore (= the iecbus_t struct). All state derived from core.
// No parallel "live released" flags. No iecMode flag.
//
// External API (atnLine/clkLine/dataLine getters, setC64Output,
// setDriveOutput, buildC64InputBits) preserved for back-compat;
// implementations now compute from core.cpu_port + core.cpu_bus.

import type { Via6522 } from "../drive/via6522.js";
import { PB_DEV_ID0, PB_DEV_ID1 } from "../drive/via1-iec.js";
import type { BusAccessTraceProducer } from "../trace/bus-access.js";
import { IecBusCore } from "./iec-bus-core.js";

// CIA2 PA bit assignments.
export const CIA2_PA_VIC_BANK_LO = 1 << 0;
export const CIA2_PA_VIC_BANK_HI = 1 << 1;
export const CIA2_PA_RS232 = 1 << 2;
export const CIA2_PA_ATN_OUT = 1 << 3;
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
  // Per-side fields populated from the post-mutation core snapshot.
  c64Atn: 0 | 1;
  c64Clk: 0 | 1;
  c64Data: 0 | 1;
  drvClk: 0 | 1;
  drvData: 0 | 1;
  drvAtnAck: 0 | 1;
}

export class IecBus {
  // 1:1 VICE iecbus_t — single source of truth.
  public readonly core = new IecBusCore();

  // Spec 093 trace.
  private traceEnabled = false;
  private traceCapacity = 256;
  private trace: IecEdgeRecord[] = [];
  public timeSource?: () => number;

  // Spec 142 bus-access producer.
  public busAccessProducer?: BusAccessTraceProducer;
  public cia2PaAddr = 0xdd00;

  // Spec 142 v2 diagnostic.
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

  // Spec 141 v2: drive clock source for ATN-edge IRQ stamping.
  public driveClockSource?: () => number;

  // Drive VIA1 reference for ATN edge propagation.
  private driveVia1?: Via6522;

  // Sprint 66 / Spec 144 territory: drive RAM $7C poke for legacy
  // trap-fast mode. Default null = disabled (truedrive-pure).
  // Kept here for future Spec 144 mode-gating.
  private driveRamForAtnPoke?: Uint8Array;
  private prevAtnLow = false;

  // === Trace API ===

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
    // Per-side derive from core.cpu_bus + drv_data[8].
    const cpu_bus = this.core.cpu_bus;
    const drv_data8 = this.core.drv_data[8] ?? 0xff;
    const rec: IecEdgeRecord = {
      cycle, side,
      atn: atn ? 1 : 0, clk: clk ? 1 : 0, data: data ? 1 : 0,
      // c64*: cpu_bus bit set = c64 NOT asserting (released).
      c64Atn: ((cpu_bus & 0x10) ? 1 : 0) as 0 | 1,
      c64Clk: ((cpu_bus & 0x40) ? 1 : 0) as 0 | 1,
      c64Data: ((cpu_bus & 0x80) ? 1 : 0) as 0 | 1,
      // drv*: drv_data bit = !ORB bit. drv_data bit set = drive
      // NOT asserting (released). PB1 = DATA_OUT, PB3 = CLK_OUT,
      // PB4 = ATN_ACK.
      drvClk: ((drv_data8 & 0x08) ? 1 : 0) as 0 | 1,
      drvData: ((drv_data8 & 0x02) ? 1 : 0) as 0 | 1,
      drvAtnAck: ((drv_data8 & 0x10) ? 1 : 0) as 0 | 1,
    };
    this.trace.push(rec);
    if (this.trace.length > this.traceCapacity) this.trace.shift();
  }

  // === Drive VIA1 attachment ===

  attachDriveVia1(via: Via6522): void {
    this.driveVia1 = via;
    // Initialize CA1 baseline state per current ATN.
    via.pulseCa1(this.atnLine);
    // Sprint 66 boot-order race re-eval shim. Spec 144 will gate this.
    via.onCa1IerEnabled = () => {
      via.reevaluateCa1Level(this.atnLine);
    };
  }

  // === C64 IEC store ($DD00 PA write) ===
  // VICE flow: c64cia2.c:150 inverts byte → iecbus_callback_write →
  // iecbus_cpu_write_conf1 (iecbus.c:237):
  //   1. drive_cpu_execute_one(unit, clock)  — flush drive
  //   2. iec_update_cpu_bus(data)
  //   3. ATN edge → viacore_signal(via1d1541, CA1, ...)
  //   4. recompute drv_bus[8]
  //   5. iec_update_ports
  setC64Output(cia2Pa: number, _ddrMask: number): void {
    // Per c64cia2.c:150 — invert raw PA byte before iecbus.
    const inverted = (~cia2Pa) & 0xff;
    const prev = { atn: this.atnLine, clk: this.clkLine, data: this.dataLine };
    // Drive flush (Q4 hybrid: still tick lockstep, push-flush at IEC).
    if (this.beforeC64Read) this.beforeC64Read();
    // Single core mutation — handles update_cpu_bus, ATN edge,
    // drv_bus[8/9] recompute, iec_update_ports.
    this.core.c64_store_dd00(inverted, (atnHigh) => {
      const stamp = this.driveClockSource?.();
      this.driveVia1?.pulseCa1(atnHigh, stamp);
      // Sprint 66 / Spec 144 territory: $7C ATN-pending poke.
      // KEY FINDING (Spec 140 v3+): RAM diff at $07A1 between
      // VICE and headless drive shows $7C=$80 (us) vs $00 (VICE).
      // Removing the poke breaks MM-LOAD (drive misses ATN edge);
      // keeping it breaks motm (drive permanently in ATN handler
      // instead of motm receive loop). True fix is Spec 145+
      // (CIA + VIA timer 1:1 so CA1 IRQ delivers naturally without
      // race). Until then keep poke + accept motm broken.
      const atnLow = !atnHigh;
      if (atnLow && !this.prevAtnLow && this.driveRamForAtnPoke) {
        this.driveRamForAtnPoke[0x7c] = 0x80;
      }
      this.prevAtnLow = atnLow;
    });
    this.recordEdge("c64", prev);
    this.busAccessProducer?.emitC64Access({ op: "write", addr: this.cia2PaAddr, value: cia2Pa & 0xff });
  }

  // === Drive PB store ($1800 ORB write) ===
  // VICE flow: via1d1541.c store_prb (called from viacore on ORB write):
  //   1. drive_data[unit] = ~byte
  //   2. drv_bus[unit] = ATN-AND-gate composition
  //   3. iec_update_ports
  setDriveOutput(via1PbOr: number, _ddrMask: number): void {
    const prev = { atn: this.atnLine, clk: this.clkLine, data: this.dataLine };
    this.core.drive_store_pb(via1PbOr & 0xff, 8);
    this.recordEdge("drive", prev);
  }

  // === Line state getters (derive from core) ===
  // atnLine: only C64 drives ATN. cpu_bus bit 4 = 1 → released.
  get atnLine(): boolean {
    return (this.core.cpu_bus & 0x10) !== 0;
  }
  // clkLine: cpu_port bit 6 = AND of c64 + drive CLK. 1 = released.
  get clkLine(): boolean {
    return (this.core.cpu_port & 0x40) !== 0;
  }
  // dataLine: cpu_port bit 7 = AND of c64 + drive DATA, post-ATN-AND-gate.
  get dataLine(): boolean {
    return (this.core.cpu_port & 0x80) !== 0;
  }

  public beforeC64Read?: () => void;

  // === C64 reads $DD00 PA ($DC00 callback) ===
  // VICE: iecbus_cpu_read_conf1 returns CACHED iecbus.cpu_port.
  buildC64InputBits(): number {
    if (this.beforeC64Read) this.beforeC64Read();
    // VICE bit layout in cpu_port:
    //   bit 4 = ATN  (only c64 drives, but cpu_port has it from cpu_bus)
    //   bit 6 = CLK
    //   bit 7 = DATA
    // C64 reads $DD00:
    //   bit 6 = CLK_IN, bit 7 = DATA_IN
    // VICE returns cpu_port directly — caller (CIA2) merges with PA latch.
    // Our CIA2 stub uses readPins() → returns the bus-derived bits.
    // Match VICE: return cpu_port bits 6+7 (the input bits) plus
    // VIC bank bits float high.
    let bits = 0;
    bits |= CIA2_PA_VIC_BANK_LO | CIA2_PA_VIC_BANK_HI;
    if (this.clkLine) bits |= CIA2_PA_CLK_IN;
    if (this.dataLine) bits |= CIA2_PA_DATA_IN;
    const result = bits & 0xff;
    this.busAccessProducer?.emitC64Access({ op: "read", addr: this.cia2PaAddr, value: result });
    return result;
  }

  // === Drive reads $1800 PB === (legacy fallback for trace etc.)
  // Production path goes through via1-iec.ts readPbFull → core.drive_read_pb.
  // This helper kept for back-compat callers (trace iec snapshot,
  // unit tests).
  buildDrivePbInputBits(deviceId: number): number {
    // Per VICE read_prb formula but without PRB latch portion (caller
    // merges). Returns just the input bits (DATA/CLK/ATN) plus jumper.
    let bits = 0;
    if (!this.atnLine) bits |= 1 << 7;     // PB7 ATN_IN: 1 = line LOW (per real-HW non-inverting input convention follow-on)
    if (!this.clkLine) bits |= 1 << 2;     // PB2 CLK_IN
    if (!this.dataLine) bits |= 1 << 0;    // PB0 DATA_IN
    const offset = deviceId - 8;
    const cutHi = (offset & 0x02) !== 0;
    const cutLo = (offset & 0x01) !== 0;
    if (cutLo) bits |= PB_DEV_ID0;
    if (cutHi) bits |= PB_DEV_ID1;
    return bits & 0xff;
  }

  // === Sprint 66 / Spec 144 hooks ===
  attachDriveRam(ram: Uint8Array): void {
    this.driveRamForAtnPoke = ram;
  }

  // Sprint 72: synthetic line release for trap-fast mode (Spec 144
  // gating later). Direct mutation of drv_data; bypasses normal
  // store_prb flow.
  releaseDriveClk(): void {
    // Set drive_data[8] bit 3 (CLK_OUT inverted) = 1 (= drive
    // released). Recompute drv_bus[8] + ports.
    const dd = this.core.drv_data[8] ?? 0xff;
    this.core.drv_data[8] = (dd | 0x08) & 0xff;
    this.core.recompute_drv_bus(8);
    this.core.iec_update_ports();
  }
  releaseDriveData(): void {
    const dd = this.core.drv_data[8] ?? 0xff;
    this.core.drv_data[8] = (dd | 0x02) & 0xff;
    this.core.recompute_drv_bus(8);
    this.core.iec_update_ports();
  }

  reset(): void {
    this.core.reset();
    this.prevAtnLow = false;
  }

  snapshot(): {
    line: { atn: boolean; clk: boolean; data: boolean };
    c64: { atnReleased: boolean; clkReleased: boolean; dataReleased: boolean };
    drive: { clkReleased: boolean; dataReleased: boolean; atnAckReleased: boolean };
  } {
    const cpu_bus = this.core.cpu_bus;
    const drv_data8 = this.core.drv_data[8] ?? 0xff;
    return {
      line: { atn: this.atnLine, clk: this.clkLine, data: this.dataLine },
      // c64*: cpu_bus bit set = "c64 not asserting" = released.
      c64: {
        atnReleased: (cpu_bus & 0x10) !== 0,
        clkReleased: (cpu_bus & 0x40) !== 0,
        dataReleased: (cpu_bus & 0x80) !== 0,
      },
      // drive*: drv_data bit set = "drive not asserting" = released.
      drive: {
        clkReleased: (drv_data8 & 0x08) !== 0,
        dataReleased: (drv_data8 & 0x02) !== 0,
        atnAckReleased: (drv_data8 & 0x10) !== 0,
      },
    };
  }
}
