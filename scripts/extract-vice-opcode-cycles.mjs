// Spec 092.1 — Generate per-opcode microcode pattern.
//
// VICE 6510core.c uses heavily macro-expanded code so direct parsing
// is fragile. Instead we apply per-(addr-mode, op-class) templates
// derived from VICE source + Lorenz cycle-perfect documentation.
//
// Output: src/runtime/headless/cpu/microcode-table.ts
//
// Run: node scripts/extract-vice-opcode-cycles.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'src', 'runtime', 'headless', 'cpu', 'microcode-table.ts');

// Bus access kinds per cycle.
//
// Each opcode = sequence of MicroOps. Each MicroOp executes in 1 cycle.
// First op is always 'fetch_opcode'. Remaining ops define operand
// fetches, EA computation reads, EA reads/writes, internal cycles.
//
// Examples:
//   LDA #imm (2c):     ['fetch_opcode', 'fetch_imm']
//   LDA $ZP (3c):      ['fetch_opcode', 'fetch_zp_lo', 'read_ea']
//   LDA $ZPX (4c):     ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'read_ea']
//   LDA $XXXX (4c):    ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea']
//   LDA $XXXX,X (4-5): ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea_or_dummy_then_read']
//   STA $XXXX (4c):    ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'write_ea']
//   INC $XXXX (6c):    ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea', 'dummy_write_ea_old', 'write_ea_new']
//   JMP ($XXXX) (5c):  ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea_lo', 'read_ea_hi']
//   JSR (6c):          ['fetch_opcode', 'fetch_lo', 'internal', 'push_pch', 'push_pcl', 'fetch_hi']
//   RTS (6c):          ['fetch_opcode', 'internal', 'pull_dummy_sp', 'pull_pcl', 'pull_pch', 'fetch_pc_dummy']
//   BRK (7c):          ['fetch_opcode', 'fetch_dummy', 'push_pch', 'push_pcl', 'push_p', 'read_vec_lo', 'read_vec_hi']
//   PHA/PHP (3c):      ['fetch_opcode', 'internal', 'push']
//   PLA/PLP (4c):      ['fetch_opcode', 'internal', 'pull_dummy_sp', 'pull']
//   Branch taken (3c): ['fetch_opcode', 'fetch_imm', 'internal']
//   Branch crossed pg (4c): + 'internal'
//
// Op-class describes WHAT happens at the final cycle (load A, store
// X, increment, branch, etc). Cycle pattern describes WHEN bus access
// happens (which cycle).

