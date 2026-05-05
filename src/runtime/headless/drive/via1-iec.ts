// VIA1 IEC pin assignments + bus-coupled backends.
//
// Sprint 60: pin layout + stub backends.
// Sprint 61: real backends that read/write the IEC bus state.
//
// 1541 VIA1 PB pin assignment (per service manual + datasheet):
//   PB0  DATA_IN     (from IEC bus, active low)
//   PB1  DATA_OUT    (to IEC bus, open-collector, active low)
//   PB2  CLK_IN      (from IEC bus, active low)
//   PB3  CLK_OUT     (to IEC bus, open-collector, active low)
//   PB4  ATN_ACK     (drive ATN acknowledge — when low + ATN-low, the
//                     1541's hardware gate pulls DATA low)
//   PB5  DEV_ID 0    (jumper)
//   PB6  DEV_ID 1    (jumper)
//   PB7  ATN_IN      (from IEC bus ATN line, active low)
//
// CA1 = ATN edge detector — wired to ATN line so a level change pulses
// the VIA's CA1 input. Sprint 61 wires this through pulseCa1 in the
// VIA so the drive ROM's ATN-edge IRQ handler fires correctly.

import type { ViaPortBackend } from "./via6522.js";
import type { IecBus } from "../iec/iec-bus.js";

export const PB_DATA_IN = 1 << 0;
export const PB_DATA_OUT = 1 << 1;
export const PB_CLK_IN = 1 << 2;
export const PB_CLK_OUT = 1 << 3;
export const PB_ATN_ACK = 1 << 4;
export const PB_DEV_ID0 = 1 << 5;
export const PB_DEV_ID1 = 1 << 6;
export const PB_ATN_IN = 1 << 7;

export const DEFAULT_VIA1_PB_INPUT = 0xff;

// Standalone stubs — kept for Sprint 60 isolated tests where there's
// no bus.
export function makeStubVia1Pa(): ViaPortBackend {
  return {
    readPins: () => 0xff,
    onOutputChanged: () => { /* no-op */ },
  };
}

export function makeStubVia1Pb(deviceId: number = 8): ViaPortBackend {
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
    onOutputChanged: () => { /* no bus wired */ },
  };
}

// IEC bus VIA1 backends already destructure (orValue, ddrMask) and
// don't care about cause — the iec-bus state always reflects current
// or+ddr regardless of which one changed.

// Sprint 61: bus-coupled backends.
export function makeBusVia1Pa(): ViaPortBackend {
  return {
    readPins: () => 0xff, // PA unused on standard 1541 IEC wiring
    onOutputChanged: () => { /* no-op */ },
  };
}

export function makeBusVia1Pb(bus: IecBus, deviceId: number = 8): ViaPortBackend {
  return {
    // readPins kept as a fallback for non-ORB reads / DDR queries.
    // Production drive ORB read goes via readPbFull below.
    readPins: () => bus.buildDrivePbInputBits(deviceId),
    onOutputChanged: (orValue, ddrMask) => bus.setDriveOutput(orValue, ddrMask),
    // Spec 140 v3: 1:1 VICE via1d1541.c read_prb formula.
    //   byte = ((PRB & 0x1A) | drv_port) ^ 0x85 | (number << 5)
    // Always active; no mode flag.
    readPbFull: (orb, _ddrb) => {
      // Diagnostic: compare against legacy live formula to surface
      // any latent gap. Off in production via diagnoseReadDivergence
      // staying undefined.
      if (bus.diagnoseReadDivergence) {
        const pins = bus.buildDrivePbInputBits(deviceId);
        const liveByte = ((orb & _ddrb) | (pins & ~_ddrb)) & 0xff;
        const viceByte = bus.core.drive_read_pb(orb, deviceId);
        if (liveByte !== viceByte) {
          bus.diagnoseReadDivergence({
            driveCycle: 0, drivePc: 0,
            prb: orb, ddrb: _ddrb, deviceId,
            liveByte, viceByte,
            drv_port: bus.core.drv_port,
            cpu_bus: bus.core.cpu_bus,
          });
        }
      }
      return bus.core.drive_read_pb(orb, deviceId);
    },
  };
}
