// Spec V-fix-corpus — VICE x64sc snapshot loader.
//
// Parses VICE .vsf binary (= machine state snapshot from VICE) and
// injects every field into our headless session + literal port state.
// After load, our session is at the EXACT moment VICE was paused —
// without running CPU. Allows deterministic pixel-diff against VICE
// reference screenshots.
//
// VICE module layout reverse-engineered from:
//   src/maincpu.c (= MAINCPU)
//   src/c64/c64memsnapshot.c (= C64MEM)
//   src/viciisc/vicii-snapshot.c (= VIC-IISC)
//   src/cia/ciacore.c (= CIA1/CIA2)
//
// File format:
//   header (58 bytes): "VICE Snapshot File\x1a" + version(2) + machine(16) +
//                      "VICE Version\x1a" + version(3) + 6 padding bytes
//   per module: name(16, NUL-pad) + maj(1) + min(1) + size(u32 LE, INCLUDES
//               header) + data

import { readFileSync } from "node:fs";
import type { IntegratedSession } from "../integrated-session.js";
import { vicii as litVicii } from "../vic/literal/vicii-types.js";
import { vicii_set_draw_cycle_state } from "../vic/literal/vicii-draw-cycle.js";

interface ModuleEntry {
  name: string;
  major: number;
  minor: number;
  dataStart: number;  // file offset of data (= after 22-byte header)
  dataLen: number;    // = sizeField - 22
}

function findModule(buf: Buffer, name: string): ModuleEntry | null {
  for (let i = 0x3a; i + 22 <= buf.length; i++) {
    let m = true;
    for (let k = 0; k < name.length; k++) {
      if (buf[i + k] !== name.charCodeAt(k)) { m = false; break; }
    }
    // Match exact (next byte must be NUL or end of name field)
    if (!m) continue;
    if (name.length < 16 && buf[i + name.length] !== 0) continue;
    const major = buf[i + 16]!;
    const minor = buf[i + 17]!;
    const size = buf.readUInt32LE(i + 18);
    return { name, major, minor, dataStart: i + 22, dataLen: size - 22 };
  }
  return null;
}

export interface VsfLoadResult {
  cpu: { clk: number; a: number; x: number; y: number; sp: number; pc: number; status: number };
  vicModelByte: number;
  cia1Found: boolean;
  cia2Found: boolean;
}

/**
 * Load a VICE x64sc .vsf file and inject every recoverable field into the
 * given headless session. Returns summary of injected state.
 */
