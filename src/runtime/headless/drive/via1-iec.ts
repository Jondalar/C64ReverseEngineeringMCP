// VIA1 IEC pin assignments (Sprint 60: pin layout only — bus wiring
// lives in Sprint 61's iec-bus.ts).
//
// 1541 VIA1 PB pin assignment (per service manual + datasheet):
//   PB0  DATA_IN     (from IEC bus, active low)
//   PB1  DATA_OUT    (to IEC bus, open-collector, active low)
//   PB2  CLK_IN      (from IEC bus, active low)
//   PB3  CLK_OUT     (to IEC bus, open-collector, active low)
//   PB4  ATN_ACK     (drive's ATN acknowledge — released after ATN seen)
//   PB5  DEV_ID 0    (jumper: device 8/9/10/11 — read as input)
//   PB6  DEV_ID 1    (jumper)
//   PB7  ATN_IN      (from IEC bus ATN line, active low)
//
// PA pins are mostly unused in the standard 1541 wiring (head-step
// might appear here on later boards; mostly used by the parallel
// cable mods like SpeedDOS/Dolphin).
//
// CA1 = ATN edge detector — wired to the ATN line so a falling edge
// (ATN going low) triggers an interrupt the drive ROM uses to enter
// the ATN service routine. Sprint 60 stores the bit but does NOT
// assert IRQ; Sprint 61 wires CA1 → IFR → IRQ.
//
// CA2/CB1/CB2 unused for standard IEC.

import type { ViaPortBackend } from "./via6522.js";

export const PB_DATA_IN = 1 << 0;
export const PB_DATA_OUT = 1 << 1;
export const PB_CLK_IN = 1 << 2;
export const PB_CLK_OUT = 1 << 3;
export const PB_ATN_ACK = 1 << 4;
export const PB_DEV_ID0 = 1 << 5;
export const PB_DEV_ID1 = 1 << 6;
export const PB_ATN_IN = 1 << 7;

// Default: all bus lines pulled high (= 1). DEV_ID jumper for device
// 8 is "00" (no jumpers cut) — both bits high.
export const DEFAULT_VIA1_PB_INPUT = 0xff;

// Sprint 60 stub: returns "all-high" pin state regardless of bus. The
// real backend reads from IECBus instance — wired up in Sprint 61.
export function makeStubVia1Pa(): ViaPortBackend {
  return {
    readPins: () => 0xff,
    onOutputChanged: () => { /* no-op */ },
  };
}

export function makeStubVia1Pb(deviceId: number = 8): ViaPortBackend {
  // Encode device id into PB5/PB6 (jumpers). Device 8 = both bits 1.
  // 8 → 11, 9 → 10, 10 → 01, 11 → 00.
  let jumperBits = 0;
  switch (deviceId) {
    case 8: jumperBits = PB_DEV_ID0 | PB_DEV_ID1; break;
    case 9: jumperBits = PB_DEV_ID1; break;
    case 10: jumperBits = PB_DEV_ID0; break;
    case 11: jumperBits = 0; break;
    default: throw new Error(`Unsupported drive device id ${deviceId}; expected 8-11`);
  }
  return {
    readPins: () => DEFAULT_VIA1_PB_INPUT & ~(PB_DEV_ID0 | PB_DEV_ID1) | jumperBits,
    onOutputChanged: () => { /* iec-bus wires this in Sprint 61 */ },
  };
}
