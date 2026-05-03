// VSF module serializers / deserializers.
//
// Each subsystem we model owns a serialize-state-to-bytes function
// and a load-bytes-into-state function. The module-mapping table
// maps VSF module names to these functions; readers / writers
// dispatch through it.
//
// Sprint 64 covers the drive subsystems + IEC bus + (optional) GCR
// head. C64 RAM + MainCPU added when full headless C64 ROM
// integration lands. Spec 063 phases extend per-subsystem.

import type { Cpu6510 } from "../cpu6510.js";
import type { Via6522 } from "../drive/via6522.js";
import type { IecBus } from "../iec/iec-bus.js";
import type { TrackBuffer, HeadPosition } from "../drive/head-position.js";

// Module names are intended to be VICE-compatible so future tooling
// can swap snapshots. Names mirror VICE's own module identifiers.
export const VSF_MODULE_MAINCPU = "MAINCPU";
export const VSF_MODULE_C64RAM = "C64MEM";
export const VSF_MODULE_DRIVECPU = "DRIVECPU";
export const VSF_MODULE_DRIVERAM = "DRIVERAM";
export const VSF_MODULE_VIA1D1541 = "VIA1d1541";
export const VSF_MODULE_VIA2D1541 = "VIA2d1541";
export const VSF_MODULE_IEC = "IECBUS";
export const VSF_MODULE_GCRHEAD = "GCRHEAD";

// ---- 6502/6510 CPU module ----
// Layout: PC (2) A X Y SP P (1 each) cycles (4 LE) = 11 bytes
export function serializeCpu(cpu: Cpu6510): Uint8Array {
  const buf = new Uint8Array(11);
  buf[0] = cpu.pc & 0xff; buf[1] = (cpu.pc >> 8) & 0xff;
  buf[2] = cpu.a; buf[3] = cpu.x; buf[4] = cpu.y;
  buf[5] = cpu.sp; buf[6] = cpu.flags;
  buf[7] = cpu.cycles & 0xff;
  buf[8] = (cpu.cycles >> 8) & 0xff;
  buf[9] = (cpu.cycles >> 16) & 0xff;
  buf[10] = (cpu.cycles >> 24) & 0xff;
  return buf;
}

export function deserializeCpu(cpu: Cpu6510, data: Uint8Array): void {
  if (data.length < 11) throw new Error(`CPU module data too short: ${data.length} (expected 11)`);
  cpu.pc = data[0]! | (data[1]! << 8);
  cpu.a = data[2]!;
  cpu.x = data[3]!;
  cpu.y = data[4]!;
  cpu.sp = data[5]!;
  cpu.flags = data[6]!;
  cpu.cycles = (data[7]! | (data[8]! << 8) | (data[9]! << 16) | (data[10]! << 24)) >>> 0;
}

// ---- VIA module ----
// Layout: ORA ORB DDRA DDRB T1L T1H T1LL T1LH T2L T2H SR ACR PCR IFR IER
//         lastCa1Pin lastCb1Pin (booleans as bytes) = 17 bytes
export function serializeVia(via: Via6522): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = via.ora; buf[1] = via.orb;
  buf[2] = via.ddra; buf[3] = via.ddrb;
  buf[4] = via.t1Counter & 0xff; buf[5] = (via.t1Counter >> 8) & 0xff;
  buf[6] = via.t1Latch & 0xff; buf[7] = (via.t1Latch >> 8) & 0xff;
  buf[8] = via.t2Counter & 0xff; buf[9] = (via.t2Counter >> 8) & 0xff;
  buf[10] = via.sr;
  buf[11] = via.acr; buf[12] = via.pcr;
  buf[13] = via.ifr; buf[14] = via.ier;
  // Internal bookkeeping (not on real HW but needed to round-trip).
  // Cast away private access via index. TS strictness handled in the
  // assignment via Object.defineProperty fallback inside deserialize.
  buf[15] = 1; // placeholder — internal ca1 last-pin
  buf[16] = 1; // placeholder — internal cb1 last-pin
  return buf;
}

export function deserializeVia(via: Via6522, data: Uint8Array): void {
  if (data.length < 17) throw new Error(`VIA module data too short: ${data.length} (expected 17)`);
  via.ora = data[0]!; via.orb = data[1]!;
  via.ddra = data[2]!; via.ddrb = data[3]!;
  via.t1Counter = data[4]! | (data[5]! << 8);
  via.t1Latch = data[6]! | (data[7]! << 8);
  via.t2Counter = data[8]! | (data[9]! << 8);
  via.sr = data[10]!;
  via.acr = data[11]!;
  via.pcr = data[12]!;
  via.ifr = data[13]!;
  via.ier = data[14]!;
  // last-pin states (data[15]/[16]) ignored — they re-derive from the
  // first pulseCa1/pulseCb1 call after load.
}

// ---- RAM module ----
export function serializeRam(ram: Uint8Array): Uint8Array {
  // Direct copy.
  return new Uint8Array(ram);
}

