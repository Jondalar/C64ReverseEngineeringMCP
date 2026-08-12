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

// Spec 723.4c: typed against the microcoded product CPU (legacy Cpu6510 deleted).
import type { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import type { IecBus } from "../iec/iec-bus.js";
import type { HeadlessMemoryBus } from "../memory-bus.js";
import type { Cia6526Vice } from "../cia/cia6526-vice.js";
import type { VicIIVice } from "../vic/vic-ii-vice.js";
import type { Sid6581 } from "../sid/sid.js";
import type { KeyboardMatrix } from "../peripherals/keyboard.js";

/**
 * Duck-typed VIA register surface required by serializeVia/deserializeVia.
 * Both `Via6522` (legacy) and `Via1d1541` / `Via2d1541` satisfy this.
 */
export interface ViaLike {
  ora: number; orb: number; ddra: number; ddrb: number;
  t1Counter: number; t1Latch: number; t2Counter: number;
  sr: number; acr: number; pcr: number; ifr: number; ier: number;
}
// Spec 704 §11 R3 — legacy drive head-position types removed; GCR-head
// (de)serializers below deleted (VSF now uses the opaque vice drive module).

// Module names are intended to be VICE-compatible so future tooling
// can swap snapshots. Names mirror VICE's own module identifiers.
export const VSF_MODULE_MAINCPU = "MAINCPU";
export const VSF_MODULE_C64MEM = "C64MEM";
export const VSF_MODULE_C64RAM = "C64MEM";   // legacy alias
export const VSF_MODULE_CIA1 = "CIA1";
export const VSF_MODULE_CIA2 = "CIA2";
export const VSF_MODULE_VICII = "VIC-II";
export const VSF_MODULE_SID = "SID";
export const VSF_MODULE_KEYBOARD = "KEYBOARD";
export const VSF_MODULE_JOYPORT = "JOYPORT";
export const VSF_MODULE_DRIVECPU = "DRIVECPU";
export const VSF_MODULE_DRIVERAM = "DRIVERAM";
export const VSF_MODULE_VIA1D1541 = "VIA1d1541";
export const VSF_MODULE_VIA2D1541 = "VIA2d1541";
export const VSF_MODULE_IEC = "IECBUS";
export const VSF_MODULE_GCRHEAD = "GCRHEAD";

// Spec 251 — c64-main module versions. Bumped when serialization layout
// changes. VICE 3.7+ only target per Spec 251 OQ1.
export const VSF_HL_MODULE_VERSION_MAJOR = 1;
export const VSF_HL_MODULE_VERSION_MINOR = 0;

// ---- 6502/6510 CPU module ----
// Layout: PC (2) A X Y SP P (1 each) cycles (4 LE) = 11 bytes
export function serializeCpu(cpu: Cpu65xxVice): Uint8Array {
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

export function deserializeCpu(cpu: Cpu65xxVice, data: Uint8Array): void {
  if (data.length < 11) throw new Error(`CPU module data too short: ${data.length} (expected 11)`);
  cpu.pc = data[0]! | (data[1]! << 8);
  cpu.a = data[2]!;
  cpu.x = data[3]!;
  cpu.y = data[4]!;
  cpu.sp = data[5]!;
  cpu.flags = data[6]!;
  cpu.cycles = (data[7]! | (data[8]! << 8) | (data[9]! << 16) | (data[10]! << 24)) >>> 0; // audit-ok: VSF restore
}

// ---- VIA module ----
// Layout: ORA ORB DDRA DDRB T1L T1H T1LL T1LH T2L T2H SR ACR PCR IFR IER
//         lastCa1Pin lastCb1Pin (booleans as bytes) = 17 bytes
export function serializeVia(via: ViaLike): Uint8Array {
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

export function deserializeVia(via: ViaLike, data: Uint8Array): void {
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

// Spec 704 §11 R3 — serializeGcrHead removed (legacy drive head/track).

// ---- C64MEM module (Spec 251) ----
// Layout:
//   ram                 65536 bytes
//   cpuPortDirection    1 byte
//   cpuPortValue        1 byte
//   dataSetBit6         1 byte
//   dataSetBit7         1 byte
//   dataSetClkBit6      4 bytes LE
//   dataSetClkBit7      4 bytes LE
//   dataFalloffBit6     1 byte
//   dataFalloffBit7     1 byte
//   = 65550 bytes total
export function serializeC64Mem(bus: HeadlessMemoryBus): Uint8Array {
  const internal = bus as unknown as {
    ram: Uint8Array;
    cpuPortDirection: number;
    cpuPortValue: number;
    dataSetBit6: number; dataSetBit7: number;
    dataSetClkBit6: number; dataSetClkBit7: number;
    dataFalloffBit6: number; dataFalloffBit7: number;
  };
  const out = new Uint8Array(65536 + 14);
  out.set(internal.ram, 0);
  let off = 65536;
  out[off++] = internal.cpuPortDirection & 0xff;
  out[off++] = internal.cpuPortValue & 0xff;
  out[off++] = internal.dataSetBit6 & 0xff;
  out[off++] = internal.dataSetBit7 & 0xff;
  out[off++] = internal.dataSetClkBit6 & 0xff;
  out[off++] = (internal.dataSetClkBit6 >> 8) & 0xff;
  out[off++] = (internal.dataSetClkBit6 >> 16) & 0xff;
  out[off++] = (internal.dataSetClkBit6 >> 24) & 0xff;
  out[off++] = internal.dataSetClkBit7 & 0xff;
  out[off++] = (internal.dataSetClkBit7 >> 8) & 0xff;
  out[off++] = (internal.dataSetClkBit7 >> 16) & 0xff;
  out[off++] = (internal.dataSetClkBit7 >> 24) & 0xff;
  out[off++] = internal.dataFalloffBit6 & 0xff;
  out[off++] = internal.dataFalloffBit7 & 0xff;
  return out;
}

export function deserializeC64Mem(bus: HeadlessMemoryBus, data: Uint8Array): void {
  if (data.length !== 65536 + 14) {
    throw new Error(`C64MEM module data wrong size: ${data.length} (expected ${65536 + 14})`);
  }
  const internal = bus as unknown as {
    ram: Uint8Array;
    cpuPortDirection: number;
    cpuPortValue: number;
    dataSetBit6: number; dataSetBit7: number;
    dataSetClkBit6: number; dataSetClkBit7: number;
    dataFalloffBit6: number; dataFalloffBit7: number;
  };
  internal.ram.set(data.slice(0, 65536));
  let off = 65536;
  internal.cpuPortDirection = data[off++]!;
  internal.cpuPortValue = data[off++]!;
  internal.dataSetBit6 = data[off++]!;
  internal.dataSetBit7 = data[off++]!;
  internal.dataSetClkBit6 = (data[off]! | (data[off+1]! << 8) | (data[off+2]! << 16) | (data[off+3]! << 24)) >>> 0;
  off += 4;
  internal.dataSetClkBit7 = (data[off]! | (data[off+1]! << 8) | (data[off+2]! << 16) | (data[off+3]! << 24)) >>> 0;
  off += 4;
  internal.dataFalloffBit6 = data[off++]!;
  internal.dataFalloffBit7 = data[off++]!;
}

// ---- CIA module (Spec 251) ----
// Both CIA1 + CIA2 share same layout. 16 register bytes + 32 bytes
// internal state = 48 bytes.
// Layout:
//   c_cia[0..15]              16 bytes
//   irqflags                  1 byte
//   ack_irqflags              1 byte
//   new_irqflags              1 byte
//   irq_enabled               1 byte
//   rdi                       4 bytes LE
//   ifr_clock                 4 bytes LE
//   ifr_delay                 1 byte
//   tat                       1 byte
//   tbt                       1 byte
//   old_pa                    1 byte
//   old_pb                    1 byte
//   read_clk                  4 bytes LE
//   read_offset               1 byte
//   last_read                 1 byte
//   write_offset              1 byte
//   model                     1 byte
//   ta_alarmclk               4 bytes LE
//   tb_alarmclk               4 bytes LE
//   = 48 bytes
export function serializeCia(cia: Cia6526Vice): Uint8Array {
  const internal = cia as unknown as {
    c_cia: Uint8Array;
    irqflags: number; ack_irqflags: number; new_irqflags: number; irq_enabled: number;
    rdi: number; ifr_clock: number; ifr_delay: number;
    tat: number; tbt: number; old_pa: number; old_pb: number;
    read_clk: number; read_offset: number; last_read: number; write_offset: number;
    model: number;
    ta_alarmclk: number; tb_alarmclk: number;
  };
  const out = new Uint8Array(48);
  out.set(internal.c_cia, 0);
  let off = 16;
  out[off++] = internal.irqflags & 0xff;
  out[off++] = internal.ack_irqflags & 0xff;
  out[off++] = internal.new_irqflags & 0xff;
  out[off++] = internal.irq_enabled & 0xff;
  writeU32LE(out, off, internal.rdi); off += 4;
  writeU32LE(out, off, internal.ifr_clock); off += 4;
  out[off++] = internal.ifr_delay & 0xff;
  out[off++] = internal.tat & 0xff;
  out[off++] = internal.tbt & 0xff;
  out[off++] = internal.old_pa & 0xff;
  out[off++] = internal.old_pb & 0xff;
  writeU32LE(out, off, internal.read_clk); off += 4;
  out[off++] = internal.read_offset & 0xff;
  out[off++] = internal.last_read & 0xff;
  out[off++] = internal.write_offset & 0xff;
  out[off++] = internal.model & 0xff;
  writeU32LE(out, off, internal.ta_alarmclk); off += 4;
  writeU32LE(out, off, internal.tb_alarmclk); off += 4;
  return out;
}

export function deserializeCia(cia: Cia6526Vice, data: Uint8Array): void {
  if (data.length !== 48) throw new Error(`CIA module data wrong size: ${data.length} (expected 48)`);
  const internal = cia as unknown as {
    c_cia: Uint8Array;
    irqflags: number; ack_irqflags: number; new_irqflags: number; irq_enabled: number;
    rdi: number; ifr_clock: number; ifr_delay: number;
    tat: number; tbt: number; old_pa: number; old_pb: number;
    read_clk: number; read_offset: number; last_read: number; write_offset: number;
    model: number;
    ta_alarmclk: number; tb_alarmclk: number;
  };
  internal.c_cia.set(data.slice(0, 16));
  let off = 16;
  internal.irqflags = data[off++]!;
  internal.ack_irqflags = data[off++]!;
  internal.new_irqflags = data[off++]!;
  internal.irq_enabled = data[off++]!;
  internal.rdi = readU32LE(data, off); off += 4;
  internal.ifr_clock = readU32LE(data, off); off += 4;
  internal.ifr_delay = data[off++]!;
  internal.tat = data[off++]!;
  internal.tbt = data[off++]!;
  internal.old_pa = data[off++]!;
  internal.old_pb = data[off++]!;
  internal.read_clk = readU32LE(data, off); off += 4;
  internal.read_offset = data[off++]!;
  internal.last_read = data[off++]!;
  internal.write_offset = data[off++]!;
  internal.model = data[off++]!;
  internal.ta_alarmclk = readU32LE(data, off); off += 4;
  internal.tb_alarmclk = readU32LE(data, off); off += 4;
}

// ---- VIC-II module (Spec 251) ----
// Layout:
//   regs[0..0x4F]            80 bytes
//   irq_status               1 byte
//   raster_irq_line          2 bytes LE
//   raster_irq_clk           4 bytes LE (CLOCK)
//   allow_bad_lines          1 byte
//   bad_line                 1 byte
//   raster_y                 2 bytes LE
//   raster_cycle             1 byte
//   sprite_fetch_msk         1 byte
//   last_read                1 byte
//   vbank_phi1               1 byte
//   vbank_phi2               1 byte
//   screen_ptr               4 bytes LE
//   chargen_ptr              4 bytes LE
//   bitmap_ptr               4 bytes LE
//   = 108 bytes
export function serializeVicII(vic: VicIIVice): Uint8Array {
  const out = new Uint8Array(108);
  out.set(vic.regs, 0);
  let off = 80;
  out[off++] = vic.irq_status & 0xff;
  out[off++] = vic.raster_irq_line & 0xff;
  out[off++] = (vic.raster_irq_line >> 8) & 0xff;
  writeU32LE(out, off, vic.raster_irq_clk); off += 4;
  out[off++] = vic.allow_bad_lines & 0xff;
  out[off++] = vic.bad_line & 0xff;
  out[off++] = vic.raster_y & 0xff;
  out[off++] = (vic.raster_y >> 8) & 0xff;
  out[off++] = vic.raster_cycle & 0xff;
  out[off++] = vic.sprite_fetch_msk & 0xff;
  out[off++] = vic.last_read & 0xff;
  out[off++] = vic.vbank_phi1 & 0xff;
  out[off++] = vic.vbank_phi2 & 0xff;
  writeU32LE(out, off, vic.screen_ptr); off += 4;
  writeU32LE(out, off, vic.chargen_ptr); off += 4;
  writeU32LE(out, off, vic.bitmap_ptr); off += 4;
  return out;
}

export function deserializeVicII(vic: VicIIVice, data: Uint8Array): void {
  if (data.length !== 108) throw new Error(`VIC-II data wrong size: ${data.length} (expected 108)`);
  vic.regs.set(data.slice(0, 80));
  let off = 80;
  vic.irq_status = data[off++]!;
  vic.raster_irq_line = data[off]! | (data[off+1]! << 8); off += 2;
  vic.raster_irq_clk = readU32LE(data, off); off += 4;
  vic.allow_bad_lines = data[off++]!;
  vic.bad_line = data[off++]!;
  vic.raster_y = data[off]! | (data[off+1]! << 8); off += 2;
  vic.raster_cycle = data[off++]!;
  vic.sprite_fetch_msk = data[off++]!;
  vic.last_read = data[off++]!;
  vic.vbank_phi1 = data[off++]!;
  vic.vbank_phi2 = data[off++]!;
  vic.screen_ptr = readU32LE(data, off); off += 4;
  vic.chargen_ptr = readU32LE(data, off); off += 4;
  vic.bitmap_ptr = readU32LE(data, off); off += 4;
}

// ---- SID module (Spec 251, fastsid only per OQ4) ----
// Layout: regs[0..0x1F] = 32 bytes
export function serializeSid(sid: Sid6581): Uint8Array {
  return new Uint8Array(sid.regs);
}

export function deserializeSid(sid: Sid6581, data: Uint8Array): void {
  if (data.length !== sid.regs.length) {
    throw new Error(`SID data wrong size: ${data.length} (expected ${sid.regs.length})`);
  }
  sid.regs.set(data);
}

// ---- KEYBOARD module (Spec 251) ----
// Layout:
//   cycleNow             4 bytes LE
//   eventCount           2 bytes LE
//   per event: keyName length 1 byte + ascii bytes + startCycle 4 LE + endCycle 4 LE
export function serializeKeyboard(kb: KeyboardMatrix): Uint8Array {
  const internal = kb as unknown as {
    events: Array<{ key: string; startCycle: number; endCycle: number }>;
    cycleNow: number;
  };
  const parts: number[] = [];
  // header
  writeU32LEArr(parts, internal.cycleNow);
  parts.push(internal.events.length & 0xff, (internal.events.length >> 8) & 0xff);
  for (const ev of internal.events) {
    const keyBytes = new TextEncoder().encode(ev.key);
    parts.push(keyBytes.length);
    for (const b of keyBytes) parts.push(b);
    writeU32LEArr(parts, ev.startCycle);
    writeU32LEArr(parts, ev.endCycle);
  }
  return new Uint8Array(parts);
}

export function deserializeKeyboard(kb: KeyboardMatrix, data: Uint8Array): void {
  const internal = kb as unknown as {
    events: Array<{ key: string; startCycle: number; endCycle: number }>;
    cycleNow: number;
  };
  let off = 0;
  internal.cycleNow = readU32LE(data, off); off += 4;
  const eventCount = data[off]! | (data[off+1]! << 8); off += 2;
  internal.events = [];
  for (let i = 0; i < eventCount; i++) {
    const keyLen = data[off++]!;
    const key = new TextDecoder().decode(data.slice(off, off + keyLen));
    off += keyLen;
    const startCycle = readU32LE(data, off); off += 4;
    const endCycle = readU32LE(data, off); off += 4;
    internal.events.push({ key: key as any, startCycle, endCycle });
  }
}

// ---- helpers ----
function writeU32LE(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off+1] = (v >> 8) & 0xff;
  out[off+2] = (v >> 16) & 0xff;
  out[off+3] = (v >> 24) & 0xff;
}

function writeU32LEArr(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}

function readU32LE(data: Uint8Array, off: number): number {
  return ((data[off]! | (data[off+1]! << 8) | (data[off+2]! << 16) | (data[off+3]! << 24)) >>> 0);
}

// Spec 704 §11 R3 — deserializeGcrHead removed (legacy drive head/track).
