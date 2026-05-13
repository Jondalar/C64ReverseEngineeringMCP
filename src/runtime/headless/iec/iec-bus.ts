// Spec 140 v3 — IEC bus 1:1 VICE port.
//
// Mirrors VICE 3.7.1 behavior with single source of truth =
// IecBusCore (= the iecbus_t struct). All state derived from core.
// No parallel "live released" flags. No iecMode flag.
//
// External API (atnLine/clkLine/dataLine getters, setC64Output,
// setDriveOutput, buildC64InputBits) preserved for back-compat;
// implementations now compute from core.cpu_port + core.cpu_bus.

import type { BusAccessTraceProducer } from "../trace/bus-access.js";
import { IecBusCore } from "./iec-bus-core.js";
import {
  IECBUS_STATUS_DRIVETYPE,
  IECBUS_STATUS_TRUEDRIVE,
  IecBusCallbacks,
  type IecBusOps,
} from "./iecbus-callbacks.js";

// PB bit positions for device-ID jumpers on 1541 VIA1 PB5/PB6.
// Moved here from drive/via1-iec.ts (Sprint 113 Phase 2).
const PB_DEV_ID0 = 1 << 5;
const PB_DEV_ID1 = 1 << 6;

/**
 * Drive VIA1 interface used by the IEC bus. Spec 432 (Phase B):
 * production ATN edge propagation goes through `signalAtnEdge`
 * (VICE viacore_signal edge-tag form).
 */
