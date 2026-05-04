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
// keys. Spec 107 (M2.5) — joystick port 1 wired to PB inputs ANDed
// with keyboard rows so a joy1 down-bit pulls the corresponding PB
// pin low even when no key is pressed.
function makeKeyboardPb(kb: KeyboardMatrix, joy1: JoystickState, getCia: () => Cia6526 | undefined): CiaPortBackend {
  return {
    readPins: () => {
      const cia = getCia();
      const paOut = cia ? (cia.pra | ~cia.ddra) & 0xff : 0xff;
      const kbRows = cia ? kb.readRowsForPa(paOut) : 0xff;
      const joyMask = joystickActiveLowMask(joy1);
      // Both keyboard rows + joystick contribute pulls (active-low AND).
      return kbRows & joyMask;
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
  joystick1: JoystickState;  // Spec 107 v1
}

export function installCia1(bus: HeadlessMemoryBus): InstalledCia1 {
  const keyboard = new KeyboardMatrix();
  const joystick2: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  const joystick1: JoystickState = { up: false, down: false, left: false, right: false, fire: false };
  let ciaRef: Cia6526 | undefined;
  const cia = new Cia6526(makeKeyboardPa(joystick2), makeKeyboardPb(keyboard, joystick1, () => ciaRef));
  ciaRef = cia;
  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    bus.registerIoHandler(addr, {
      read: () => cia.read(reg),
      write: (_a, value) => cia.write(reg, value),
    });
  }
  return { cia, keyboard, joystick2, joystick1 };
}
