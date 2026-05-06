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

export const CIA1_BASE = 0xdc00;

export interface InstalledCia1 {
  cia: Cia6526Vice;
  keyboard: KeyboardMatrix;
  joystick2: JoystickState;
  joystick1: JoystickState;  // Spec 107 v1
  /** True iff the CIA1 IRQ pin is currently asserted (mirrors VICE). */
  irqLine: () => boolean;
}

export interface InstallCia1Options {
  /** Maincpu alarm context. CIA1 alarms register here. */
  alarmContext: AlarmContext;
  /** CPU clock provider — usually `() => session.c64Cpu.cycles`. */
  clkPtr: () => CLOCK;
}

export function installCia1(bus: HeadlessMemoryBus, opts: InstallCia1Options): InstalledCia1 {
  const keyboard = new KeyboardMatrix();
  const joystick2: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  const joystick1: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  let cia: Cia6526Vice | undefined;
  // CIA1 IRQ pin level — VICE c64cia1.c cia1_set_int_clk drives
  // maincpu_set_irq(I_CIA1, value). Here we just latch the level so
  // the integrated-session interrupt-line refresh can sample it.
  let irqLevel = 0;

  // Sprint 79: keyboard matrix backend reads PA latch (column drive)
  // and returns active row bits (active-low) for currently-pressed
  // keys. Spec 107 (M2.5) — joystick port 1 wired to PB inputs ANDed
  // with keyboard rows so a joy1 down-bit pulls the corresponding PB
  // pin low even when no key is pressed.
  // Sprint 93.1: PA backend now exposes joystick port 2 state (active-
  // low bits 0-4). Real C64 wires joystick port 2 directly to CIA1 PA
  // inputs; keyboard column drive is the CIA's PA latch (output).
  const backend: CiaBackend = {
    storePa: () => { /* PA pins drive keyboard columns; nothing else */ },
    storePb: () => { /* PB pins are inputs from keyboard rows */ },
    // VICE c64cia1.c read_ciapa: latch (DDR-output bits) | joystick
    // active-low (DDR-input bits + pin pulls). KERNAL writes PA all-1
    // to release columns, then walks bit by bit; reading PA must
    // expose joy2 pulls AND the column the KERNAL just wrote.
    readPa: () => {
      const joy = joystickActiveLowMask(joystick2);
      if (!cia) return joy;
      const pra = cia.c_cia[0] /* CIA_PRA */ ?? 0;
      const ddr = cia.c_cia[2] /* CIA_DDRA */ ?? 0;
      // Open-collector: a low pull from joy clamps even output-high
      // pins low. Compose pra-output AND-with-pins (which reflect
      // the joy pulls).
      return ((pra & ddr) | (joy & ~ddr)) & joy;
    },
    readPb: () => {
      if (!cia) return 0xff;
      const paOut = (cia.c_cia[0] /* CIA_PRA */ | ~cia.c_cia[2] /* CIA_DDRA */) & 0xff;
      const kbRows = keyboard.readRowsForPa(paOut);
      const joyMask = joystickActiveLowMask(joystick1);
      // PB is input from keyboard rows — DDR composition not needed
      // because KERNAL programs DDRB=0 (all input).
      return kbRows & joyMask;
    },
    pulsePc: () => { /* unused on CIA1 */ },
    setIntClk: (val) => { irqLevel = val; },
  };

  cia = new Cia6526Vice({
    backend,
    alarmContext: opts.alarmContext,
    clkPtr: opts.clkPtr,
    name: "CIA1",
  });
  cia.reset();

  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    const c = cia;
    bus.registerIoHandler(addr, {
      read: () => c.read(reg),
      write: (_a, value) => c.write(reg, value),
    });
  }
  return {
    cia,
    keyboard,
    joystick2,
    joystick1,
    irqLine: () => irqLevel !== 0,
  };
}
