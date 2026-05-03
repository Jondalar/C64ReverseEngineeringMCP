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

export const CIA1_BASE = 0xdc00;

// Port-A keyboard column write does not affect anything we model.
// Port-B read returns row state ANDed across all selected columns.
// Without a real key matrix we report "all released" = $FF.
function makeKeyboardPa(): CiaPortBackend {
  return {
    readPins: () => 0xff,
    onOutputChanged: () => { /* keyboard column select; we ignore */ },
  };
}

function makeKeyboardPb(): CiaPortBackend {
  return {
    readPins: () => 0xff, // all keys released; joystick neutral
    onOutputChanged: () => { /* nothing */ },
  };
}

// Wire CIA1 register reads/writes to a memory bus IO handler chain so
// the C64 6510's $DC00..$DC0F access goes through the model.
export function installCia1(bus: HeadlessMemoryBus): Cia6526 {
  const cia = new Cia6526(makeKeyboardPa(), makeKeyboardPb());
  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA1_BASE + reg;
    bus.registerIoHandler(addr, {
      read: () => cia.read(reg),
      write: (_a, value) => cia.write(reg, value),
    });
  }
  return cia;
}
