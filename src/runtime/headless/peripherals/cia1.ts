// CIA1 ($DC00-$DC0F) — keyboard / joystick port + system 60Hz timer.
//
// Spec 064: full CIA model with timer A driving the standard jiffy
// IRQ. Replaces the pre-Sprint-69 `installCia1KeyboardStub`.
//
// Port A ($DC00) = keyboard column write + joystick port 2.
// Port B ($DC01) = keyboard row read + joystick port 1.
//
// Keyboard backend (Sprint 69a baseline): all keys released. Spec 063
// Phase C adds a scriptable input queue.

import { Cia6526, type CiaPortBackend } from "../cia/cia6526.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import { KeyboardMatrix, joystickActiveLowMask, type JoystickState } from "./keyboard.js";

export const CIA1_BASE = 0xdc00;

// Sprint 79: keyboard matrix backend reads PA latch (column drive)
// and returns active row bits (active-low) for currently-pressed
// keys.
function makeKeyboardPb(kb: KeyboardMatrix, getCia: () => Cia6526 | undefined): CiaPortBackend {
  return {
    readPins: () => {
      const cia = getCia();
      if (!cia) return 0xff;
      // CIA PA latch + DDR-aware: bits set in DDR are "driven by latch",
      // bits clear are "input floating high". For column-select we want
      // the actual driven values (treated as active-low).
      const paOut = cia.pra | ~cia.ddra;
      return kb.readRowsForPa(paOut & 0xff);
    },
    onOutputChanged: () => { /* nothing */ },
  };
}

// Sprint 93.1: PA backend now exposes joystick port 2 state (active-low
// bits 0-4). Real C64 wires joystick port 2 directly to CIA1 PA inputs;
// keyboard column drive is the CIA's PA latch (output) and is unaffected.
function makeKeyboardPa(joy2: JoystickState): CiaPortBackend {
  return {
    readPins: () => joystickActiveLowMask(joy2),
    onOutputChanged: () => { /* column select handled via CIA's PA latch read */ },
  };
}

export interface InstalledCia1 {
  cia: Cia6526;
  keyboard: KeyboardMatrix;
  joystick2: JoystickState;
}

export function installCia1(bus: HeadlessMemoryBus): InstalledCia1 {
  const keyboard = new KeyboardMatrix();
  const joystick2: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  let ciaRef: Cia6526 | undefined;
  const cia = new Cia6526(makeKeyboardPa(joystick2), makeKeyboardPb(keyboard, () => ciaRef));
  ciaRef = cia;
  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    bus.registerIoHandler(addr, {
      read: () => cia.read(reg),
      write: (_a, value) => cia.write(reg, value),
    });
  }
  return { cia, keyboard, joystick2 };
}
