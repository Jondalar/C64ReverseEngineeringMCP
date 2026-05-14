// Spec 147 — VIA2 (1541 GCR) instance, Phase 1 idle stub.
//
// Source spec decision 5 (specs/147-via-full-vice-port.md):
//   readPa: () => 0xff             (idle GCR bus)
//   readPb: () => 0x10             (write-protect bit 4 = 0,
//                                   all other bits inactive — disk
//                                   present + writable)
//   storePa/Pb/Sr/T2L: no-op
//   CA1 (byte-ready): never signaled
//   setCa2/setCb2:  no-op
//   setInt:         routed to drive CPU IRQ line
//   reset:          no-op
//
// Real GCR / motor / head sim is Spec 152 V2 backlog. The full VIA
// chip core (timers, SR, IFR/IER, latching, PCR/ACR) is still wired
// — only the BACKEND is stubbed. This means drive ROM running its
// VIA2 register R/W path will see a self-consistent VIA whose port
// pins read as "idle drive, no disk activity".

import type { AlarmContext } from "../alarm/alarm-context.js";
import { type BYTE, type CLOCK } from "../util/uint.js";
import { rotation_rotate_disk } from "../drive/rotation.js";
import type {
  InterruptCpuStatus,
  IntNum,
} from "../cpu/interrupt-cpu-status.js";
import {
  Via6522Vice,
  VIA_DDRB,
  type ViaBackend,
  type Via6522ViceOptions,
} from "./via6522-vice.js";

/**
 * Optional GCR port coupling for Via2d1541.
 *
 * Spec 147 idle-stub uses hardcoded pin values. When GCR track data is
 * available (Spec 62 / Sprint 96), callers supply this coupling to wire
 * real PA (GCR byte) and PB (sync + head control) backends.
 *
 * Sprint 113 Phase 2 bridge: translates old ViaPortBackend-style
 * `readPins + onOutputChanged` interface to the ViaBackend (Via6522Vice)
 * `readPb + storePb` interface so existing via2-gcr.ts functions can be
 * used unchanged.
 */
export interface Via2GcrPortCoupling {
  /** Pin-state reader for PA (GCR data bus). */
  readPa(): number;
  /** Called when PA ORB+DDRB changes. `orValue` = OR latch, `ddrMask` = DDRB. */
  onPaOutputChanged?(orValue: number, ddrMask: number, cause: "or" | "ddr" | "reset"): void;
  /** Pin-state reader for PB (motor, step, SYNC, WPS, density). */
  readPb(): number;
  /** Called when PB ORB+DDRB changes. `orValue` = OR latch, `ddrMask` = DDRB. */
  onPbOutputChanged?(orValue: number, ddrMask: number): void;
}

export interface Via2d1541Options {
  alarmContext: AlarmContext;
  /** Live drive CPU clock pointer. */
  clkRef: () => CLOCK;
  /** IRQ propagation to drive CPU. */
  setIrq: (value: number, clk: CLOCK) => void;
  /** Optional name override. Default `1541Drive0Via2`. */
  myname?: string;
  rmwFlagRef?: Via6522ViceOptions["rmwFlagRef"];
  rmwFlagSet?: Via6522ViceOptions["rmwFlagSet"];
  clkBump?: Via6522ViceOptions["clkBump"];
  writeOffset?: number;
  /**
   * Optional GCR port coupling. When provided, PA reads from GCR track
   * data and PB writes propagate head step / motor / density. When absent,
   * the idle stub is used (PA=0xff, PB=WPS-only, no side effects).
   */
  gcr?: Via2GcrPortCoupling;

  /**
   * Spec 441 step 4e — drive_t for byte-ready PCR gate update. When
   * provided, PCR writes mirror bit 1 (CA2 control = BRA_BYTE_READY)
   * into drive.byte_ready_active. VICE: via2d.c via2d_update_pcr.
   */
  shadowDrive?: import("../drive/drive-t.js").Drive_t;
}

/**
 * VIA2 1541 instance — idle-stub backend per spec 147 decision 5.
 *
 * The chip core is fully VICE-faithful; only the GCR head/motor
 * domain is stubbed. The drive CPU sees:
 *   - PA reads = 0xff (idle data bus)
 *   - PB reads = 0x10 (write-protect bit 4 cleared)
 *   - No byte-ready interrupt (CA1 never signaled)
 *   - All output writes accepted but not propagated anywhere
 *
 * Spec 152 swaps this backend for real GCR bit-stream + motor + head
 * simulation. The `Via6522Vice` chip core stays untouched.
 */
export class Via2d1541 {
  public readonly via: Via6522Vice;

