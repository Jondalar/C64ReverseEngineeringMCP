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
import { KeyboardMatrix } from "./keyboard.js";

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

function makeKeyboardPa(): CiaPortBackend {
  return {
    readPins: () => 0xff,
    onOutputChanged: () => { /* column select handled via CIA's PA latch read */ },
  };
}

export interface InstalledCia1 {
  cia: Cia6526;
  keyboard: KeyboardMatrix;
}

export function installCia1(bus: HeadlessMemoryBus): InstalledCia1 {
  const keyboard = new KeyboardMatrix();
  let ciaRef: Cia6526 | undefined;
  const cia = new Cia6526(makeKeyboardPa(), makeKeyboardPb(keyboard, () => ciaRef));
  ciaRef = cia;
  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    bus.registerIoHandler(addr, {
      read: () => cia.read(reg),
      write: (_a, value) => cia.write(reg, value),
    });
  }
  return { cia, keyboard };
}
