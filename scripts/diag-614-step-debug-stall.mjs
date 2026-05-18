#!/usr/bin/env node
// Step-debug at $ED58 stall. Capture: c64 disasm, $DD00, drive PC,
// drive disasm, $1800, plus 8-step c64 + 8-step drive trace.

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

// Boot to READY.
session.runFor(2_000_000);

// Type LOAD"$",8 + LIST.
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 8 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

// Now sample state at the stall.
const c64Bus = session.c64Bus;
const iec = session.iecBus;
const vice = session.kernel.drive1541;
const diskunit = vice.diskunit;
const via1 = diskunit?.via1d1541;
const via2 = diskunit?.via2d1541;
const drv = vice.unit;

function hex(n, w = 2) { return n.toString(16).padStart(w, "0"); }
function r8(addr) { return c64Bus.read(addr & 0xffff) & 0xff; }

// Drive RAM read — diskunit memory map. Drive RAM is internal to vice1541.
function drvMem(addr) {
  // Drive RAM is in diskunit.drive[0].mem or accessed via drivemem.
  // Easiest: use the drive_6510core read path.
  try {
    return (vice.unit.cpu?.mem?.read?.(addr & 0xffff) ?? 0) & 0xff;
  } catch { return -1; }
}

// 6502 disassembler — minimal 1-instruction format.
const OP = {
  0xA5: ["LDA", "zp"], 0xA9: ["LDA", "imm"], 0xAD: ["LDA", "abs"], 0xB1: ["LDA", "(zp),y"], 0xBD: ["LDA", "abs,x"],
  0x85: ["STA", "zp"], 0x8D: ["STA", "abs"], 0x91: ["STA", "(zp),y"], 0x9D: ["STA", "abs,x"],
  0x29: ["AND", "imm"], 0x2D: ["AND", "abs"], 0x25: ["AND", "zp"],
  0x09: ["ORA", "imm"], 0x0D: ["ORA", "abs"], 0x05: ["ORA", "zp"],
  0x49: ["EOR", "imm"],
  0xC9: ["CMP", "imm"], 0xCD: ["CMP", "abs"], 0xC5: ["CMP", "zp"],
  0xF0: ["BEQ", "rel"], 0xD0: ["BNE", "rel"], 0x90: ["BCC", "rel"], 0xB0: ["BCS", "rel"],
  0x10: ["BPL", "rel"], 0x30: ["BMI", "rel"], 0x50: ["BVC", "rel"], 0x70: ["BVS", "rel"],
  0x4C: ["JMP", "abs"], 0x6C: ["JMP", "(abs)"],
  0x20: ["JSR", "abs"], 0x60: ["RTS", "impl"], 0x40: ["RTI", "impl"],
  0xEA: ["NOP", "impl"], 0x78: ["SEI", "impl"], 0x58: ["CLI", "impl"],
  0xA2: ["LDX", "imm"], 0xA0: ["LDY", "imm"],
  0xE8: ["INX", "impl"], 0xCA: ["DEX", "impl"], 0xC8: ["INY", "impl"], 0x88: ["DEY", "impl"],
  0x18: ["CLC", "impl"], 0x38: ["SEC", "impl"], 0xB8: ["CLV", "impl"],
  0x68: ["PLA", "impl"], 0x48: ["PHA", "impl"], 0x28: ["PLP", "impl"], 0x08: ["PHP", "impl"],
  0x24: ["BIT", "zp"], 0x2C: ["BIT", "abs"],
};
function modeLen(m) { return m === "impl" ? 1 : (["abs", "(abs)", "abs,x", "abs,y"].includes(m) ? 3 : 2); }
function disasm(read, pc, count = 4) {
  let out = [];
  let cur = pc & 0xffff;
  for (let i = 0; i < count; i++) {
    const op = read(cur);
    const entry = OP[op] ?? ["???", "impl"];
    const len = modeLen(entry[1]);
    const b1 = read((cur + 1) & 0xffff);
    const b2 = read((cur + 2) & 0xffff);
    let asm;
    if (entry[1] === "impl") asm = entry[0];
    else if (entry[1] === "imm") asm = `${entry[0]} #$${hex(b1)}`;
    else if (entry[1] === "zp") asm = `${entry[0]} $${hex(b1)}`;
    else if (entry[1] === "abs") asm = `${entry[0]} $${hex(b2)}${hex(b1)}`;
    else if (entry[1] === "(abs)") asm = `${entry[0]} ($${hex(b2)}${hex(b1)})`;
    else if (entry[1] === "rel") {
      const tgt = ((cur + 2) + (b1 < 0x80 ? b1 : b1 - 0x100)) & 0xffff;
      asm = `${entry[0]} $${hex(tgt, 4)}`;
    } else if (entry[1] === "(zp),y") asm = `${entry[0]} ($${hex(b1)}),y`;
    else if (entry[1] === "abs,x") asm = `${entry[0]} $${hex(b2)}${hex(b1)},x`;
    else asm = `${entry[0]} ???`;
    out.push(`  $${hex(cur, 4)}: ${hex(op)} ${len>=2?hex(b1):"  "} ${len>=3?hex(b2):"  "}  ${asm}`);
    cur = (cur + len) & 0xffff;
  }
  return out.join("\n");
}

