// Spec 147 — VIA1 (1541 IEC) instance, Phase 1.
//
// Source: VICE 3.7.1 src/drive/iec/via1d1541.c (~420 LOC).
//
// VIA1 ($1800-$1BFF on the 1541 drive bus) handles the IEC serial
// bus interface and ATN signaling. Port wiring (via1d1541.c lines
// 324-336):
//   PB Bit 7   ATN IN    (input)
//   PB Bit 6-5 device address preset (input)
//   PB Bit 4   ATN ack OUT (output, drives bus)
//   PB Bit 3   CLOCK OUT  (output)
//   PB Bit 2   CLOCK IN   (input)
//   PB Bit 1   DATA OUT   (output)
//   PB Bit 0   DATA IN    (input)
//
//   IN mask:  1110 0101  (0xe5)
//   OUT mask: 0001 1010  (0x1a)
//
// CA1 ← ATN IN edge from C64 (used by drive ROM for ATN handler).
// CA2/CB2 unused (set_ca2/set_cb2 are no-ops in VICE via1d1541.c).
//
// Backend wraps `IecBusCore`:
//  - storePb: drive_store_pb(byte) → IecBusCore (recompute drv_bus,
//    drv_port, propagate to c64 cpu_port).
//  - readPb: drive_read_pb(prb, deviceId) → 1:1 VICE formula.
//  - readPa: returns parallel-cable byte (1541 stock = open-bus 0xff).
//  - storePa: parallel-cable write (no-op for stock 1541 in V1).
//  - storeSr / storeT2L / storeAcr / storePcr / setCa2 / setCb2: no-ops
//    matching VICE via1d1541.c. (set_int routes IRQ to drive CPU.)

import type { AlarmContext } from "../alarm/alarm-context.js";
import type { IecBusCore } from "../iec/iec-bus-core.js";
import { u8, type BYTE, type CLOCK } from "../util/uint.js";
import {
  Via6522Vice,
  VIA_PRA,
  type ViaBackend,
  type Via6522ViceOptions,
} from "./via6522-vice.js";

export interface Via1d1541Options {
  alarmContext: AlarmContext;
  iec: IecBusCore;
  /** 8..11 — drive number; encoded into PB bits 5-6 on read. */
  deviceId: number;
  /** Live drive CPU clock pointer. */
  clkRef: () => CLOCK;
  /** IRQ propagation: called with (value, clk) when (ifr & ier & 0x7f) changes. */
  setIrq: (value: number, clk: CLOCK) => void;
  /** Optional my-name override. Default `1541Drive${deviceId-8}Via1`. */
  myname?: string;
  /** Optional rmw flag plumbing (defaults: never RMW). */
  rmwFlagRef?: Via6522ViceOptions["rmwFlagRef"];
  rmwFlagSet?: Via6522ViceOptions["rmwFlagSet"];
  clkBump?: Via6522ViceOptions["clkBump"];
  writeOffset?: number;
}

/**
 * VIA1 instance for 1541 drive — IEC bus + ATN handler.
 *
 * Construct with an IecBusCore; cross-CPU ATN signaling is left to
 * higher-level wiring (the C64-side $DD00 store path calls
 * `IecBusCore.c64_store_dd00(..., onAtnEdge)` and the host should
 * forward the ATN edge to this instance via `signalAtnEdge()`).
 */
export class Via1d1541 {
  public readonly via: Via6522Vice;
  private readonly iec: IecBusCore;
  private readonly deviceId: number;

  constructor(opts: Via1d1541Options) {
    this.iec = opts.iec;
    this.deviceId = opts.deviceId;

    const backend: ViaBackend = {
      // VICE via1d1541.c read_prb (lines 337-362). Stock 1541 path
      // (no parallel cable, no 1571): build from iecbus->drv_port +
      // VIA_PRB latch + DDR + device-id high nibble.
      readPb: () => {
        const prb = this.via.via[0]!; // VIA_PRB = 0
        const ddrb = this.via.via[2]!;
        const driveId = ((this.deviceId - 8) << 5) & 0x60;
        const tmp = ((this.iec.drv_port ^ 0x85) | 0x1a | driveId) & 0xff;
        return u8(((prb & ddrb) | (tmp & ~ddrb)) & 0xff);
      },

      // VICE store_prb (lines 212-249). drive_data[unit] = ~byte;
      // recompute drv_bus[unit]; iec_update_ports.
      storePb: (_clk: CLOCK, byte: BYTE) => {
        this.iec.drive_store_pb(byte, this.deviceId);
      },

      // VICE read_pra (lines 290-322). Stock 1541 (no parallel cable):
      // returns latched PA + open bus on undriven bits.
      readPa: (_addr: number) => {
        const pra = this.via.via[VIA_PRA]!;
        const ddra = this.via.via[3]!;
        return u8(((pra & ddra) | (0xff & ~ddra)) & 0xff);
      },
      storePa: () => {
        // 1541 PA is parallel cable port — stock drive: no-op.
      },

      storeSr: () => undefined,
      storeT2L: () => undefined,
      storeAcr: () => undefined,
      storePcr: (val) => val,

      setCa2: () => undefined, // VICE via1d1541.c set_ca2: no-op.
      setCb2: () => undefined, // VICE via1d1541.c set_cb2: no-op.

      setInt: (value, clk) => opts.setIrq(value, clk),

      reset: () => undefined, // VICE via1d1541.c reset: no-op.
    };

    this.via = new Via6522Vice({
      alarmContext: opts.alarmContext,
      backend,
      clkRef: opts.clkRef,
      myname: opts.myname ?? `1541Drive${opts.deviceId - 8}Via1`,
      writeOffset: opts.writeOffset ?? 1,
      rmwFlagRef: opts.rmwFlagRef,
      rmwFlagSet: opts.rmwFlagSet,
      clkBump: opts.clkBump,
    });
  }

  /**
   * Forward an ATN edge from the C64 → drive VIA1 CA1.
   *
   * VICE wiring: c64iec.c iec_update_ports + iecbus.c
   * iecbus_cpu_write_conf1 lines 247-268 detect ATN edge and call
   * `viacore_signal(via1d1541, VIA_SIG_CA1, edge)` where edge =
   * `iec_old_atn ? 0 : VIA_SIG_RISE`. iec_old_atn = 0x10 → ATN
   * released (line HIGH) → tag 0; iec_old_atn = 0 → ATN asserted
   * (LOW) → tag 1.
   *
   * @param risingEdgeTag VICE-style edge tag — true = "tag 1" (ATN
   *        just went LOW i.e. asserted), false = "tag 0" (released).
   */
  signalAtnEdge(risingEdgeTag: boolean): void {
    this.via.signal("ca1", risingEdgeTag ? "rise" : "fall");
  }

  /** Reset the VIA core (does NOT reset the IEC bus). */
  reset(): void {
    this.via.reset();
  }

  read(addr: number): number {
    return this.via.read(addr);
  }

  write(addr: number, value: number): void {
    this.via.store(addr, value);
  }

  peek(addr: number): number {
    return this.via.peek(addr);
  }
}
