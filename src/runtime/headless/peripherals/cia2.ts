// CIA2 ($DD00-$DD0F) — IEC bus + RS232 + VIC bank select + NMI source.
//
// Spec 064: full CIA model. Replaces the pre-Sprint-69 attachCia2ToIecBus
// PA-only stub. Now Port A goes through the real CIA's PRA latch +
// DDR-aware read; the IEC backend forwards bus-state changes.
// Port B (user port + RS232) is stubbed.

import { Cia6526, type CiaPortBackend } from "../cia/cia6526.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { IecBus } from "../iec/iec-bus.js";

export const CIA2_BASE = 0xdd00;

function makeIecPa(iec: IecBus): CiaPortBackend {
  return {
    readPins: () => iec.buildC64InputBits(),
    onOutputChanged: (orValue, ddrMask, _cause) => iec.setC64Output(orValue, ddrMask),
  };
}

function makeUserPortPb(): CiaPortBackend {
  return {
    readPins: () => 0xff,
    onOutputChanged: () => { /* user port not modeled */ },
  };
}

export function installCia2(bus: HeadlessMemoryBus, iec: IecBus): Cia6526 {
  const cia = new Cia6526(makeIecPa(iec), makeUserPortPb());
  for (let reg = 0; reg < 16; reg++) {
    const addr = CIA2_BASE + reg;
    bus.registerIoHandler(addr, {
      read: () => cia.read(reg),
      write: (_a, value) => cia.write(reg, value),
    });
  }
  // Initial PA state: output bits all-high so IEC bus starts released.
  // KERNAL IOINIT will program proper DDR/PRA later.
  iec.setC64Output(0xff, 0x3f);
  return cia;
}
