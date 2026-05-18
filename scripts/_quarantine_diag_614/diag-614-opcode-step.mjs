#!/usr/bin/env node
// Step opcode-by-opcode (c64 + drive in lockstep via scheduler).
// Show: c64 PC + opcode, drive PC + opcode, $DD00, $1800 reads, T1 state.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 6 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const bus = session.c64Bus;
const iec = session.iecBus;
const vice = session.kernel.drive1541;
const drv = vice.unit;
const cpud = drv.cpud;
const via1 = drv.via1d1541;

function hex(n, w=2) { return (n & ((1 << (w*4)) - 1)).toString(16).padStart(w, "0"); }
function r8(a) { return bus.read(a & 0xffff) & 0xff; }
function drvR(a) {
  const fn = cpud?.read_func_ptr?.[(a >> 8) & 0xff];
  return fn ? fn(drv, a) & 0xff : 0;
}

// T1 counter state from viacore.
function t1State() {
  if (!via1) return "?";
  const ctx = via1;
  // VIA T1 counter is computed dynamically per viacore_read of T1L_LO ($04) / T1C_LO ($04)
  // From viacore.ts viacore state: ctx.t1_zero_cycle, etc.
  return `t1zero=${ctx.t1_zero_cycle ?? "?"} t1pb7=${ctx.t1_pb7 ?? "?"} t1mode=${ctx.t1_mode ?? "?"} ifr=${hex(ctx.ifr ?? 0)}`;
}

console.log(`Step from c64 PC=$${hex(session.c64Cpu.pc,4)} drv PC=$${hex(drv.cpu.cpu_regs.pc,4)}`);
console.log(`c64.cycles=${session.c64Cpu.cycles}  drv.clk=${drv.clk_ptr.value}`);
console.log("");
console.log("# | c64_pc op  mnem      | drv_pc op  mnem      | $DD00 dPB | T1 IFR | via1.ier T1");

const OP = {
  0xa9:"LDA#", 0xa5:"LDAz", 0xad:"LDA@", 0xb1:"LDA(z)y",
  0x85:"STAz", 0x8d:"STA@", 0x91:"STA(z)y",
  0x29:"AND#", 0x09:"ORA#", 0x49:"EOR#",
  0xc9:"CMP#", 0xcd:"CMP@", 0xc5:"CMPz",
  0xf0:"BEQ", 0xd0:"BNE", 0x90:"BCC", 0xb0:"BCS",
  0x10:"BPL", 0x30:"BMI", 0x50:"BVC", 0x70:"BVS",
  0x4c:"JMP", 0x20:"JSR", 0x60:"RTS", 0x40:"RTI",
  0xea:"NOP", 0x78:"SEI", 0x58:"CLI",
  0xa2:"LDX#", 0xa0:"LDY#",
  0xe8:"INX", 0xca:"DEX", 0xc8:"INY", 0x88:"DEY",
  0x18:"CLC", 0x38:"SEC",
  0x68:"PLA", 0x48:"PHA", 0x28:"PLP", 0x08:"PHP",
  0x24:"BITz", 0x2c:"BIT@",
  0x0a:"ASLa", 0x4a:"LSRa",
  0xaa:"TAX", 0x8a:"TXA", 0xa8:"TAY", 0x98:"TYA",
  0x9a:"TXS", 0xba:"TSX",
};

let lastDrvPc = -1;
for (let i = 0; i < 50; i++) {
  const cpc = session.c64Cpu.pc;
  const cop = r8(cpc);
  const dpc = (drv.cpu?.cpu_regs?.pc ?? 0) & 0xffff;
  const dop = drvR(dpc);
  const dd00 = r8(0xdd00);
  const dpb = via1?.via?.[0] ?? 0;
  const ifr = via1?.ifr ?? 0;
  const ier = via1?.ier ?? 0;
  const tag = dpc !== lastDrvPc ? "*" : " ";
  console.log(
    `${String(i).padStart(2)} | $${hex(cpc,4)} ${hex(cop)} ${(OP[cop]??"???").padEnd(8)} | ` +
    `$${hex(dpc,4)}${tag}${hex(dop)} ${(OP[dop]??"???").padEnd(8)} | ` +
    `$${hex(dd00)}  $${hex(dpb)}    | $${hex(ifr)}    | $${hex(ier)}`
  );
  lastDrvPc = dpc;
  session.runFor(1, { cycleBudget: 200 });
}

console.log("");
console.log("Drive PC histogram in window:");
// Track which drive PCs hit during 50 c64 instr.
const histPc = new Map();
for (let j = 0; j < 200; j++) {
  const dpc = drv.cpu.cpu_regs.pc & 0xffff;
  histPc.set(dpc, (histPc.get(dpc) ?? 0) + 1);
  session.runFor(1, { cycleBudget: 200 });
}
for (const [pc, n] of [...histPc.entries()].sort((a,b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  $${hex(pc,4)} : ${n}`);
}
