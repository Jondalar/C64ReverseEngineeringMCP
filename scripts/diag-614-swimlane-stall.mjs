#!/usr/bin/env node
// Swimlane step-trace from the LOAD"$",8 $ED58 stall.
//
// Lanes: C64 PC | $DD00 | cpu_bus | cpu_port | drv_data[8] | $1800 (drive VIA1 PB) | drive PC | via1 IFR
//
// Sample per c64 instruction. ~40 instructions of c64+drive lockstep.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 8 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const bus = session.c64Bus;
const iec = session.iecBus;
const vice = session.kernel.drive1541;
const drv = vice.unit;
const via1 = drv?.via1d1541;

function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }
function r8(a) { return bus.read(a & 0xffff) & 0xff; }
function drvr8(a) { try { return (drv.cpu?.mem?.read?.(a & 0xffff) ?? 0) & 0xff; } catch { return 0; } }

// Minimal opcode → mnemonic map.
const OP = {
  0xa9:"LDA#", 0xad:"LDA@", 0xa5:"LDAz", 0xb1:"LDA(z),y", 0xbd:"LDA@,x",
  0x85:"STAz", 0x8d:"STA@", 0x91:"STA(z),y", 0x9d:"STA@,x",
  0x29:"AND#", 0x09:"ORA#", 0x49:"EOR#",
  0xc9:"CMP#", 0xcd:"CMP@", 0xc5:"CMPz",
  0xf0:"BEQ", 0xd0:"BNE", 0x90:"BCC", 0xb0:"BCS", 0x10:"BPL", 0x30:"BMI",
  0x50:"BVC", 0x70:"BVS",
  0x4c:"JMP", 0x6c:"JMP()", 0x20:"JSR", 0x60:"RTS", 0x40:"RTI",
  0xea:"NOP", 0x78:"SEI", 0x58:"CLI", 0xa2:"LDX#", 0xa0:"LDY#",
  0xe8:"INX", 0xca:"DEX", 0xc8:"INY", 0x88:"DEY",
  0x18:"CLC", 0x38:"SEC",
  0x68:"PLA", 0x48:"PHA", 0x28:"PLP", 0x08:"PHP",
  0x24:"BITz", 0x2c:"BIT@",
};
function mnem(b) { return OP[b] ?? `?${hex(b)}`; }

// KERNAL ROM areas → label for context column.
function c64Lane(pc) {
  if (pc >= 0xed00 && pc <= 0xee00) return "KERNAL serial";
  if (pc >= 0xee00 && pc <= 0xeed0) return "KERNAL serial";
  if (pc >= 0xeed0 && pc <= 0xeefe) return "KERNAL ATN/BSOUT";
  if (pc >= 0xe453) return "KERNAL/BASIC";
  return "user";
}
function drvLane(pc) {
  if (pc >= 0xe853 && pc <= 0xe89c) return "ATN handler";
  if (pc >= 0xe9c0 && pc <= 0xe9d5) return "debpia";
  if (pc >= 0xe9d5 && pc <= 0xea60) return "byte-recv";
  if (pc >= 0xea60 && pc <= 0xeb00) return "byte-recv tail";
  if (pc >= 0xec00 && pc <= 0xec80) return "cmd parse";
  if (pc >= 0xeb00 && pc <= 0xec00) return "byte-send";
  return "DOS";
}

console.log("Initial state at stall (PC=$ED58):");
console.log(`  c64 PC=$${hex(session.c64Cpu.pc,4)} | drv PC=$${hex(drv.cpu.cpu_regs.pc,4)}`);
console.log(`  $DD00=$${hex(r8(0xdd00))} cpu_bus=$${hex(iec.core.cpu_bus)} cpu_port=$${hex(iec.core.cpu_port)} drv_data[8]=$${hex(iec.core.drv_data[8] ?? 0)}`);
console.log(`  via1 PRB=$${hex(via1.via[0])} IFR=$${hex(via1.ifr)} IER=$${hex(via1.ier)}`);
console.log("");
console.log("idx | c64 PC opc       lane            | $DD00 cpu_bus cpu_port drv_data[8] | drv PC   opc      lane            | $1800-PB IFR IER");
console.log("----+----------------------------------+------------------------------------+-----------------------------------+----------------");

let lastC64Pc = -1;
let lastDrvPc = -1;
for (let i = 0; i < 60; i++) {
  const c64Pc = session.c64Cpu.pc;
  const c64Op = r8(c64Pc);
  const drvPc = (drv.cpu?.cpu_regs?.pc ?? 0) & 0xffff;
  const drvOp = drvr8(drvPc);
  const dd00 = r8(0xdd00);
  const cpuBus = iec.core.cpu_bus & 0xff;
  const cpuPort = iec.core.cpu_port & 0xff;
  const drvData8 = (iec.core.drv_data[8] ?? 0) & 0xff;
  const via1pb = via1.via[0] & 0xff;
  const ifr = via1.ifr & 0xff;
  const ier = via1.ier & 0xff;

  const c64Tag = c64Pc === lastC64Pc ? "↺" : " ";
  const drvTag = drvPc === lastDrvPc ? "↺" : " ";

  console.log(
    `${String(i).padStart(3)} | $${hex(c64Pc,4)} ${hex(c64Op)} ${mnem(c64Op).padEnd(7)}${c64Tag} ${c64Lane(c64Pc).padEnd(15)} ` +
    `| $${hex(dd00)}    $${hex(cpuBus)}     $${hex(cpuPort)}     $${hex(drvData8)}        ` +
    `| $${hex(drvPc,4)} ${hex(drvOp)} ${mnem(drvOp).padEnd(7)}${drvTag} ${drvLane(drvPc).padEnd(15)} ` +
    `| $${hex(via1pb)}      $${hex(ifr)}  $${hex(ier)}`
  );

  lastC64Pc = c64Pc;
  lastDrvPc = drvPc;
  session.runFor(1, { cycleBudget: 200 });
}
