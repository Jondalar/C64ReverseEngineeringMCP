// CIA2 stub for IEC bus coupling. Sprint 61 implements just $DD00 PA
// (IEC out + bank-select bits — bank ignored) and $DD02 DDR PA. The
// rest of CIA2 ($DD01 PB user-port, timers, TOD, ICR, etc.) is left
// for Spec 063 phase B.
//
// Uses HeadlessMemoryBus.registerIoHandler for $DD00 + $DD02 only. The
// other CIA2 registers fall through to the bus's plain io[] storage
// which is sufficient for now.

import type { HeadlessIoHandler, HeadlessMemoryBus } from "../memory-bus.js";
import type { IecBus } from "./iec-bus.js";

export const CIA2_PRA = 0xdd00;
export const CIA2_PRB = 0xdd01;
export const CIA2_DDRA = 0xdd02;
export const CIA2_DDRB = 0xdd03;

// Couples a HeadlessMemoryBus's $DD00/$DD02 to an IecBus instance.
// On C64 writes to $DD00 PRA / $DD02 DDRA, the bus state is updated.
// Reads return the latched output OR'd with bus input bits per DDR.
export function attachCia2ToIecBus(bus: HeadlessMemoryBus, iec: IecBus): void {
  let praLatch = 0xff;
  let ddraLatch = 0x3f; // standard CIA2 DDR after KERNAL init: bits 0-5 output, 6-7 input
  iec.setC64Output(praLatch, ddraLatch);

  const praHandler: HeadlessIoHandler = {
    read: () => {
      // For DDR-output bits: return latch. For DDR-input bits: return
      // current bus state via buildC64InputBits.
      const inputs = iec.buildC64InputBits();
      return ((praLatch & ddraLatch) | (inputs & ~ddraLatch)) & 0xff;
    },
    write: (_addr, value) => {
      praLatch = value & 0xff;
      iec.setC64Output(praLatch, ddraLatch);
    },
  };

  const ddraHandler: HeadlessIoHandler = {
    read: () => ddraLatch,
    write: (_addr, value) => {
      ddraLatch = value & 0xff;
      iec.setC64Output(praLatch, ddraLatch);
    },
  };

  bus.registerIoHandler(CIA2_PRA, praHandler);
  bus.registerIoHandler(CIA2_DDRA, ddraHandler);
}
