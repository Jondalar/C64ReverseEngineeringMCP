#!/usr/bin/env node
// CPU equivalence harness: run each documented opcode + addressing mode
// on legacy Cpu6510 and microcoded Cpu6510Cycled with identical RAM
// + register seed, diff state.
//
// Skips opcodes whose semantics are inherently divergent for this kind
// of side-by-side compare (BRK / RTI — vector-driven; JSR/RTS only
// covered in PC-roundtrip mode).

import { Cpu6510 } from "../dist/runtime/headless/cpu6510.js";
import { Cpu6510Cycled } from "../dist/runtime/headless/cpu/cpu6510-cycled.js";
import { OPCODE_TABLE } from "../dist/exomizer-ts/generated-opcodes.js";
import { UNDOC_TABLE } from "../dist/runtime/headless/cpu/undoc-table.js";

class Mem64K {
  constructor() { this.bytes = new Uint8Array(65536); this.writes = []; }
  read(a) { return this.bytes[a & 0xffff]; }
  write(a, v) { this.bytes[a & 0xffff] = v & 0xff; this.writes.push({ a: a & 0xffff, v: v & 0xff }); }
  clone() { const m = new Mem64K(); m.bytes.set(this.bytes); return m; }
}

// Deterministic LCG so seeds reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

function seedRam(mem, rng) {
  for (let i = 0; i < 65536; i++) mem.bytes[i] = rng() & 0xff;
}

const opcodeBytes = (op, mode) => {
  // Returns the byte sequence after the opcode for a given addressing mode.
  switch (mode) {
    case 'imp': case 'acc': return [];
    case 'imm': case 'rel': case 'zp': case 'zpx': case 'zpy':
    case 'indx': case 'indy':
      return [1];
    case 'abs': case 'absx': case 'absy': case 'ind':
      return [2];
    default: throw new Error(`unknown mode ${mode}`);
  }
};

function runSingleStep(CpuClass, mem, init) {
  const cpu = new CpuClass(mem);
  cpu.reset(init.pc);
  cpu.a = init.a; cpu.x = init.x; cpu.y = init.y;
  cpu.sp = init.sp; cpu.flags = init.flags;
  if ('executeCycle' in cpu && typeof cpu.executeCycle === 'function' && CpuClass === Cpu6510Cycled) {
    // Microcoded — step until back at instruction boundary.
    do { cpu.executeCycle(); } while (!cpu.isAtInstructionBoundary());
    // Run one more cycle so the next instruction's first fetch happens?
    // No — we want to stop AT next-instruction boundary which is after
    // the final micro-op of the current instruction. The loop above
    // exits after the last cycle of this instruction. Done.
  } else {
    cpu.step();
  }
  return {
    a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, flags: cpu.flags, pc: cpu.pc,
  };
}

function diff(legacyState, microState, legacyMem, microMem) {
  const r = [];
  for (const k of ['a', 'x', 'y', 'sp', 'pc']) {
    if (legacyState[k] !== microState[k]) r.push(`${k}: legacy=${legacyState[k].toString(16)} micro=${microState[k].toString(16)}`);
  }
  // Mask off B (0x10) + unused (0x20) bits — both CPUs report differently.
  const fL = legacyState.flags & 0xcf;
  const fM = microState.flags & 0xcf;
  if (fL !== fM) r.push(`flags: legacy=${fL.toString(16)} micro=${fM.toString(16)}`);
  // Memory diffs: compare full RAM. Report up to 5.
  const memDiffs = [];
  for (let i = 0; i < 65536 && memDiffs.length < 5; i++) {
    if (legacyMem.bytes[i] !== microMem.bytes[i]) {
      memDiffs.push(`$${i.toString(16).padStart(4,'0')}: legacy=${legacyMem.bytes[i].toString(16)} micro=${microMem.bytes[i].toString(16)}`);
    }
  }
  if (memDiffs.length > 0) r.push(`mem: ${memDiffs.join(' ; ')}`);
  return r;
}

const SKIP_OPS = new Set(['brk', 'rti']); // vector-driven; tested separately

const N_SEEDS = 8;
let totalCases = 0;
let totalFail = 0;
const failuresByOpcode = new Map();

for (let opcode = 0; opcode < 256; opcode++) {
  let info = OPCODE_TABLE[opcode];
  let isIllegal = false;
  if (!info) {
    const u = UNDOC_TABLE[opcode];
    if (!u) continue; // truly unknown — skip
    info = { op: u.kind, mode: u.mode, cycles: u.cycles };
    isIllegal = true;
  }
  if (SKIP_OPS.has(info.op)) continue;
  // Skip jam opcodes / unstable illegals that have undefined behavior.
  if (isIllegal && (info.op === 'xaa' || info.op === 'ahx' || info.op === 'tas' || info.op === 'shx' || info.op === 'shy' || info.op === 'las')) continue;
  const ob = opcodeBytes(info.op, info.mode);
  for (let seedIdx = 0; seedIdx < N_SEEDS; seedIdx++) {
    const rng = makeRng(0xCAFE0000 ^ (opcode << 8) ^ seedIdx);
    const legacyMem = new Mem64K();
    seedRam(legacyMem, rng);
    // Place opcode + operands at $1000.
    legacyMem.bytes[0x1000] = opcode;
    for (let k = 0; k < ob[0]; k++) legacyMem.bytes[0x1001 + k] = (rng() & 0xff);
    const microMem = legacyMem.clone();
    const init = {
      pc: 0x1000,
      a: rng() & 0xff,
      x: rng() & 0xff,
      y: rng() & 0xff,
      sp: 0xff,
      // Force-toggle D flag across seeds so BCD ADC/SBC paths get covered.
      flags: ((rng() & 0xff) | 0x20) ^ ((seedIdx & 1) ? 0x08 : 0x00),
    };
    let lState, mState;
    try { lState = runSingleStep(Cpu6510, legacyMem, init); }
    catch (e) { lState = { error: String(e) }; }
    try { mState = runSingleStep(Cpu6510Cycled, microMem, init); }
    catch (e) { mState = { error: String(e) }; }
    totalCases++;
    if (lState.error || mState.error) {
      totalFail++;
      const key = `${opcode.toString(16).padStart(2,'0')} ${info.op}.${info.mode}`;
      const arr = failuresByOpcode.get(key) ?? [];
      arr.push(`seed=${seedIdx}: legacy=${lState.error ?? 'ok'} micro=${mState.error ?? 'ok'}`);
      failuresByOpcode.set(key, arr);
      continue;
    }
    const diffs = diff(lState, mState, legacyMem, microMem);
    if (diffs.length > 0) {
      totalFail++;
      const key = `${opcode.toString(16).padStart(2,'0')} ${info.op}.${info.mode}`;
      const arr = failuresByOpcode.get(key) ?? [];
      arr.push(`seed=${seedIdx} init A=${init.a.toString(16)} X=${init.x.toString(16)} Y=${init.y.toString(16)} F=${init.flags.toString(16)}: ${diffs.join(' | ')}`);
      failuresByOpcode.set(key, arr);
    }
  }
}

console.log(`Total cases: ${totalCases}  fails: ${totalFail}`);
console.log(`Failing opcodes: ${failuresByOpcode.size}`);
const sorted = [...failuresByOpcode.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [op, fs] of sorted) {
  console.log(`\n${op}:`);
  for (const f of fs.slice(0, 2)) console.log(`  ${f}`);
  if (fs.length > 2) console.log(`  ...+${fs.length - 2} more`);
}
process.exit(failuresByOpcode.size > 0 ? 1 : 0);
