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
  type ViaBusAccessHook,
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
  /**
   * Spec 201-c3: optional override for $1800 PB store. When provided,
   * replaces the default `iec.drive_store_pb(byte, deviceId)` call so
   * the kernel can route the cross-domain access through KernelBus.
   * If undefined, falls back to the IecBusCore direct call (used by
   * standalone test fixtures that have no kernel).
   */
  iecStorePb?: (byte: number, deviceId: number) => void;
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
      // Spec 201-c3: route through KernelBus when caller supplies a
      // kernel-aware override; else fall back to direct IecBusCore.
      storePb: opts.iecStorePb
        ? (_clk: CLOCK, byte: BYTE) => opts.iecStorePb!(byte, this.deviceId)
        : (_clk: CLOCK, byte: BYTE) => {
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
    const result = this.via.read(addr);
    // Spec 142: emit bus-access event for ORB reads (addr 0 = VIA_PRB).
    if ((addr & 0xf) === 0) {
      this.busAccessHook?.emitDriveAccess({ op: "read", addr: this.baseAddr, value: result });
    }
    return result;
  }

  write(addr: number, value: number): void {
    // Spec 142: emit bus-access event for ORB writes.
    if ((addr & 0xf) === 0) {
      this.busAccessHook?.emitDriveAccess({ op: "write", addr: this.baseAddr, value: value & 0xff });
    }
    this.via.store(addr, value);
  }

  peek(addr: number): number {
    return this.via.peek(addr);
  }

  // ---- Legacy compatibility surface — Sprint 113 Phase 2 ----------------
  //
  // Drive callers (iec-bus.ts, integrated-session.ts, snapshot.ts,
  // headless.ts) were written against `Via6522`. These thin delegates
  // bridge the gap without requiring rewrites of every call site.
  // -----------------------------------------------------------------------

  /** Spec 142: optional bus-access trace hook for ORB R/W. */
  public busAccessHook?: ViaBusAccessHook;
  /** Spec 142: base address of this VIA (drive VIA1 = $1800). */
  public baseAddr = 0x1800;

  /** IFR (interrupt flag register) — proxied from inner Via6522Vice. */
  public get ifr(): number { return this.via.ifr; }
  public set ifr(v: number) { this.via.ifr = v & 0x7f; }
  /** IER (interrupt enable register) — proxied from inner Via6522Vice. */
  public get ier(): number { return this.via.ier; }
  public set ier(v: number) { this.via.ier = v & 0x7f; }
  /** PCR (peripheral control register) — proxied from inner Via6522Vice. */
  public get pcr(): number { return this.via.pcr; }
  public set pcr(v: number) { this.via.pcr = v & 0xff; }

  // ---- Snapshot field accessors (for snapshot.ts duck-typed ViaSnapshot) --
  /** ORA latch — delegates to Via6522Vice.ora. */
  public get ora(): number { return this.via.ora; }
  public set ora(v: number) { this.via.ora = v; }
  /** ORB latch — delegates to Via6522Vice.orb. */
  public get orb(): number { return this.via.orb; }
  public set orb(v: number) { this.via.orb = v; }
  /** DDRA — delegates to Via6522Vice.ddra. */
  public get ddra(): number { return this.via.ddra; }
  public set ddra(v: number) { this.via.ddra = v; }
  /** DDRB — delegates to Via6522Vice.ddrb. */
  public get ddrb(): number { return this.via.ddrb; }
  public set ddrb(v: number) { this.via.ddrb = v; }
  /** T1 counter (read) — delegates to Via6522Vice.t1Counter. */
  public get t1Counter(): number { return this.via.t1Counter; }
  /** T1 counter (write) — stores into latch registers only. */
  public set t1Counter(v: number) {
    this.via.via[4] = v & 0xff;          // VIA_T1CL
    this.via.via[5] = (v >> 8) & 0xff;   // VIA_T1CH
  }
  /** T1 latch — delegates to Via6522Vice.t1Latch. */
  public get t1Latch(): number { return this.via.t1Latch; }
  /** T1 latch (write) — stores into T1LL/T1LH. */
  public set t1Latch(v: number) {
    this.via.via[6] = v & 0xff;          // VIA_T1LL
    this.via.via[7] = (v >> 8) & 0xff;   // VIA_T1LH
    this.via.tal = v & 0xffff;
  }
  /** T2 counter (read) — delegates to Via6522Vice.t2Counter. */
  public get t2Counter(): number { return this.via.t2Counter; }
  /** T2 counter (write) — stores t2cl/t2ch fields. */
  public set t2Counter(v: number) {
    this.via.t2cl = v & 0xff;
    this.via.t2ch = (v >> 8) & 0xff;
    this.via.via[8] = v & 0xff;          // VIA_T2CL
    this.via.via[9] = (v >> 8) & 0xff;   // VIA_T2CH
  }
  /** ACR — delegates to Via6522Vice.acr. */
  public get acr(): number { return this.via.acr; }
  public set acr(v: number) { this.via.acr = v; }
  /** SR — delegates to Via6522Vice.sr. */
  public get sr(): number { return this.via.sr; }
  public set sr(v: number) { this.via.sr = v; }

  /**
   * Legacy: returns true iff an enabled IRQ source has its flag set.
   * Optional `_currentClock` ignored (alarm-driven core has no delay check).
   */
  irqAsserted(_currentClock?: number): boolean {
    return this.via.irqAsserted();
  }

  /**
   * Legacy: pulseCa1 shim — translates old `pulseCa1(newLevel, stamp?)` API
   * to the VICE `signal(ca1, rise|fall)` call used by iec-bus.ts ATN edge.
   *
   * VICE CA1 polarity on VIA1: PCR=0x01 → positive edge, PCR=0x00 →
   * negative edge. The drive ROM writes PCR=$01 so CA1 fires on ATN
   * assertion (CA1 input goes HIGH when ATN goes LOW — inverter in path).
   *
   * The legacy pulseCa1(newLevel) convention: `true` = pin HIGH.
   * VICE viacore_signal convention: `rise` = pin transitions high.
   * We detect the edge by comparing with the last seen pin state.
   */
  private _lastCa1 = true; // starts high (ATN released)
  pulseCa1(newLevel: boolean, _clockStamp?: number): void {
    const wasHigh = this._lastCa1;
    const isHigh = newLevel;
    this._lastCa1 = isHigh;
    if (!wasHigh && isHigh) {
      this.via.signal("ca1", "rise");
    } else if (wasHigh && !isHigh) {
      this.via.signal("ca1", "fall");
    }
    // No edge (no change) = no signal. VICE is edge-only, no level re-eval.
  }

  /**
   * Legacy: reevaluateCa1Level — Sprint 66 shim for boot-order race.
   * In the VICE-faithful core the signal() is edge-only; the re-eval
   * hack is only needed for the legacy core. Keep as a no-op stub so
   * iec-bus.ts `onCa1IerEnabled` wiring compiles and doesn't crash.
   */
  reevaluateCa1Level(_currentLevel: boolean): void {
    // VICE-faithful: edge-only. No-op; the CA1 IFR is set only on
    // a real edge (signal call), not on level re-eval.
  }

  /**
   * Legacy: onCa1IerEnabled callback — set by iec-bus.ts when CA1 IER
   * is newly enabled so stale ATN state can be re-evaluated. Kept as a
   * settable property so iec-bus.ts `attachDriveVia1` wiring still works.
   * The VICE core fires the interrupt only on a real signal edge, so the
   * callback itself is a no-op call (reevaluateCa1Level is a no-op above).
   */
  public onCa1IerEnabled?: () => void;
}
