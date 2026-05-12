#!/usr/bin/env node
import { Cpu6510 } from "../dist/runtime/headless/cpu6510.js";
import { Cpu65xxVice } from "../dist/runtime/headless/cpu/cpu65xx-vice.js";
import { DriveBus } from "../dist/runtime/headless/drive/drive-cpu.js";

// Sprint 113 Phase 2: Cpu65xxVice replaces removed Cpu6510Cycled.
const busL = new DriveBus({});
const busM = new DriveBus({});
const cpuL = new Cpu6510(busL);
const cpuM = new Cpu65xxVice({ memBus: busM });
cpuL.reset();
cpuM.reset();

// Walk until we hit an INY ($c8), then compare cycle delta.
const max = 200_000;
let firstDelta = null;
const cycleByOpcode = new Map();
for (let i = 0; i < max; i++) {
  const pc = cpuL.pc;
  const opcode = busL.read(pc);
  const cycLb = cpuL.cycles;
  const cycMb = cpuM.cycles;

  // Legacy
  cpuL.step();
  busL.via1.tick(cpuL.cycles - cycLb);
  busL.via2.tick(cpuL.cycles - cycLb);

  // Micro
  cpuM.executeCycle();
  while (!cpuM.isAtInstructionBoundary()) cpuM.executeCycle();
  busM.via1.tick(cpuM.cycles - cycMb);
  busM.via2.tick(cpuM.cycles - cycMb);

  const dL = cpuL.cycles - cycLb;
  const dM = cpuM.cycles - cycMb;
  if (dL !== dM) {
    const e = cycleByOpcode.get(opcode) ?? { cnt: 0, sumL: 0, sumM: 0, sample: null };
    e.cnt++;
    e.sumL += dL;
    e.sumM += dM;
    if (!e.sample) e.sample = { i, pc, dL, dM };
    cycleByOpcode.set(opcode, e);
    if (!firstDelta) firstDelta = { i, pc, opcode, dL, dM };
  }
  if (cpuL.pc !== cpuM.pc) {
    console.log(`PC diverged at step ${i}: legacy=$${cpuL.pc.toString(16)} micro=$${cpuM.pc.toString(16)}`);
    break;
  }
}

console.log(`first delta:`, firstDelta);
console.log(`per-opcode:`);
for (const [op, e] of [...cycleByOpcode.entries()].sort((a, b) => b[1].cnt - a[1].cnt).slice(0, 12)) {
  const avgL = (e.sumL / e.cnt).toFixed(2);
  const avgM = (e.sumM / e.cnt).toFixed(2);
  console.log(`  $${op.toString(16).padStart(2,"0")}: cnt=${e.cnt} avgL=${avgL} avgM=${avgM} sample=${JSON.stringify(e.sample)}`);
}