export function loadViceVsf(session: IntegratedSession, path: string): VsfLoadResult {
  const buf = readFileSync(path);

  // === MAINCPU ===
  const cpuMod = findModule(buf, "MAINCPU");
  if (!cpuMod) throw new Error("VSF missing MAINCPU module");
  const cpu = cpuMod.dataStart;
  const cpuClk = Number(buf.readBigUInt64LE(cpu));
  const cpuA = buf[cpu + 8]!;
  const cpuX = buf[cpu + 9]!;
  const cpuY = buf[cpu + 10]!;
  const cpuSP = buf[cpu + 11]!;
  const cpuPC = buf.readUInt16LE(cpu + 12);
  const cpuStatus = buf[cpu + 14]!;
  // Inject
  session.c64Cpu.a = cpuA;
  session.c64Cpu.x = cpuX;
  session.c64Cpu.y = cpuY;
  session.c64Cpu.sp = cpuSP;
  session.c64Cpu.pc = cpuPC;
  session.c64Cpu.flags = cpuStatus;
  // Skip clk: our cpu cycles are session-local

  // === C64MEM ===
  const memMod = findModule(buf, "C64MEM");
  if (!memMod) throw new Error("VSF missing C64MEM module");
  const memData = memMod.dataStart;
  const pportData = buf[memData + 0]!;
  const pportDir = buf[memData + 1]!;
  const ramOff = memData + 4;
  // Inject 64K RAM
  for (let i = 0; i < 0x10000; i++) {
    session.c64Bus.write(i, buf[ramOff + i]!);
  }
  // CPU port at $00/$01 (= bank/charset config)
  session.c64Bus.write(0x00, pportDir);
  session.c64Bus.write(0x01, pportData);

  // === VIC-IISC ===
  // Some VICE versions use "VIC-II" name; viciisc uses "VIC-IISC".
  let vicMod = findModule(buf, "VIC-IISC");
  if (!vicMod) vicMod = findModule(buf, "VIC-II");
  if (!vicMod) throw new Error("VSF missing VIC-II[SC] module");
  const v = vicMod.dataStart;
  const vicModel = buf[v + 0]!;
  // regs[64] at v+1
  const vicRegs = buf.subarray(v + 1, v + 1 + 64);

  // === Inject literal port internal state ===
  const lit = litVicii;
  // Mirror regs into BOTH legacy VicIIVice + literal port.
  for (let i = 0; i < 64; i++) {
    session.vic.regs[i] = vicRegs[i]!;
    lit.regs[i] = vicRegs[i]!;
  }
  // Continue VIC-II module fields (offsets per spec):
  let p = v + 0x41;
  const readU32 = () => { const x = buf.readUInt32LE(p); p += 4; return x; };
  const readU8 = () => buf[p++]!;
  const readArr = (n: number) => { const a = buf.subarray(p, p + n); p += n; return a; };

  lit.raster_cycle = readU32();
  lit.cycle_flags = readU32();
  lit.raster_line = readU32();
  lit.start_of_frame = readU8();
  lit.irq_status = readU8();
  lit.raster_irq_line = readU32();
  lit.raster_irq_triggered = readU8();
  lit.vbuf.set(readArr(40));
  lit.cbuf.set(readArr(40));
  lit.gbuf = readU8();
  lit.dbuf_offset = readU32();
  lit.dbuf.set(readArr(520));
  lit.ysmooth = readU32();
  lit.allow_bad_lines = readU8();
  lit.sprite_sprite_collisions = readU8();
  lit.sprite_background_collisions = readU8();
  lit.clear_collisions = readU8();
  lit.idle_state = readU32();
  lit.vcbase = readU32();
  lit.vc = readU32();
  lit.rc = readU32();
  lit.vmli = readU32();
  lit.bad_line = readU32();
  // light_pen (24 bytes total: state + triggered + x + y + x_extra_bits + trigger_cycle)
  const lpState = readU8();
  const lpTriggered = readU8();
  const lpX = readU32();
  const lpY = readU32();
  const lpXExtra = readU32();
  const lpTriggerClk = Number(buf.readBigUInt64LE(p)); p += 8;
  if (lit.light_pen) {
    lit.light_pen.state = lpState;
    lit.light_pen.triggered = lpTriggered;
    lit.light_pen.x = lpX;
    lit.light_pen.y = lpY;
    lit.light_pen.x_extra_bits = lpXExtra;
    lit.light_pen.trigger_cycle = lpTriggerClk;
  }
  lit.reg11_delay = readU8();
  lit.prefetch_cycles = readU32();
  lit.sprite_display_bits = readU32();
  lit.sprite_dma = readU8();
  lit.last_color_reg = readU8();
  lit.last_color_value = readU8();
  lit.last_read_phi1 = readU8();
  lit.last_bus_phi2 = readU8();
  lit.vborder = readU8();
  lit.set_vborder = readU8();
  lit.main_border = readU8();
  lit.refresh_counter = readU8();
  // color_ram[1024]
  const colorRam = readArr(1024);
  for (let i = 0; i < 1024; i++) {
    // Color RAM lives at $D800-$DBFF in IO space; our bus stores low
    // nibble + open-bus on read. Write low nibble.
    session.c64Bus.write(0xd800 + i, colorRam[i]! & 0x0f);
  }
  // sprite[8] — 12 bytes each: data(4) + mc(1) + mcbase(1) + pointer(1) + exp_flop(1) + x(4)
  for (let s = 0; s < 8; s++) {
    const sp = lit.sprite[s];
    sp.data = readU32();
    sp.mc = readU8();
    sp.mcbase = readU8();
    sp.pointer = readU8();
    sp.exp_flop = readU8();
    sp.x = readU32();
  }
  // === draw_cycle_snapshot (174 bytes) — pipeline + render state ===
  const sprite_x_pipe = [];
  for (let i = 0; i < 8; i++) sprite_x_pipe.push(buf.readUInt32LE(p + 16 + i*4));
  const sbuf_reg = new Uint32Array(8);
  for (let i = 0; i < 8; i++) sbuf_reg[i] = buf.readUInt32LE(p + 0x36 + i*4);
  const dcs = {
    gbuf_pipe0_reg: buf[p+0]!, cbuf_pipe0_reg: buf[p+1]!, vbuf_pipe0_reg: buf[p+2]!,
    gbuf_pipe1_reg: buf[p+3]!, cbuf_pipe1_reg: buf[p+4]!, vbuf_pipe1_reg: buf[p+5]!,
    xscroll_pipe: buf[p+6]!,
    vmode11_pipe: buf[p+7]!, vmode16_pipe: buf[p+8]!, vmode16_pipe2: buf[p+9]!,
    gbuf_reg: buf[p+10]!, gbuf_mc_flop: buf[p+11]!, gbuf_pixel_reg: buf[p+12]!,
    cbuf_reg: buf[p+13]!, vbuf_reg: buf[p+14]!,
    dmli: buf[p+15]!,
    sprite_x_pipe,
    sprite_pri_bits: buf[p+0x30]!, sprite_mc_bits: buf[p+0x31]!, sprite_expx_bits: buf[p+0x32]!,
    sprite_pending_bits: buf[p+0x33]!, sprite_active_bits: buf[p+0x34]!, sprite_halt_bits: buf[p+0x35]!,
    sbuf_reg,
    sbuf_pixel_reg: new Uint8Array(buf.subarray(p+0x56, p+0x5e)),
    sbuf_expx_flops: buf[p+0x5e]!, sbuf_mc_flops: buf[p+0x5f]!,
    border_state: buf[p+0x60]!,
    render_buffer: new Uint8Array(buf.subarray(p+0x61, p+0x69)),
    pri_buffer: new Uint8Array(buf.subarray(p+0x69, p+0x71)),
    pixel_buffer: new Uint8Array(buf.subarray(p+0x71, p+0x79)),
    cregs: new Uint8Array(buf.subarray(p+0x79, p+0xa8)),
    last_color_reg: buf[p+0xa8]!, last_color_value: buf[p+0xa9]!,
    cycle_flags_pipe: buf.readUInt32LE(p+0xaa),
  };
  vicii_set_draw_cycle_state(dcs);
  p += 174;

  // === raster_snapshot — variable length, contains pixel buffers ===
  // current_line(4) + width(4) + height(4) + pitch(4) + pixels(variable)
  // Skip — our literal port has its own line-by-line accumulator.

  // === Continue MAINCPU interrupt state ===
  // After CPU module's last_opcode_info (4) + ane_log_level (4) +
  // lxa_log_level (4): irq state 40 bytes + new irq state 12 bytes.
  // We have CPU clk + regs already. Skip nested state for now (=
  // not directly settable on our cpu6510 without API additions).

  // === CIA1 / CIA2 ===
  const cia1Mod = findModule(buf, "CIA1");
  const cia2Mod = findModule(buf, "CIA2");
  if (cia1Mod) {
    session.cia1.pra = buf[cia1Mod.dataStart + 0]!;
    session.cia1.prb = buf[cia1Mod.dataStart + 1]!;
    session.cia1.ddra = buf[cia1Mod.dataStart + 2]!;
    session.cia1.ddrb = buf[cia1Mod.dataStart + 3]!;
  }
  if (cia2Mod) {
    session.cia2.pra = buf[cia2Mod.dataStart + 0]!;
    session.cia2.prb = buf[cia2Mod.dataStart + 1]!;
    session.cia2.ddra = buf[cia2Mod.dataStart + 2]!;
    session.cia2.ddrb = buf[cia2Mod.dataStart + 3]!;
    // Update literal port vbank from CIA2 PA bits (= immediate effect)
    const pa = buf[cia2Mod.dataStart + 0]! & buf[cia2Mod.dataStart + 2]!;
    const bank = (~pa) & 3;
    lit.vbank_phi1 = bank * 0x4000;
    lit.vbank_phi2 = bank * 0x4000;
  }

  return {
    cpu: { clk: cpuClk, a: cpuA, x: cpuX, y: cpuY, sp: cpuSP, pc: cpuPC, status: cpuStatus },
    vicModelByte: vicModel,
    cia1Found: !!cia1Mod,
    cia2Found: !!cia2Mod,
  };
}
