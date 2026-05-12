#!/usr/bin/env node
// Sprint 93.1 — find first PC divergence between legacy Cpu6510 and
// microcoded Cpu6510Cycled during KERNAL cold reset.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { console.error(`Disk not found`); process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

function start(microcoded) {
  const { session } = startIntegratedSession({
    diskPath: disk,
    useCycleLockstep: microcoded,
    useMicrocodedCpu: microcoded,
  });
  session.resetCold();
  return session;
}

const legacy = start(false);
const micro = start(true);

const N = 50000;
const log = [];
for (let i = 0; i < N; i++) {
  const lpc = legacy.c64Cpu.pc;
  const mpc = micro.c64Cpu.pc;
  log.push({ i, lpc, mpc, lcyc: legacy.c64Cpu.cycles, mcyc: micro.c64Cpu.cycles });
  if (lpc !== mpc) {
    console.log(`Divergence at instr ${i}: legacy PC=$${lpc.toString(16)} cyc=${legacy.c64Cpu.cycles} | micro PC=$${mpc.toString(16)} cyc=${micro.c64Cpu.cycles}`);
    console.log(`Last 8 instructions before divergence:`);
    for (const r of log.slice(Math.max(0, i - 8))) {
      console.log(`  ${r.i}: legacy $${r.lpc.toString(16).padStart(4,"0")}/${r.lcyc} | micro $${r.mpc.toString(16).padStart(4,"0")}/${r.mcyc}`);
    }
    process.exit(0);
  }
  legacy.runFor(1);
  micro.runFor(1);
}
console.log(`No divergence in first ${N} instructions. Both at PC=$${legacy.c64Cpu.pc.toString(16)}.`);
