// One-line 6502/6510 assembler for the C64RE monitor's inline `a` command.
// Spec 754 §3.3c — assemble a single instruction (no address prefix) at a
// given PC, producing the encoded bytes (opcode + little-endian operands).
//
// SINGLE SOURCE OF TRUTH: the opcode table is the REVERSE index of the
// runtime disassembler `disasm6502.ts`. We import its `disasm6502` decode
// and walk all 256 opcodes once to build a (mnemonic+mode → opcode) map,
// so assemble→disasm round-trips exactly for every documented opcode.
//
// Why reverse the disassembler instead of embedding a fresh table: the
// monitor's `d` (disassemble) and `a` (assemble) commands MUST agree. If
// they drift, the user types what they just saw and gets different bytes.
// Reversing guarantees consistency by construction.

import { disasm6502, type AddressingMode } from "./disasm6502.js";

// ---------------------------------------------------------------------------
// Spec 754 §3.3c — public API
// ---------------------------------------------------------------------------

/** Success: encoded instruction bytes (opcode first) + total instruction size. */
export interface AssembleOk {
  bytes: number[];
  size: number;
}

/** Failure: short, specific human-readable reason. */
export interface AssembleErr {
  error: string;
}

// ---------------------------------------------------------------------------
// Spec 754 §3.3c — documented-opcode allowlist
// ---------------------------------------------------------------------------
// The disassembler table (disasm6502.ts) is the FULL 256 incl. undocumented
// opcodes. For v1 the assembler emits ONLY the documented NMOS 6502/6510 set.
// Undocumented mnemonics (slo, rla, sre, rra, sax, lax, dcp, isc, anc, alr,
// arr, axs, xaa, ahx, shx, shy, tas, las, jam) and the undocumented duplicate
// `nop` (with operands) / `sbc` (#imm alias 0xeb) entries are excluded from
// the assemble index — they would round-trip but are not part of v1.
const DOCUMENTED_MNEMONICS: ReadonlySet<string> = new Set([
  // load/store
  "lda", "ldx", "ldy", "sta", "stx", "sty",
  // transfers
  "tax", "tay", "txa", "tya", "tsx", "txs",
  // stack
  "pha", "php", "pla", "plp",
  // logic
  "and", "ora", "eor", "bit",
  // arithmetic
  "adc", "sbc", "cmp", "cpx", "cpy",
  // inc/dec
  "inc", "dec", "inx", "iny", "dex", "dey",
  // shifts
  "asl", "lsr", "rol", "ror",
  // jumps/calls
  "jmp", "jsr", "rts", "rti",
  // branches
  "bcc", "bcs", "beq", "bne", "bmi", "bpl", "bvc", "bvs",
  // flags
  "clc", "sec", "cld", "sed", "cli", "sei", "clv",
  // misc
  "brk", "nop",
]);

// ---------------------------------------------------------------------------
// Reverse index: (mnemonic|mode) → opcode byte
// ---------------------------------------------------------------------------
// Built once at module load by decoding all 256 opcodes via the disassembler.
// We keep only documented mnemonics, and for each (mnemonic,mode) pair we keep
// the FIRST (lowest) opcode encountered so the result is deterministic.
//
// CANONICAL OVERRIDES: a few documented mnemonics collide with undocumented
// duplicates that share mnemonic+mode and have a lower opcode byte. `nop impl`
// decodes from 0x1A/0x3A/0x5A/0x7A/0xDA/0xEA — the documented one is 0xEA, but
// "first wins" would pick 0x1A. We pin those so assemble→disasm produces the
// real instruction users expect. (`disasm6502` decodes any of them as "nop";
// round-trip text still matches.)
const CANONICAL: ReadonlyMap<string, number> = new Map<string, number>([
  ["nop|impl", 0xea],
]);
const REVERSE: Map<string, number> = (() => {
  const m = new Map<string, number>(CANONICAL);
  for (let op = 0; op <= 0xff; op++) {
    const d = disasm6502((a) => (a === 0 ? op : 0), 0);
    if (d.mnemonic === "???" || d.mnemonic === "jam") continue;
    if (!DOCUMENTED_MNEMONICS.has(d.mnemonic)) continue;
    const key = `${d.mnemonic}|${d.mode}`;
    if (!m.has(key)) m.set(key, op);
  }
  return m;
})();

function lookup(mnemonic: string, mode: AddressingMode): number | undefined {
  return REVERSE.get(`${mnemonic}|${mode}`);
}

function hasAnyMode(mnemonic: string, modes: AddressingMode[]): AddressingMode | undefined {
  for (const mode of modes) if (REVERSE.has(`${mnemonic}|${mode}`)) return mode;
  return undefined;
}