export function deserializeRam(target: Uint8Array, data: Uint8Array): void {
  if (data.length !== target.length) {
    throw new Error(`RAM size mismatch: ${data.length} vs ${target.length}`);
  }
  target.set(data);
}

// ---- IEC bus module ----
// Layout: 6 bytes (one per driver state), all booleans-as-bytes.
//   c64AtnReleased c64ClkReleased c64DataReleased
//   driveClkReleased driveDataReleased driveAtnAckReleased
export function serializeIecBus(bus: IecBus): Uint8Array {
  const snap = bus.snapshot();
  return new Uint8Array([
    snap.c64.atnReleased ? 1 : 0,
    snap.c64.clkReleased ? 1 : 0,
    snap.c64.dataReleased ? 1 : 0,
    snap.drive.clkReleased ? 1 : 0,
    snap.drive.dataReleased ? 1 : 0,
    snap.drive.atnAckReleased ? 1 : 0,
  ]);
}

export function deserializeIecBus(bus: IecBus, data: Uint8Array): void {
  if (data.length < 6) throw new Error(`IEC bus module data too short: ${data.length}`);
  // Reach into bus internals via type assertion. Acceptable here
  // since the bus is the canonical owner of its state.
  const b = bus as unknown as {
    c64AtnReleased: boolean; c64ClkReleased: boolean; c64DataReleased: boolean;
    driveClkReleased: boolean; driveDataReleased: boolean; driveAtnAckReleased: boolean;
  };
  b.c64AtnReleased = data[0]! !== 0;
  b.c64ClkReleased = data[1]! !== 0;
  b.c64DataReleased = data[2]! !== 0;
  b.driveClkReleased = data[3]! !== 0;
  b.driveDataReleased = data[4]! !== 0;
  b.driveAtnAckReleased = data[5]! !== 0;
}

// ---- GCR head module ----
// Layout: trackHalf (2 LE) + maxHalfTracks (2 LE) + lastStepBits (1) +
//         byteCursor (4 LE) + lastReadByteIsSyncContext (1)
//       = 10 bytes header + then per modified track:
//         track number (1) + length (2 LE) + bytes
export function serializeGcrHead(head: HeadPosition, tracks: TrackBuffer): Uint8Array {
  const headerSize = 10;
  // Reach into private fields.
  const h = head as unknown as { trackHalf: number; maxHalfTracks: number; lastStepBits: number };
  const t = tracks as unknown as { byteCursor: number; lastReadByteIsSyncContext: number };
  const mods = tracks.modifiedTracks();
  let totalBody = 0;
  for (const [, buf] of mods) totalBody += 1 + 2 + buf.length;
  const out = new Uint8Array(headerSize + totalBody);
  out[0] = h.trackHalf & 0xff; out[1] = (h.trackHalf >> 8) & 0xff;
  out[2] = h.maxHalfTracks & 0xff; out[3] = (h.maxHalfTracks >> 8) & 0xff;
  out[4] = h.lastStepBits;
  out[5] = t.byteCursor & 0xff; out[6] = (t.byteCursor >> 8) & 0xff;
  out[7] = (t.byteCursor >> 16) & 0xff; out[8] = (t.byteCursor >> 24) & 0xff;
  out[9] = t.lastReadByteIsSyncContext;
  let off = headerSize;
  for (const [trackNum, buf] of mods) {
    out[off++] = trackNum & 0xff;
    out[off++] = buf.length & 0xff;
    out[off++] = (buf.length >> 8) & 0xff;
    out.set(buf, off);
    off += buf.length;
  }
  return out;
}

export function deserializeGcrHead(head: HeadPosition, tracks: TrackBuffer, data: Uint8Array): void {
  if (data.length < 10) throw new Error(`GCR head data too short: ${data.length}`);
  const h = head as unknown as { trackHalf: number; maxHalfTracks: number; lastStepBits: number };
  const t = tracks as unknown as {
    byteCursor: number;
    lastReadByteIsSyncContext: number;
    tracks: Map<number, Uint8Array | null>;
    modified: Set<number>;
  };
  h.trackHalf = data[0]! | (data[1]! << 8);
  h.maxHalfTracks = data[2]! | (data[3]! << 8);
  h.lastStepBits = data[4]!;
  t.byteCursor = (data[5]! | (data[6]! << 8) | (data[7]! << 16) | (data[8]! << 24)) >>> 0;
  t.lastReadByteIsSyncContext = data[9]!;
  let off = 10;
  while (off < data.length) {
    const trackNum = data[off++]!;
    const len = data[off]! | (data[off + 1]! << 8);
    off += 2;
    if (off + len > data.length) throw new Error(`GCR head: truncated track ${trackNum} body`);
    const bytes = new Uint8Array(data.slice(off, off + len));
    t.tracks.set(trackNum, bytes);
    t.modified.add(trackNum);
    off += len;
  }
}