  // Spec 444 v2 — VIA2 chip-side IRQ push (analog of Spec 410 VIA1).
  // VICE: src/drive/iecieee/via2d.c:113 `set_int()` calls
  //   `interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk)`.
  // When `attachIrqLine` has been called, viacore's `update_myviairq`
  // pushes directly into the drive CPU's `InterruptCpuStatus`; the
  // legacy per-instruction polling bridge in DriveCpu.executeToClock
  // is dropped.
  private chipIntStatus?: InterruptCpuStatus;
  private chipIntNum?: IntNum;
  private chipPrev = false;

  constructor(opts: Via2d1541Options) {
    // Sprint 113 Phase 2: GCR coupling bridges the old ViaPortBackend
    // readPins/onOutputChanged API to Via6522Vice's readPb/storePb. The
    // storePb receives `bbOut = PRB | ~DDRB` from viacore.c; we recover
    // the OR latch as `bbOut & DDRB` (or read directly from via array).
    const gcr = opts.gcr;
    const backend: ViaBackend = {
      readPa: gcr ? () => gcr.readPa() : () => 0xff,
      readPb: gcr ? () => gcr.readPb() : () => 0x10,
      storePa: gcr
        ? (_clk, _baOut, _oldpa, addr) => {
            // Recover orValue and ddrMask from the VIA's internal state.
            // via[1] = ORA (VIA_PRA), via[3] = DDRA. Both already updated
            // by via6522-vice before calling storePa.
            const ddrMask = this.via.via[3]! & 0xff;  // DDRA = via[3]
            const orValue = this.via.via[1]! & 0xff;  // ORA = via[1] (VIA_PRA)
            // Determine cause: addr 1 = ORA write, addr 3 = DDRA write,
            // addr 0 = reset path. VIA_PRA=1, VIA_DDRA=3, VIA_PRA_NHS=15.
            const cause: "or" | "ddr" | "reset" =
              addr === 3 ? "ddr" : addr === 0 ? "reset" : "or";
            gcr.onPaOutputChanged?.(orValue, ddrMask, cause);
          }
        : () => undefined,
      storePb: gcr
        ? (_clk, bbOut) => {
            // Recover orValue from bbOut: bbOut = PRB | ~DDRB → orValue = bbOut & DDRB.
            const ddrMask = this.via.via[VIA_DDRB]! & 0xff;
            const orValue = bbOut & ddrMask;
            gcr.onPbOutputChanged?.(orValue, ddrMask);
          }
        : () => undefined,
      storeSr: () => undefined,
      storeT2L: () => undefined,
      storeAcr: () => undefined,
      storePcr: (val: BYTE) => {
        // Spec 441 step 4e — VICE via2d.c:165 via2d_update_pcr literal
        // port. Called on every PCR write.
        //   rotation_rotate_disk(dptr);
        //   dptr->read_write_mode = pcrval & 0x20;
        //   dptr->byte_ready_active =
        //       (bra & ~BRA_BYTE_READY) | (pcrval & PCR_BYTE_READY);
        if (opts.shadowDrive) {
          // Defer the heavy rotation work — avoid require-cycle imports.
          const drv = opts.shadowDrive;
          rotation_rotate_disk(drv);
          drv.read_write_mode = val & 0x20;
          drv.byte_ready_active =
            (drv.byte_ready_active & ~0x02) | (val & 0x02);
        }
        return val;
      },
      // VICE via2d.c:72 set_ca2 — only fires on PCR CA2 control
      // transitions in the chip core. Here `state` = the post-change
      // CA2 output state. VICE compares to (drv->byte_ready_active>>1)&1.
      //   if change: rotation_rotate_disk; update bit; if edge: V flag.
      setCa2: (state: number) => {
        if (!opts.shadowDrive) return;
        const drv = opts.shadowDrive;
        const curr = (drv.byte_ready_active >> 1) & 1;
        const next = state & 1;
        if (next !== curr) {
          rotation_rotate_disk(drv);
          drv.byte_ready_active = (drv.byte_ready_active & ~0x02) | (next << 1);
          // VICE via2d.c:86 — on CA2 transition with pending edge,
          // drive_cpu_set_overflow consumes the edge. Plumbing for
          // this lives in DriveCpu.fireByteReady; the consumer is
          // wired separately when consumers are flipped to drive_t.
          // (No-op until step 4e-flip is re-enabled.)
        }
      },
      // VICE via2d.c:95 set_cb2 — read/write mode toggle (bit 5 of
      // PCR CB2 control). VICE: drv->read_write_mode = state << 5.
      setCb2: (state: number) => {
        if (!opts.shadowDrive) return;
        const drv = opts.shadowDrive;
        const curr = (drv.read_write_mode >> 5) & 1;
        const next = state & 1;
        if (next !== curr) {
          rotation_rotate_disk(drv);
          drv.read_write_mode = next << 5;
        }
      },
      // Spec 444 v2 — chip-side IRQ push. Mirrors VIA1 (via1d1541.ts:163).
      // When chipIntStatus attached, push level changes directly into
      // InterruptCpuStatus (VICE drivecpu_int_status); the legacy
      // callback still fires for Spec 203-c3 edge consumers.
      setInt: (value, clk) => {
        if (this.chipIntStatus && this.chipIntNum) {
          const asserted = value !== 0;
          if (asserted !== this.chipPrev) {
            this.chipPrev = asserted;
            this.chipIntStatus.setIrq(this.chipIntNum, asserted, clk);
          }
        }
        opts.setIrq(value, clk);
      },
      // Spec 444 — VICE via2d.c:423-431 reset:
      //   drv->led_status = 1;
      //   drive_update_ui_status();   // UI hook, not emulation-relevant
      reset: () => {
        if (opts.shadowDrive) {
          opts.shadowDrive.led_status = 1;
        }
      },
    };

    this.via = new Via6522Vice({
      alarmContext: opts.alarmContext,
      backend,
      clkRef: opts.clkRef,
      myname: opts.myname ?? "1541Drive0Via2",
      writeOffset: opts.writeOffset ?? 1,
      rmwFlagRef: opts.rmwFlagRef,
      rmwFlagSet: opts.rmwFlagSet,
      clkBump: opts.clkBump,
    });
  }