const ADDR_MODE_PATTERNS = {
  // imp/acc: 2 cycles. Opcode + 1 internal (or dummy read of next byte).
  imp: ['fetch_opcode', 'internal'],
  acc: ['fetch_opcode', 'internal'],
  // imm: 2 cycles. Opcode + immediate operand fetch.
  imm: ['fetch_opcode', 'fetch_imm'],
  // zp read: 3 cycles. Opcode + zp address + read EA.
  zp_read:  ['fetch_opcode', 'fetch_zp_lo', 'read_ea'],
  zp_write: ['fetch_opcode', 'fetch_zp_lo', 'write_ea'],
  zp_rmw:   ['fetch_opcode', 'fetch_zp_lo', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  // zpx/zpy: 4 cycles. Opcode + zp + dummy zp read + read/write EA.
  zpx_read:  ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'read_ea'],
  zpx_write: ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'write_ea'],
  zpx_rmw:   ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  zpy_read:  ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'read_ea'],
  zpy_write: ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'write_ea'],
  // abs read/write: 4 cycles. Opcode + lo + hi + read/write.
  abs_read:  ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea'],
  abs_write: ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'write_ea'],
  abs_rmw:   ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  // absx/absy read: 4-5 cycles. +1 if page cross. Read uses
  // 'read_ea_or_dummy_then_read' which expands at runtime.
  absx_read:  ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea_pgx'],
  absx_write: ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'dummy_addr', 'write_ea'],
  absx_rmw:   ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'dummy_addr', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  absy_read:  ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea_pgy'],
  absy_write: ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'dummy_addr', 'write_ea'],
  // indirect (JMP only): 5 cycles. Opcode + lo + hi + read EA lo + read EA hi.
  ind_jmp: ['fetch_opcode', 'fetch_lo', 'fetch_hi', 'read_ea_lo', 'read_ea_hi'],
  // indx (preindexed indirect): 6 cycles. Opcode + zp + dummy + lo + hi + read.
  indx_read:  ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'fetch_ind_lo', 'fetch_ind_hi', 'read_ea'],
  indx_write: ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'fetch_ind_lo', 'fetch_ind_hi', 'write_ea'],
  indx_rmw:   ['fetch_opcode', 'fetch_zp_lo', 'dummy_zp', 'fetch_ind_lo', 'fetch_ind_hi', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  // indy (postindexed indirect): 5-6 cycles read. Opcode + zp + lo + hi + read (with page-cross).
  indy_read:  ['fetch_opcode', 'fetch_zp_lo', 'fetch_ind_lo', 'fetch_ind_hi', 'read_ea_pgy'],
  indy_write: ['fetch_opcode', 'fetch_zp_lo', 'fetch_ind_lo', 'fetch_ind_hi', 'dummy_addr', 'write_ea'],
  indy_rmw:   ['fetch_opcode', 'fetch_zp_lo', 'fetch_ind_lo', 'fetch_ind_hi', 'dummy_addr', 'read_ea', 'dummy_write_ea_old', 'write_ea_new'],
  // rel: 2-4 cycles. Base 2 (opcode + offset). +1 if branch taken. +1 if page cross.
  rel: ['fetch_opcode', 'fetch_imm'], // branch taken/cross handled at runtime
  // Stack ops.
  push: ['fetch_opcode', 'internal', 'push'],
  pop:  ['fetch_opcode', 'internal', 'dummy_sp', 'pop'],
  // BRK: 7 cycles. Opcode + dummy + 3 pushes + vec lo + vec hi.
  brk:  ['fetch_opcode', 'fetch_dummy_pc', 'push_pch', 'push_pcl', 'push_p_brk', 'read_brk_vec_lo', 'read_brk_vec_hi'],
  // RTI: 6 cycles. Opcode + dummy + dummy_sp + pop_p + pop_pcl + pop_pch.
  rti:  ['fetch_opcode', 'internal', 'dummy_sp', 'pop_p', 'pop_pcl', 'pop_pch'],
  // RTS: 6 cycles. Opcode + dummy + dummy_sp + pop_pcl + pop_pch + dummy_pc_inc.
  rts:  ['fetch_opcode', 'internal', 'dummy_sp', 'pop_pcl', 'pop_pch', 'fetch_pc_dummy'],
  // JSR: 6 cycles. Opcode + lo + dummy_sp + push_pch + push_pcl + hi.
  jsr:  ['fetch_opcode', 'fetch_lo', 'dummy_sp', 'push_pch', 'push_pcl', 'fetch_hi'],
  // JMP absolute: 3 cycles. Opcode + lo + hi.
  jmp_abs: ['fetch_opcode', 'fetch_lo', 'fetch_hi'],
};

// Per-opcode definition: { kind: op-class, mode: addr-mode-pattern-key }.
// op-class is consumed by the CPU at the FINAL cycle (or at specific
// cycles for store/RMW). We pick the right ADDR_MODE_PATTERN based on
// (op, addr-mode).

// Documented opcodes from existing OPCODE_TABLE in
// src/exomizer-ts/generated-opcodes.ts. Map each (op, mode) to a
// pattern key.