console.log(`=== C64 SIDE ===`);
console.log(`c64 PC = $${hex(session.c64Cpu.pc, 4)}`);
console.log(`c64 A=$${hex(session.c64Cpu.a)} X=$${hex(session.c64Cpu.x)} Y=$${hex(session.c64Cpu.y)} P=$${hex(session.c64Cpu.flags)}`);
console.log(`\nc64 disasm @ PC:`);
console.log(disasm((a) => c64Bus.read(a & 0xffff), session.c64Cpu.pc, 8));
console.log(`\n$DD00 (CIA2 PA) raw read = $${hex(c64Bus.read(0xdd00))}`);
console.log(`$DD02 (CIA2 PA DDR)      = $${hex(c64Bus.read(0xdd02))}`);
console.log(`iec.core.cpu_bus  = $${hex(iec.core.cpu_bus)}`);
console.log(`iec.core.cpu_port = $${hex(iec.core.cpu_port)}`);
console.log(`iec.core.drv_port = $${hex(iec.core.drv_port)}`);
console.log(`iec.core.drv_data[8] = $${hex(iec.core.drv_data[8] ?? 0)}`);

console.log(`\n=== DRIVE SIDE ===`);
const drvPc = (drv?.cpu?.cpu_regs?.pc ?? 0) & 0xffff;
console.log(`drive PC = $${hex(drvPc, 4)}`);
console.log(`drive A=$${hex(drv?.cpu?.cpu_regs?.a ?? 0)} X=$${hex(drv?.cpu?.cpu_regs?.x ?? 0)} Y=$${hex(drv?.cpu?.cpu_regs?.y ?? 0)} P=$${hex(drv?.cpu?.cpu_regs?.p ?? 0)}`);
console.log(`drive clk = ${drv?.clk_ptr?.value ?? "?"}`);

// Drive disasm requires drive memory bus.
const driveMemBus = drv?.cpud?.read;
if (driveMemBus) {
  console.log(`\ndrive disasm @ PC:`);
  console.log(disasm((a) => (driveMemBus(a & 0xffff) ?? 0) & 0xff, drvPc, 8));
}
console.log(`\nvia1 (IEC) IFR=$${hex(via1?.ifr ?? 0)} IER=$${hex(via1?.ier ?? 0)}`);
console.log(`via1 PRA=$${hex(via1?.via?.[1] ?? 0)} PRB=$${hex(via1?.via?.[0] ?? 0)} DDRA=$${hex(via1?.via?.[3] ?? 0)} DDRB=$${hex(via1?.via?.[2] ?? 0)}`);
console.log(`via2 (disk) IFR=$${hex(via2?.ifr ?? 0)} IER=$${hex(via2?.ier ?? 0)}`);
console.log(`via2 PRA=$${hex(via2?.via?.[1] ?? 0)} PRB=$${hex(via2?.via?.[0] ?? 0)}`);

// Step-into 12 c64 instructions, log PC.
console.log(`\n=== c64 step-into × 12 ===`);
for (let i = 0; i < 12; i++) {
  const pcBefore = session.c64Cpu.pc;
  const opByte = c64Bus.read(pcBefore & 0xffff);
  const entry = OP[opByte] ?? ["???", "impl"];
  // Run one c64 instruction via scheduler.
  session.runFor(1, { cycleBudget: 200 });
  const pcAfter = session.c64Cpu.pc;
  console.log(`  ${i}: $${hex(pcBefore,4)} (${entry[0]}) → $${hex(pcAfter,4)}  A=$${hex(session.c64Cpu.a)} P=$${hex(session.c64Cpu.flags)}  $DD00=$${hex(c64Bus.read(0xdd00))}`);
}