  reset(): void { this.via.reset(); }

  read(addr: number): number { return this.via.read(addr); }
  write(addr: number, value: number): void { this.via.store(addr, value); }
  peek(addr: number): number { return this.via.peek(addr); }

  // ---- Legacy compatibility surface — Sprint 113 Phase 2 ----------------

  /** IFR (interrupt flag register) — proxied from inner Via6522Vice. */
  public get ifr(): number { return this.via.ifr; }
  public set ifr(v: number) { this.via.ifr = v & 0x7f; }
  /** IER (interrupt enable register) — proxied from inner Via6522Vice. */
  public get ier(): number { return this.via.ier; }
  public set ier(v: number) { this.via.ier = v & 0x7f; }

  /**
   * Legacy: irqAsserted — returns true iff any enabled IFR bit is set.
   * Optional `_currentClock` ignored (alarm-driven, no delay check).
   */
  irqAsserted(_currentClock?: number): boolean {
    return this.via.irqAsserted();
  }

  // ---- Snapshot field accessors (for snapshot.ts duck-typed ViaSnapshot) --
  public get ora(): number { return this.via.ora; }
  public set ora(v: number) { this.via.ora = v; }
  public get orb(): number { return this.via.orb; }
  public set orb(v: number) { this.via.orb = v; }
  public get ddra(): number { return this.via.ddra; }
  public set ddra(v: number) { this.via.ddra = v; }
  public get ddrb(): number { return this.via.ddrb; }
  public set ddrb(v: number) { this.via.ddrb = v; }
  public get t1Counter(): number { return this.via.t1Counter; }
  public set t1Counter(v: number) {
    this.via.via[4] = v & 0xff;
    this.via.via[5] = (v >> 8) & 0xff;
  }
  public get t1Latch(): number { return this.via.t1Latch; }
  public set t1Latch(v: number) {
    this.via.via[6] = v & 0xff;
    this.via.via[7] = (v >> 8) & 0xff;
    this.via.tal = v & 0xffff;
  }
  public get t2Counter(): number { return this.via.t2Counter; }
  public set t2Counter(v: number) {
    this.via.t2cl = v & 0xff;
    this.via.t2ch = (v >> 8) & 0xff;
    this.via.via[8] = v & 0xff;
    this.via.via[9] = (v >> 8) & 0xff;
  }
  public get acr(): number { return this.via.acr; }
  public set acr(v: number) { this.via.acr = v; }
  public get pcr(): number { return this.via.pcr; }
  public set pcr(v: number) { this.via.pcr = v; }
  public get sr(): number { return this.via.sr; }
  public set sr(v: number) { this.via.sr = v; }

  /**
   * Spec 444 v2 — VIA2 chip-side IRQ push (mirror of Spec 410 VIA1).
   *
   * VICE source: src/drive/iecieee/via2d.c:113-122 `set_int()` calls
   *   `interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk)`.
   *
   * Called by `DriveCpu` after constructing the drive 6502 — passes the
   * drive's `InterruptCpuStatus`. The VIA core's `update_myviairq`
   * pushes IRQ level transitions directly into `cpuIntStatus`; the
   * 2-cycle INTERRUPT_DELAY is honoured per `interrupt_set_irq`.
   * Legacy `executeToClock` polling bridge dropped once attached.
   */
  attachIrqLine(cpuIntStatus: InterruptCpuStatus, label = "via2-irq"): void {
    this.chipIntStatus = cpuIntStatus;
    this.chipIntNum = cpuIntStatus.newIntNum(label);
    // Seed level: viacore's current (ifr & ier & 0x7f) != 0 state.
    const asserted = this.via.irqAsserted();
    this.chipPrev = asserted;
    this.chipIntStatus.setIrq(this.chipIntNum, asserted, 0);
  }
}
