// CIA2 ($DD00-$DD0F) — IEC bus + RS232 + VIC bank select + NMI source.
//
// Spec 064: full CIA model. Replaces the pre-Sprint-69 attachCia2ToIecBus
// PA-only stub. Now Port A goes through the real CIA's PRA latch +
// DDR-aware read; the IEC backend forwards bus-state changes.
// Port B (user port + RS232) is stubbed.
//
// Sprint 113 Phase 2 (Spec 146): backed by Cia6526Vice.
//
// Spec 201-c2 (2026-05-06): CIA2 no longer talks to IecBus directly.
// PA writes go through `iecWrite(or, ddr)` and PA reads through
// `iecReadPins()`, both supplied by the caller (kernel) which routes
// them through KernelBus → cross-domain bus contract. Backwards-compat
// for callers that still pass an IecBus reference is preserved by the
// kernel constructor adapting between the two.

import { Cia6526Vice, type CiaBackend } from "../cia/cia6526-vice.js";
import type { AlarmContext } from "../alarm/alarm-context.js";
import type { CLOCK } from "../util/uint.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";

export const CIA2_BASE = 0xdd00;

export interface InstalledCia2 {
  cia: Cia6526Vice;
  /** True iff the CIA2 NMI pin is currently asserted (mirrors VICE). */
  nmiLine: () => boolean;
}

export interface InstallCia2Options {
  /** Maincpu alarm context. CIA2 alarms register here. */
  alarmContext: AlarmContext;
  /** CPU clock provider — usually `() => session.c64Cpu.cycles`. */
  clkPtr: () => CLOCK;
  /** VICE: C64SC/SCPU64 use CIA write_offset=0; default core uses 1. */
  writeOffset?: number;
  /**
   * Spec 203-c2: optional NMI edge callback. Called when CIA2's
   * IRQ pin level changes (asserts → CPU NMI). Implementer routes
   * to `kernel.emitIrqEvent` with edgeClock / source / target.
   */
  onNmiEdge?: (asserted: boolean, edgeClock: CLOCK) => void;
  /**
   * Spec 201-c2: PA-out write callback. Called when CIA2 PA latch /
   * DDR is updated. Implementer routes the composed PA byte to the IEC
   * bus, typically via `kernel.bus.c64Write(0xDD00, ...)` which then
   * delegates to `iecBus.setC64Output`.
   */
  iecWrite: (paOut: number, ddr: number, effectiveClock?: CLOCK) => void;
  /**
   * Spec 201-c2: PA-in read callback. Returns the IEC line state as
   * an 8-bit byte (raw `cpu_port`-equivalent input bits). Implementer
   * routes through `kernel.bus.c64Read(0xDD00, ...)`.
   */
  iecReadPins: () => number;
}

export function installCia2(
  bus: HeadlessMemoryBus,
  opts: InstallCia2Options,
): InstalledCia2 {
  let cia: Cia6526Vice | undefined;
  const writeOffset = opts.writeOffset ?? 1;
  const iecWriteClock = () => opts.clkPtr() + (writeOffset === 0 ? 1 : 0);
  // CIA2 IRQ pin → C64 NMI line. VICE c64cia2.c cia2_set_int_clk
  // drives maincpu_set_nmi(I_CIA2, value).
  let nmiLevel = 0;

  const backend: CiaBackend = {
    // Per VICE c64cia2.c:148-162 — when CIA2 PA-out changes, the
    // composed PA byte (latch | ~ddr) is forwarded to iecbus / VIC
    // bank logic via the kernel-supplied iecWrite callback.
    storePa: (paOut) => {
      if (!cia) return;
      const ddr = cia.c_cia[2] /* CIA_DDRA */ ?? 0;
      opts.iecWrite(paOut, ddr, iecWriteClock());
    },
    storePb: () => { /* user port not modeled */ },
    // VICE c64cia2.c read_ciapa:
    //   value = ((PRA | ~DDRA) & 0x3f) | iecbus_callback_read(clk)
    // The IEC callback returns cached cpu_port bits 4/6/7. Low port
    // input bits float high unless userport PA2/PA3 pulls them low
    // (userport not modeled here).
    readPa: () => {
      const pins = opts.iecReadPins();
      if (!cia) return pins;
      const pra = cia.c_cia[0] /* CIA_PRA */ ?? 0;
      const ddr = cia.c_cia[2] /* CIA_DDRA */ ?? 0;
      return (((pra | ~ddr) & 0x3f) | pins) & 0xff;
    },
    readPb: () => 0xff,
    pulsePc: () => { /* RS232 handshake — unused */ },
    setIntClk: (val) => {
      const prev = nmiLevel;
      nmiLevel = val;
      // Spec 203-c2: emit timestamped edge on level change.
      if ((prev !== 0) !== (val !== 0)) {
        opts.onNmiEdge?.(val !== 0, opts.clkPtr());
      }
    },
  };

  cia = new Cia6526Vice({
    backend,
    alarmContext: opts.alarmContext,
    clkPtr: opts.clkPtr,
    name: "CIA2",
    writeOffset: opts.writeOffset,
  });
  cia.reset();

  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA2_BASE + reg;
    const c = cia;
    bus.registerIoHandler(addr, {
      read: () => c.read(reg),
      write: (_a, value) => c.write(reg, value),
    });
  }
  // Initial PA state: output bits all-high so IEC bus starts released.
  // KERNAL IOINIT will program proper DDR/PRA later.
  opts.iecWrite(0xff, 0x3f, iecWriteClock());
  return {
    cia,
    nmiLine: () => nmiLevel !== 0,
  };
}