function patternKeyFor(op, mode) {
  // Determine read vs write vs rmw based on op.
  const readOps = new Set(['lda','ldx','ldy','adc','sbc','and','ora','eor','cmp','cpx','cpy','bit']);
  const writeOps = new Set(['sta','stx','sty']);
  const rmwOps = new Set(['inc','dec','asl','lsr','rol','ror']);
  const isRead = readOps.has(op);
  const isWrite = writeOps.has(op);
  const isRmw = rmwOps.has(op);
  // Special ops that define their own pattern.
  if (op === 'brk') return 'brk';
  if (op === 'rti') return 'rti';
  if (op === 'rts') return 'rts';
  if (op === 'jsr') return 'jsr';
  if (op === 'jmp') return mode === 'ind' ? 'ind_jmp' : 'jmp_abs';
  if (op === 'pha' || op === 'php') return 'push';
  if (op === 'pla' || op === 'plp') return 'pop';
  // Branches are all rel-mode.
  if (mode === 'rel') return 'rel';
  // Implied/accumulator: for ASL A / LSR A / ROL A / ROR A, mode is 'acc'.
  if (mode === 'acc') return 'acc';
  if (mode === 'imp') return 'imp';
  if (mode === 'imm') return 'imm';
  // Memory addr modes.
  if (mode === 'zp') return isWrite ? 'zp_write' : isRmw ? 'zp_rmw' : 'zp_read';
  if (mode === 'zpx') return isWrite ? 'zpx_write' : isRmw ? 'zpx_rmw' : 'zpx_read';
  if (mode === 'zpy') return isWrite ? 'zpy_write' : 'zpy_read';
  if (mode === 'abs') return isWrite ? 'abs_write' : isRmw ? 'abs_rmw' : 'abs_read';
  if (mode === 'absx') return isWrite ? 'absx_write' : isRmw ? 'absx_rmw' : 'absx_read';
  if (mode === 'absy') return isWrite ? 'absy_write' : 'absy_read';
  if (mode === 'indx') return isWrite ? 'indx_write' : isRmw ? 'indx_rmw' : 'indx_read';
  if (mode === 'indy') return isWrite ? 'indy_write' : isRmw ? 'indy_rmw' : 'indy_read';
  throw new Error(`No pattern for op=${op} mode=${mode}`);
}

// Build the table by reading OPCODE_TABLE source as text + regex parsing.
import { readFileSync } from 'node:fs';
const opcTablePath = join(__dirname, '..', 'src', 'exomizer-ts', 'generated-opcodes.ts');
const opcTextRaw = readFileSync(opcTablePath, 'utf8');
// Strip the type alias line "Array<OpcodeInfo | null>" so its 'null'
// token doesn't leak into the parsed entry list.
const opcText = opcTextRaw
  .replace(/Array<[^>]*>/g, 'Array')
  .replace(/^export const OPCODE_TABLE.*$/m, 'export const OPCODE_TABLE = [');
// Extract OPCODE_TABLE entries via regex (each is null or { op, mode, cycles }).
const entries = [];
const re = /\{\s*"op":\s*"(\w+)",\s*"mode":\s*"(\w+)",\s*"cycles":\s*(\d+)\s*\}|null/g;
let m;
while ((m = re.exec(opcText)) !== null) {
  if (m[1]) entries.push({ op: m[1], mode: m[2], cycles: Number(m[3]) });
  else entries.push(null);
}
// Trim to 256 if regex over-matched (defensive).
if (entries.length > 256) entries.length = 256;
console.error(`Parsed ${entries.length} entries from ${opcTablePath}`);
if (entries.length !== 256) {
  console.error(`Warning: expected 256 entries, got ${entries.length}`);
}

const microcode = entries.map((e, i) => {
  if (!e) return null;
  const key = patternKeyFor(e.op, e.mode);
  return { op: e.op, mode: e.mode, cycles: e.cycles, pattern: key };
});

// Generate output.
const out = [
  `// Generated by scripts/extract-vice-opcode-cycles.mjs — do not edit.`,
  `// Spec 092.1 microcode table.`,
  ``,
  `export type AddressModePattern =`,
  ...Object.keys(ADDR_MODE_PATTERNS).map((k) => `  | "${k}"`),
  `;`,
  ``,
  `export type MicroOp = string;`,
  ``,
  `export const ADDR_MODE_PATTERNS: Record<AddressModePattern, MicroOp[]> = ${JSON.stringify(ADDR_MODE_PATTERNS, null, 2)} as const;`,
  ``,
  `export interface MicrocodeEntry {`,
  `  op: string;`,
  `  mode: string;`,
  `  cycles: number;`,
  `  pattern: AddressModePattern;`,
  `}`,
  ``,
  `export const MICROCODE_TABLE: Array<MicrocodeEntry | null> = ${JSON.stringify(microcode, null, 2)};`,
  ``,
].join('\n');

writeFileSync(OUT_PATH, out);
console.error(`Wrote ${OUT_PATH} (${out.length} bytes)`);
