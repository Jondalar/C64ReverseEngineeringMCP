// CIA1 ($DC00-$DC0F) — keyboard / joystick port + system 60Hz timer.
//
// Spec 064: full CIA model with timer A driving the standard jiffy
// IRQ. Replaces the pre-Sprint-69 `installCia1KeyboardStub`.
//
// Sprint 113 Phase 2 (Spec 146): now backed by Cia6526Vice — the 1:1
// VICE-faithful alarm-driven core. The CiaBackend wraps keyboard +
// joystick I/O (matches VICE c64cia1.c read_ciapa/read_ciapb pattern)
// and the IRQ-line callback (`setIntClk`) latches the CPU IRQ pin.
//
// Port A ($DC00) = keyboard column write + joystick port 2.
// Port B ($DC01) = keyboard row read + joystick port 1.
//
// Keyboard backend (Sprint 69a baseline): all keys released. Spec 063
// Phase C adds a scriptable input queue.

import { Cia6526Vice, type CiaBackend } from "../cia/cia6526-vice.js";
import type { AlarmContext } from "../alarm/alarm-context.js";
import type { CLOCK } from "../util/uint.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import { KeyboardMatrix, joystickActiveLowMask, type JoystickState } from "./keyboard.js";
import type { InterruptCpuStatus } from "../cpu/interrupt-cpu-status.js";

export const CIA1_BASE = 0xdc00;

export interface InstalledCia1 {
  cia: Cia6526Vice;
  keyboard: KeyboardMatrix;
  joystick2: JoystickState;
  joystick1: JoystickState;  // Spec 107 v1
}

export interface InstallCia1Options {
  /** Maincpu alarm context. CIA1 alarms register here. */
  alarmContext: AlarmContext;
  /** CPU clock provider — usually `() => session.c64Cpu.cycles`. */
  clkPtr: () => CLOCK;
  /** VICE: C64SC/SCPU64 use CIA write_offset=0; default core uses 1. */
  writeOffset?: number;
  /**
   * Spec 309 Phase D: InterruptCpuStatus instance for the main CPU.
   * CIA1 setIntClk calls cpuIntStatus.setIrq(cia1IntNum, value, clk)
   * directly (= c64cia1.c:95-98 interrupt_set_irq).
   */
  cpuIntStatus: InterruptCpuStatus;
  /**
   * Spec 203-c2: optional IRQ edge callback. Called when CIA1's
   * IRQ pin level changes. Implementer routes to
   * `kernel.emitIrqEvent` with edgeClock / source / target.
   */
  onIrqEdge?: (asserted: boolean, edgeClock: CLOCK) => void;
}

