#!/usr/bin/env node
// Sprint 93.2 — emit a normalized per-instruction trace from a headless
// integrated session (microcoded + lockstep). Output format matches the
// swimlane-compare schema:
//   {n, cyc, pc, a, x, y, sp, p, opcode, bytes:[], mn}
//
// Goal: feed this through scripts/swimlane-diff.mjs alongside a VICE
// trace to find the FIRST instruction where headless drifts from VICE.
//
// Usage:
//   node scripts/dump-headless-trace.mjs --disk samples/maniac.g64 \
//       --instr 200000 --out /tmp/headless-mm.jsonl

import { existsSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const k = a.slice(2); const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true;
    else { o[k] = v; i++; }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const disk = args.disk;
const instr = Number(args.instr ?? 100_000);
const out = args.out ?? "/tmp/headless-trace.jsonl";
if (!disk || !existsSync(disk)) {
  console.error("Usage: node scripts/dump-headless-trace.mjs --disk <g64> --instr <N> --out <path>");
  process.exit(2);
}

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { OPCODE_TABLE } = await import("../dist/exomizer-ts/generated-opcodes.js");
const { UNDOC_TABLE } = await import("../dist/runtime/headless/cpu/undoc-table.js");

const { session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});
session.resetCold();

mkdirSync(dirname(out), { recursive: true });
const stream = createWriteStream(out);

function operandLen(opcode) {
  const info = OPCODE_TABLE[opcode];
  if (info) {
    switch (info.mode) {
      case "imp": case "acc": return 0;
      case "abs": case "absx": case "absy": case "ind": return 2;
      default: return 1;
    }
  }
  const u = UNDOC_TABLE[opcode];
  if (u) {
    switch (u.mode) {
      case "imp": case "acc": return 0;
      case "abs": case "absx": case "absy": case "ind": return 2;
      default: return 1;
    }
  }
  return 0;
}

function mnemonic(opcode) {
  const info = OPCODE_TABLE[opcode];
  if (info) return `${info.op}.${info.mode}`;
  const u = UNDOC_TABLE[opcode];
  if (u) return `*${u.kind}.${u.mode}`;
  return "???";
}

const cpu = session.c64Cpu;
const bus = session.c64Bus;

let n = 0;
const t0 = Date.now();
for (; n < instr; n++) {
  const pc = cpu.pc;
  const op = bus.read(pc);
  const oplen = operandLen(op);
  const b1 = oplen >= 1 ? bus.read((pc + 1) & 0xffff) : 0;
  const b2 = oplen >= 2 ? bus.read((pc + 2) & 0xffff) : 0;
  const rec = {
    n, cyc: cpu.cycles, pc, a: cpu.a, x: cpu.x, y: cpu.y,
    sp: cpu.sp, p: cpu.flags & 0xcf, op,
    bytes: oplen === 0 ? [op] : oplen === 1 ? [op, b1] : [op, b1, b2],
    mn: mnemonic(op),
  };
  stream.write(JSON.stringify(rec) + "\n");
  session.runFor(1);
  if (n % 50000 === 0 && n > 0) {
    process.stderr.write(`  ${n} instructions, cyc=${cpu.cycles}, ${Date.now() - t0}ms\n`);
  }
}
stream.end();
console.log(`Wrote ${n} instructions to ${out}. Final PC=$${cpu.pc.toString(16)}, cyc=${cpu.cycles}, wall=${Date.now() - t0}ms`);