// ---------------------------------------------------------------------------
// Operand value parsing
// ---------------------------------------------------------------------------
// Spec 754 §3.3c — numeric forms:
//   $xx / $xxxx   hex (1..4 digits)
//   bare hex      e.g. `ff`, `c000`  (accepted; matches VICE leniency)
//   dd            decimal (no $ and contains a non-hex digit, OR explicit %/&… not supported v1)
//   %bbbbbbbb     binary
// We return both the value and whether the literal was written "wide" (>=3
// hex digits / a 16-bit decimal), which forces absolute over zero-page.

interface ParsedValue {
  value: number;
  forcedWide: boolean; // true => caller must NOT fold to zero page
}

function parseValue(raw: string): ParsedValue | { error: string } {
  const t = raw.trim();
  if (t.length === 0) return { error: "missing operand" };

  // Binary: %1010
  if (t[0] === "%") {
    const digits = t.slice(1);
    if (digits.length === 0 || /[^01]/.test(digits)) return { error: `bad binary operand '${raw}'` };
    const value = parseInt(digits, 2);
    return { value, forcedWide: digits.length > 8 || value > 0xff };
  }

  // Hex: $xx  (or bare hex token below)
  if (t[0] === "$") {
    const digits = t.slice(1);
    if (digits.length === 0 || /[^0-9a-fA-F]/.test(digits)) return { error: `bad hex operand '${raw}'` };
    const value = parseInt(digits, 16);
    return { value, forcedWide: digits.length > 2 || value > 0xff };
  }

  // Pure decimal: only digits 0-9
  if (/^[0-9]+$/.test(t)) {
    const value = parseInt(t, 10);
    if (!Number.isFinite(value)) return { error: `bad operand '${raw}'` };
    return { value, forcedWide: value > 0xff };
  }

  // Bare hex token (contains a-f, no other junk): `lda #ff`, `jmp c000`
  if (/^[0-9a-fA-F]+$/.test(t)) {
    const value = parseInt(t, 16);
    return { value, forcedWide: t.length > 2 || value > 0xff };
  }

  return { error: `bad operand '${raw}'` };
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------
function byteOk(opcode: number): AssembleOk {
  return { bytes: [opcode], size: 1 };
}
function byte2Ok(opcode: number, operand: number): AssembleOk {
  return { bytes: [opcode, operand & 0xff], size: 2 };
}
function byte3Ok(opcode: number, operand: number): AssembleOk {
  return { bytes: [opcode, operand & 0xff, (operand >> 8) & 0xff], size: 3 };
}

// ---------------------------------------------------------------------------
// Spec 754 §3.3c — the assembler
// ---------------------------------------------------------------------------

/**
 * Assemble one 6502/6510 instruction (no address prefix).
 * @param text e.g. "lda #$01", "sta $d020", "bne $c010", "sta ($fd),y", "rol"
 * @param pc   the address the instruction will live at (for branch offsets)
 * @returns encoded bytes + size, or { error }.
 */
export function assembleLine(text: string, pc: number): AssembleOk | AssembleErr {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { error: "empty instruction" };

  // Split mnemonic from operand on first run of whitespace.
  const m = /^([a-zA-Z]{3})\b\s*(.*)$/.exec(trimmed);
  if (!m) return { error: `unparsable instruction '${text.trim()}'` };
  const mnemonic = m[1].toLowerCase();
  // Strip all internal whitespace from the operand — `lda $05 , x` == `lda $05,x`.
  const operandText = m[2].replace(/\s+/g, "");

  if (!DOCUMENTED_MNEMONICS.has(mnemonic)) {
    return { error: `unknown mnemonic '${mnemonic}'` };
  }

  // -------------------------------------------------------------------------
  // No operand: implied or accumulator.
  // -------------------------------------------------------------------------
  if (operandText.length === 0 || operandText.toLowerCase() === "a") {
    const op =
      lookup(mnemonic, "impl") ??
      lookup(mnemonic, "acc");
    if (op === undefined) {
      return { error: `'${mnemonic}' requires an operand` };
    }
    return byteOk(op);
  }

  const lower = operandText.toLowerCase();

  // -------------------------------------------------------------------------
  // Relative branches: operand is a TARGET ADDRESS; encode signed offset.
  // Spec 754 §3.3c — offset = target - (pc + 2), must be in -128..127.
  // -------------------------------------------------------------------------
  if (REVERSE.has(`${mnemonic}|rel`)) {
    const pv = parseValue(operandText);
    if ("error" in pv) return pv;
    if (pv.value < 0 || pv.value > 0xffff) {
      return { error: `branch target $${pv.value.toString(16)} out of range` };
    }
    const op = REVERSE.get(`${mnemonic}|rel`)!;
    const offset = pv.value - ((pc + 2) & 0xffff);
    if (offset < -128 || offset > 127) {
      return { error: `branch out of range (${offset} bytes)` };
    }
    return byte2Ok(op, offset & 0xff);
  }

  // -------------------------------------------------------------------------
  // Immediate: #$xx / #dd / #ff
  // -------------------------------------------------------------------------
  if (lower[0] === "#") {
    const pv = parseValue(operandText.slice(1));
    if ("error" in pv) return pv;
    if (pv.value > 0xff) return { error: `immediate value $${pv.value.toString(16)} overflows a byte` };
    const op = lookup(mnemonic, "imm");
    if (op === undefined) return { error: `'${mnemonic}' has no immediate mode` };
    return byte2Ok(op, pv.value);
  }

  // -------------------------------------------------------------------------
  // Indirect family: starts with '(' .
  //   ($xxxx)      indirect (JMP only)
  //   ($xx,x)      (zp,x)
  //   ($xx),y      (zp),y
  // -------------------------------------------------------------------------
  if (lower[0] === "(") {
    // (zp,x):  ( <val> , x )
    let im = /^\(([^,)]+),x\)$/.exec(lower);
    if (im) {
      const pv = parseValue(im[1]);
      if ("error" in pv) return pv;
      if (pv.value > 0xff) return { error: `(zp,x) operand $${pv.value.toString(16)} not zero-page` };
      const op = lookup(mnemonic, "(zp,x)");
      if (op === undefined) return { error: `'${mnemonic}' has no (zp,x) mode` };
      return byte2Ok(op, pv.value);
    }
    // (zp),y:  ( <val> ) , y
    im = /^\(([^,)]+)\),y$/.exec(lower);
    if (im) {
      const pv = parseValue(im[1]);
      if ("error" in pv) return pv;
      if (pv.value > 0xff) return { error: `(zp),y operand $${pv.value.toString(16)} not zero-page` };
      const op = lookup(mnemonic, "(zp),y");
      if (op === undefined) return { error: `'${mnemonic}' has no (zp),y mode` };
      return byte2Ok(op, pv.value);
    }
    // indirect:  ( <val> )    — JMP only
    im = /^\(([^,)]+)\)$/.exec(lower);
    if (im) {
      const pv = parseValue(im[1]);
      if ("error" in pv) return pv;
      if (pv.value > 0xffff) return { error: `indirect operand $${pv.value.toString(16)} overflows 16 bits` };
      const op = lookup(mnemonic, "ind");
      if (op === undefined) return { error: `'${mnemonic}' has no indirect mode` };
      return byte3Ok(op, pv.value);
    }
    return { error: `bad indirect operand '${operandText}'` };
  }

  // -------------------------------------------------------------------------
  // Indexed / plain: <val> | <val>,x | <val>,y
  // Spec 754 §3.3c — fold to zero page when value fits in a byte AND a zp form
  // exists AND the literal was not written "wide" (>=3 hex digits / 16-bit dec).
  // -------------------------------------------------------------------------
  let suffix: "" | ",x" | ",y" = "";
  let valuePart = lower;
  if (lower.endsWith(",x")) {
    suffix = ",x";
    valuePart = lower.slice(0, -2);
  } else if (lower.endsWith(",y")) {
    suffix = ",y";
    valuePart = lower.slice(0, -2);
  } else if (lower.includes(",")) {
    return { error: `bad index suffix in '${operandText}'` };
  }

  const pv = parseValue(valuePart);
  if ("error" in pv) return pv;
  if (pv.value < 0 || pv.value > 0xffff) {
    return { error: `operand $${pv.value.toString(16)} overflows 16 bits` };
  }

  const fitsZp = pv.value <= 0xff && !pv.forcedWide;

  // Decide candidate modes by suffix, zp-first when the value qualifies.
  let zpMode: AddressingMode;
  let absMode: AddressingMode;
  switch (suffix) {
    case "":
      zpMode = "zp";
      absMode = "abs";
      break;
    case ",x":
      zpMode = "zp,x";
      absMode = "abs,x";
      break;
    case ",y":
      zpMode = "zp,y";
      absMode = "abs,y";
      break;
  }

  if (fitsZp) {
    const zpOp = lookup(mnemonic, zpMode);
    if (zpOp !== undefined) return byte2Ok(zpOp, pv.value);
    // No zp form (e.g. only abs exists) — fall through to absolute if value fits.
  }

  const absOp = lookup(mnemonic, absMode);
  if (absOp !== undefined) {
    if (pv.value > 0xffff) return { error: `operand overflows 16 bits` };
    return byte3Ok(absOp, pv.value);
  }

  // Neither mode exists for this mnemonic — report what was attempted.
  const triedZp = fitsZp ? `${zpMode} or ` : "";
  // Detect an "almost": mnemonic exists but only in modes we didn't pick.
  const available = hasAnyMode(mnemonic, [
    "impl", "acc", "imm", "zp", "zp,x", "zp,y",
    "abs", "abs,x", "abs,y", "ind", "(zp,x)", "(zp),y", "rel",
  ]);
  if (available === undefined) {
    return { error: `unknown mnemonic '${mnemonic}'` };
  }
  return { error: `'${mnemonic}' has no ${triedZp}${absMode} mode` };
}