export interface DriveVia1Like {
  signalAtnEdge(risingEdgeTag: boolean): void;
}

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

  // Spec 417 — VICE iecbus_callback_{read,write} indirection. Owned
  // here so CIA2 + KernelBus can route through the same dispatcher
  // VICE uses (`(*iecbus_callback_write)(tmp, maincpu_clk + !write_offset)`
  // — c64cia2.c:162). The active callback variant (conf0..conf3) is
  // selected by `callbacks.statusSet(...)` (= iecbus_status_set).
  // Doc anchors: docs/vice-iec-arc42.md §15 Phase B step 6, §17.2.
  // VICE: src/iecbus.h:91-99, src/iecbus/iecbus.c:432-572.
  public readonly callbacks: IecBusCallbacks;

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

  // Spec 418 — Push-flush invariant per docs/vice-iec-arc42.md §15
  // Phase C step 7 + §5.11 call-site enumeration. Injected by the
  // owning kernel; executed by `_performC64Write` /
  // `_performC64Read` BEFORE any cpu_bus / drv_bus / cpu_port /
  // drv_port mutation.
  //
  // VICE 1:1 mapping (cf. §5.11 verified table 2026-05-11):
  //   - `flushAll(clock)`  ⇒ `drive_cpu_execute_all(clock)`
  //                          (= read sites: iecbus_cpu_read_conf{1,2,3})
  //   - `flushOne(clock)`  ⇒ `drive_cpu_execute_one(unit, clock)`
  //                          (= write sites: iecbus_cpu_write_conf{1,2})
  //
  // VICE source:
  //   src/iecbus/iecbus.c:229   (read_conf1 → drive_cpu_execute_all)
  //   src/iecbus/iecbus.c:241   (write_conf1 → drive_cpu_execute_one)
  //   src/drive/drive.c:991     (drive_cpu_execute_one)
  //   src/drive/drive.c:1001    (drive_cpu_execute_all)
  //
  // For x64sc + single 1541 on unit 8 (= conf1) the only sites that
  // fire are the conf1 pair; both call drive_cpu_execute_{one,all}
  // BEFORE mutating bus state. Doc §17.3 OQ-418-1 resolution.
  public pushFlush?: { all: (clock: number, cycleStepped: boolean) => void; one: (unit: number, clock: number, cycleStepped: boolean) => void };

  // Spec 418 — instrumentation hook (smoke-only). Records every site
  // that drove a push-flush so the smoke can assert each VICE §5.11
  // call site in TS actually issues the flush before mutation. Do
  // not use for production logic.
  public flushAuditor?: (rec: { kind: "all" | "one"; site: "c64-write" | "c64-read"; clock: number; preCpuBus: number; preCpuPort: number; cycleStepped: boolean }) => void;

  // Spec 435: hybrid-sync rule removed. The `cycleStepped` hint is
  // always false now; this field and its threading through
  // pushFlush.{one,all} remain to keep the call sites stable until
  // Spec 436 (post-port) deletes the parameter entirely.
  private flushCycleStepped = false;

  // Drive VIA1 reference for ATN edge propagation.
  private driveVia1?: DriveVia1Like;

  // Sprint 66 / Spec 144 territory: drive RAM $7C poke for legacy
  // trap-fast mode. Default null = disabled (truedrive-pure).
  // Kept here for future Spec 144 mode-gating.
  private driveRamForAtnPoke?: Uint8Array;
  private prevAtnLow = false;

  // Spec 204: kernel-injected hook recorder. Set by HeadlessMachineKernel
  // via `setHookRecorder`. When present, `releaseDriveClk` /
  // `releaseDriveData` call the recorder before mutating bus state —
  // the recorder throws HookForbiddenError if the current kernel
  // mode forbids the hook. Optional so legacy direct-construction tests
  // (no kernel) still work.
  private hookRecorder?: (name: "iec-release-clk" | "iec-release-data", description?: string) => void;

  // Spec 205-A c5: kernel-injected edge listener. Fires on every actual
  // line transition independent of the local `traceEnabled` flag — the
  // kernel decides whether to publish based on the "iec" trace channel
  // mode. Set via `setEdgeListener`.
  private edgeListener?: (rec: IecEdgeRecord) => void;

  constructor() {
    // Spec 417 — install the iecbus_callback_{read,write} dispatcher
    // and bind it to the IecBus's actual write/read primitives. The
    // ops object exposes `_performC64Write` / `_performC64Read` which
    // do the unconditional cpu_bus / drv_bus / ATN-edge mutation
    // (= the VICE conf1 body in src/iecbus/iecbus.c:226-287).
    const ops: IecBusOps = {
      performWrite: (data, clock) => this._performC64Write(data, clock),
      performRead: (clock) => this._performC64Read(clock),
    };
    this.callbacks = new IecBusCallbacks(ops);

    // Spec 417 step 6 — register the default config: x64sc + 1541 TDE
    // on unit 8 ⇒ conf1. We mirror VICE's resource-driven path that
    // calls iecbus_status_set during machine startup
    // (`src/iecbus/iecbus.c:521-572`). For our V2 single-1541 baseline
    // we set TRUEDRIVE + DRIVETYPE for unit 8; the resolved nibble is
    // 0b1100 which iecbus_device_index[12] maps to TRUEDRIVE → conf1.
    this.callbacks.statusSet(IECBUS_STATUS_TRUEDRIVE, 8, true);
    this.callbacks.statusSet(IECBUS_STATUS_DRIVETYPE, 8, true);
  }

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

  // Spec 205-A c5: install kernel edge listener. Always fired on real
  // line transitions; the listener decides whether to publish to the
  // "iec" trace channel.
  setEdgeListener(fn: (rec: IecEdgeRecord) => void): void {
    this.edgeListener = fn;
  }

  private recordEdge(side: "c64" | "drive", prev: { atn: boolean; clk: boolean; data: boolean }): void {
    const atn = this.atnLine, clk = this.clkLine, data = this.dataLine;
    if (atn === prev.atn && clk === prev.clk && data === prev.data) return;
    if (!this.traceEnabled && !this.edgeListener) return;
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
    if (this.traceEnabled) {
      this.trace.push(rec);
      if (this.trace.length > this.traceCapacity) this.trace.shift();
    }
    this.edgeListener?.(rec);
  }

  // === Drive VIA1 attachment ===

  attachDriveVia1(via: DriveVia1Like): void {
    this.driveVia1 = via;
    // Spec 432 — no synthetic CA1 edge or level seed at attach time.
    // VICE iecbus.c does not emit any CA1 signal during init; the
    // first real C64 $DD00 write fires the first edge via
    // iecbus_cpu_write_conf1 → viacore_signal(VIA_SIG_CA1, edge_tag).
    // iec_old_atn defaults to 0x10 (released) per iecbus.c:65, matching
    // IecBusCore's initial state, so the first C64 write that asserts
    // ATN produces the correct rising edge.
  }

  // === C64 IEC store ($DD00 PA write) ===
  // VICE flow: c64cia2.c:150 inverts byte → iecbus_callback_write →
  // iecbus_cpu_write_conf1 (iecbus.c:237):
  //   1. drive_cpu_execute_one(unit, clock)  — flush drive
  //   2. iec_update_cpu_bus(data)
  //   3. ATN edge → viacore_signal(via1d1541, CA1, ...)
  //   4. recompute drv_bus[8]
  //   5. iec_update_ports
  //
  // Spec 417: this is the legacy CIA2-side entrypoint. The store
  // (raw CIA PA byte → inverted → callback) now routes through the
  // VICE-style function-pointer indirection at
  // `this.callbacks.callbackWrite` (= iecbus_callback_write).
  // The conf1 callback ultimately invokes `_performC64Write(...)`,
  // which is where the cpu_bus mutation + ATN edge propagation lives.
  // Doc anchors: §15 Phase B step 4 + §17.2 OQ-417-1.
  // VICE: src/c64/c64cia2.c:148-162.
  setC64Output(cia2Pa: number, _ddrMask: number, effectiveClock?: number, cycleStepped?: boolean): void {
    // Per c64cia2.c:150 — invert raw PA byte before iecbus.
    const inverted = (~cia2Pa) & 0xff;
    // Spec 417: route through the VICE callback pointer. CIA2 normally
    // supplies effectiveClock = `maincpu_clk + !write_offset`
    // (= maincpu_clk + 1 for x64sc, see c64cia2.c:307-310 / :162);
    // a missing clock degrades to the live drive-clock source so
    // legacy direct callers (smokes / serial-matrix tests) still work.
    const clock = effectiveClock ?? this.driveClockSource?.() ?? 0;
    // Spec 435: cycleStepped hint always false post-port.
    this.flushCycleStepped = cycleStepped === true;
    this.callbacks.callbackWrite(inverted, clock);
    this.flushCycleStepped = false;
    this.busAccessProducer?.emitC64Access({ op: "write", addr: this.cia2PaAddr, value: cia2Pa & 0xff });
  }

  // Spec 417 / Spec 418 — atomic flush + cpu_bus mutation. Called from
  // the conf1 callback (or directly by smokes that bypass CIA2).
  //
  // VICE 1:1 sequence (src/iecbus/iecbus.c:237-287, write_conf1):
  //   1. drive_cpu_execute_one(unit, clock)         ← push-flush (Spec 418)
  //   2. iec_update_cpu_bus(data)                   ← cpu_bus mutation
  //   3. ATN edge check + viacore_signal(VIA1, CA1) ← edge propagation
  //   4. recompute drv_bus[8]                       ← drive contribution
  //   5. iec_update_ports                           ← cpu_port + drv_port
  //
  // Steps 2-5 happen inside core.c64_store_dd00 and execute as one
  // synchronous JS unit — the drive cannot tick between them (= the
  // §15 step 9 atomicity invariant; doc §16 invariant 1).
  //
  // Doc anchors: §15 Phase C steps 7-9, §5.11 (write_conf1 row 1),
  // §6.1 sequence diagram. Spec 418 promotes the flush from a
  // KernelBus precondition (which a future caller could forget) to
  // a property of the IecBus mutation primitive itself.
  // `data` is the post-`tmp = ~byte` inverted PA byte (c64cia2.c:150).
  private _performC64Write(data: number, clock: number): void {
    const prev = { atn: this.atnLine, clk: this.clkLine, data: this.dataLine };
    // Spec 418 step 1 — push-flush BEFORE any state mutation.
    // VICE: src/iecbus/iecbus.c:241 → drive_cpu_execute_one(unit, clock).
    if (this.pushFlush) {
      this.flushAuditor?.({
        kind: "one",
        site: "c64-write",
        clock,
        preCpuBus: this.core.cpu_bus,
        preCpuPort: this.core.cpu_port,
        cycleStepped: this.flushCycleStepped,
      });
      this.pushFlush.one(8, clock, this.flushCycleStepped);
    }
    // Spec 432 (Phase B) — production ATN edge uses VICE edge-tag
    // semantics. Literal mapping of VICE iecbus.c:247-268:
    //   viacore_signal(unit->via1d1541, VIA_SIG_CA1,
    //                  iec_old_atn ? 0 : VIA_SIG_RISE);
    // core.c64_store_dd00 → onAtnEdge(edgeTagRise: boolean)
    //                     → driveVia1.signalAtnEdge(edgeTagRise)
    //                     → via.signal("ca1", "rise"|"fall")
    // Previous level-based pulseCa1 production path removed per
    // Spec 430 §4.
    this.core.c64_store_dd00(data & 0xff, (edgeTagRise) => {
      this.driveVia1?.signalAtnEdge(edgeTagRise);
      this.prevAtnLow = edgeTagRise;
    });
    this.recordEdge("c64", prev);
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

  // === C64 reads $DD00 PA ($DC00 callback) ===
  // VICE: iecbus_cpu_read_conf1 returns CACHED iecbus.cpu_port.
  // Spec 417: routed through the VICE callback pointer
  // (`iecbus_callback_read`), which for the V2 single-drive baseline
  // dispatches to conf1. Doc anchors: §15 Phase B step 5 + §17.2.
  // VICE: src/c64/c64cia2.c read_ciapa, src/iecbus/iecbus.c:226.
  buildC64InputBits(effectiveClock?: number, cycleStepped?: boolean): number {
    const clock = effectiveClock ?? this.driveClockSource?.() ?? 0;
    // Spec 435: cycleStepped hint always false post-port.
    this.flushCycleStepped = cycleStepped === true;
    const result = this.callbacks.callbackRead(clock) & 0xff;
    this.flushCycleStepped = false;
    this.busAccessProducer?.emitC64Access({ op: "read", addr: this.cia2PaAddr, value: result });
    return result;
  }

  // Spec 417 / Spec 418 — atomic flush + cached cpu_port readback.
  //
  // VICE 1:1 sequence (src/iecbus/iecbus.c:226-234, read_conf1):
  //   1. drive_cpu_execute_all(clock)  ← push-flush (Spec 418)
  //   2. return iecbus.cpu_port        ← cached readback (no mutation)
  //
  // The read variant does not mutate state, but the flush is still
  // mandatory: the C64's observed `cpu_port` already includes the
  // AND-fold of every drv_bus[unit] (cf. core.iec_update_ports), and
  // those drv_bus contributions only reflect drive activity up to
  // the drive's last instruction boundary. Without the flush, the
  // drive would still be lagging and the C64 would read a stale
  // bus snapshot — observable at every fastloader bit-pump.
  //
  // Doc anchors: §15 Phase C steps 7-9, §5.11 (read_conf1 row 2),
  // §6.2 sequence diagram, §16 invariant 1.
  private _performC64Read(clock: number): number {
    if (this.pushFlush) {
      this.flushAuditor?.({
        kind: "all",
        site: "c64-read",
        clock,
        preCpuBus: this.core.cpu_bus,
        preCpuPort: this.core.cpu_port,
        cycleStepped: this.flushCycleStepped,
      });
      this.pushFlush.all(clock, this.flushCycleStepped);
    }
    return this.core.cpu_port & 0xff;
  }

  // === Drive reads $1800 PB === (legacy fallback for trace etc.)
  // Production path goes through via1d1541.readPb (literal VICE
  // via1d1541.c:323-347 formula). This helper kept for back-compat
  // callers (trace iec snapshot, unit tests).
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

  // Spec 204: install kernel hook recorder. Called by
  // HeadlessMachineKernel after `kernel.hooks` is built. When set, the
  // synthetic release methods record + audit the fire before mutating
  // bus state.
  setHookRecorder(
    fn: (name: "iec-release-clk" | "iec-release-data", description?: string) => void,
  ): void {
    this.hookRecorder = fn;
  }

  // Sprint 72: synthetic line release for trap-fast mode (Spec 204
  // gates this). Direct mutation of drv_data; bypasses normal
  // store_prb flow.
  releaseDriveClk(description?: string): void {
    this.hookRecorder?.("iec-release-clk", description);
    // Set drive_data[8] bit 3 (CLK_OUT inverted) = 1 (= drive
    // released). Recompute drv_bus[8] + ports.
    const dd = this.core.drv_data[8] ?? 0xff;
    this.core.drv_data[8] = (dd | 0x08) & 0xff;
    this.core.recompute_drv_bus(8);
    this.core.iec_update_ports();
  }
  releaseDriveData(description?: string): void {
    this.hookRecorder?.("iec-release-data", description);
    const dd = this.core.drv_data[8] ?? 0xff;
    this.core.drv_data[8] = (dd | 0x02) & 0xff;
    this.core.recompute_drv_bus(8);
    this.core.iec_update_ports();
  }

  reset(): void {
    this.core.reset();
    this.prevAtnLow = false;
  }

  // Spec 432 — production no longer caches a CA1 level in via1d1541.
  // The first C64 $DD00 ATN-asserting write fires the rising edge
  // directly via iecbus.c:251 viacore_signal(VIA_SIG_CA1, edge_tag).
  // This method is kept as a no-op for backwards-compat callers
  // (IntegratedSession.resetCold).
  syncDriveCa1Baseline(): void {
    // intentionally no-op (Spec 432, see method header)
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