export function installCia1(bus: HeadlessMemoryBus, opts: InstallCia1Options): InstalledCia1 {
  const keyboard = new KeyboardMatrix();
  const joystick2: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  const joystick1: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  let cia: Cia6526Vice | undefined;
  // Spec 309 Phase D: allocate intNum once — matches ciacore_init.
  const cia1IntNum = opts.cpuIntStatus.newIntNum("CIA1");

  // Sprint 79: keyboard matrix backend reads PA latch (column drive)
  // and returns active row bits (active-low) for currently-pressed
  // keys. Spec 107 (M2.5) — joystick port 1 wired to PB inputs ANDed
  // with keyboard rows so a joy1 down-bit pulls the corresponding PB
  // pin low even when no key is pressed.
  // Sprint 93.1: PA backend now exposes joystick port 2 state (active-
  // low bits 0-4). Real C64 wires joystick port 2 directly to CIA1 PA
  // inputs; keyboard column drive is the CIA's PA latch (output).
  //
  // Spec 403 / OQ-403-3 (RESOLVED) — docs/vice-c64-arch.md §6.6.
  // Exact VICE formula at src/c64/c64cia1.c:337 (read_ciapa) and
  // :425-431 (read_ciapb). Joystick pulls bits LOW via final AND,
  // regardless of DDR / PR latch — it is a digital pull-down ANDed
  // with the post-DDR latch value, NOT a "joystick override".
  const backend: CiaBackend = {
    storePa: () => { /* PA pins drive keyboard columns; nothing else */ },
    storePb: () => { /* PB pins are inputs from keyboard rows */ },
    // VICE: c64cia1.c:337 read_ciapa
    //   byte = (val & (PRA | ~DDRA)) & read_joyport_dig(JOYPORT_2);
    // where `val` is the keyboard-back-scan byte (0xff when PB does
    // not drive columns — the dominant case). We skip the back-scan
    // (it is documented at c64cia1.c:298-334 but never exercised by
    // KERNAL / standard games) and use val=0xff, which is equivalent
    // to `(PRA | ~DDRA) & joy2`.
    readPa: () => {
      const joy = joystickActiveLowMask(joystick2);
      if (!cia) return joy;
      const pra = cia.c_cia[0] /* CIA_PRA */ ?? 0;
      const ddr = cia.c_cia[2] /* CIA_DDRA */ ?? 0;
      return ((pra | ~ddr) & joy) & 0xff;
    },
    // VICE: c64cia1.c:425-431 read_ciapb
    //   byte = val & (PRB | ~DDRB);
    //   byte |= val_outhi;          (val_outhi = DDRB & PRB)
    //   byte &= read_joyport_dig(JOYPORT_1);
    // `val` here is the keyboard-row pull-down byte derived from the
    // PA column scan. KERNAL programs DDRB=0 (PB all input), so
    // val_outhi=0 and (PRB | ~DDRB)=0xff, collapsing to `val & joy1`.
    // We compute val via keyboard.readRowsForPa(PA-effective).
    readPb: () => {
      if (!cia) return 0xff;
      const pra = cia.c_cia[0] /* CIA_PRA */ ?? 0;
      const ddra = cia.c_cia[2] /* CIA_DDRA */ ?? 0;
      const prb = cia.c_cia[1] /* CIA_PRB */ ?? 0;
      const ddrb = cia.c_cia[3] /* CIA_DDRB */ ?? 0;
      const paOut = (pra | ~ddra) & 0xff;
      const val = keyboard.readRowsForPa(paOut);
      const valOutHi = (ddrb & prb) & 0xff;
      const joyMask = joystickActiveLowMask(joystick1);
      return ((val & ((prb | ~ddrb) & 0xff)) | valOutHi) & joyMask & 0xff;
    },
    pulsePc: () => { /* unused on CIA1 */ },
    // Spec 309 Phase D: setIntClk pushes edge into cpuIntStatus directly
    // (= c64cia1.c:95-98 interrupt_set_irq). CPU reads globalPendingInt
    // at opcode boundary; no level-polling from session.
    setIntClk: (val, clk) => {
      const asserted = val !== 0;
      const prevAsserted = (opts.cpuIntStatus.pendingInt[cia1IntNum.id]! & 0x02 /* IK_IRQ */) !== 0;
      opts.cpuIntStatus.setIrq(cia1IntNum, asserted, clk);
      if (asserted !== prevAsserted) {
        opts.onIrqEdge?.(asserted, clk);
      }
    },
  };

  cia = new Cia6526Vice({
    backend,
    alarmContext: opts.alarmContext,
    clkPtr: opts.clkPtr,
    name: "CIA1",
    writeOffset: opts.writeOffset,
  });
  cia.reset();

  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    const c = cia;
    bus.registerIoHandler(addr, {
      read: () => c.read(reg),
      write: (_a, value) => c.write(reg, value),
      // Spec 754 §3.4 / BUG-038 — side-effect-free peek (VICE ciacore_peek):
      // no ICR read-to-clear, no timer-read latch effects.
      peek: () => c.peek(reg),
    });
  }
  return {
    cia,
    keyboard,
    joystick2,
    joystick1,
  };
}
