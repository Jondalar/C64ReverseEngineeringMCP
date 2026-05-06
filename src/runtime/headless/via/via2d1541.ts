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
import {
  Via6522Vice,
  type ViaBackend,
  type Via6522ViceOptions,
} from "./via6522-vice.js";

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

  constructor(opts: Via2d1541Options) {
    const backend: ViaBackend = {
      readPa: () => 0xff,
      readPb: () => 0x10,
      storePa: () => undefined,
      storePb: () => undefined,
      storeSr: () => undefined,
      storeT2L: () => undefined,
      storeAcr: () => undefined,
      storePcr: (val: BYTE) => val,
      setCa2: () => undefined,
      setCb2: () => undefined,
      setInt: (value, clk) => opts.setIrq(value, clk),
      reset: () => undefined,
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
}
