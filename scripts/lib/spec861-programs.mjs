// Spec 861 §7 — the programs the acceptance gates run on the machine.
//
// Three of them, and they are generated rather than checked in so the exerciser
// is provably EVERY opcode the decoder knows rather than every opcode somebody
// remembered to type:
//
//   exerciser()     every documented opcode and addressing mode and every stable
//                   undocumented one, each in both page-crossing states where the
//                   mode has one, each branch taken and not taken and taken
//                   across a page. §7.1 runs it with the display off and asserts
//                   measured == static and stolen == 0; §7.2 runs the same bytes
//                   with the display on and asserts the difference lands on bad
//                   lines.
//   rasterWriter()  one `sta $D020` at a known raster line, every frame. §7.4.
//   rasterIrq()     a raster interrupt with its own handler. §7.3.
//
// The exerciser runs with $01 = $34 — all RAM, no I/O, no ROM — so that
// $FFFA-$FFFF are cells it owns (BRK and the interrupt vectors), nothing it
// writes reaches a chip, and nothing it reads is a register whose value changes
// under it. The VIC is set up BEFORE that switch and keeps running either way:
// $01 is what the CPU sees, not what the VIC does.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

// The decoder and the cycle table, from the build — the same two the tool uses.
const { decodeInstruction, opcodeTiming } = require(join(ROOT, "dist/pipeline/lib/mos6502.cjs"));

// $2000 and not $C000: the body is a few thousand instructions long and every
// taken-across-a-page branch costs most of a page, and code that grew into
// $D000-$DFFF would be loaded THROUGH the I/O window instead of into the RAM
// under it. Everything here stays below it.
export const EXERCISER_ORG = 0x2000;
export const ZP_PTR = 0xf8;         // $F8/$F9 → the scratch cell
export const ZP_SCRATCH = 0xfa;     // the zero-page operand
export const ZP_JMP = 0xfc;         // $FC/$FD → the target of `jmp ($00FC)`
export const ZP_SP = 0xf0;          // the stack pointer, parked

const decode = (op) => decodeInstruction(Buffer.from([op, 0x00, 0x00]), 0, 0);

class Asm {
  constructor(org) { this.org = org; this.bytes = []; }
  get pc() { return this.org + this.bytes.length; }
  b(...v) { for (const x of v) this.bytes.push(x & 0xff); return this; }
  /** `lda #v` */ lda(v) { return this.b(0xa9, v); }
  /** `sta abs` */ sta(a) { return this.b(0x8d, a & 0xff, a >> 8); }
  /** `sta zp` */ staz(a) { return this.b(0x85, a); }
  ldx(v) { return this.b(0xa2, v); }
  ldy(v) { return this.b(0xa0, v); }
  jmpTo(a) { return this.b(0x4c, a & 0xff, a >> 8); }
  /** pad with NOPs until the program counter is `addr` */
  padTo(addr) { while (this.pc < addr) this.b(0xea); return this; }
  at(addr) {
    if (this.pc > addr) throw new Error(`already past $${addr.toString(16)}`);
    return this.padTo(addr);
  }
}

/** The operand bytes each addressing mode gets in the exerciser. */
function operandFor(mode, L) {
  const SCRATCH = L.scratch;
  switch (mode) {
    case "impl": case "acc": return [];
    case "imm": return [0x01];
    case "zp": case "zp,x": case "zp,y": return [ZP_SCRATCH];
    case "abs": case "abs,x": case "abs,y": return [SCRATCH & 0xff, SCRATCH >> 8];
    case "(zp,x)": case "(zp),y": return [ZP_PTR];
    case "ind": return [ZP_JMP, 0x00];
    default: return null;
  }
}

/** Opcodes the exerciser handles specially, or not at all. */
const SPECIAL = new Set(["jam", "brk", "jsr", "rts", "rti", "jmp", "pha", "php", "pla", "plp", "txs", "tas", "las", "cli", "sed"]);
const BRANCHES = { bpl: 0x10, bmi: 0x30, bvc: 0x50, bvs: 0x70, bcc: 0x90, bcs: 0xb0, bne: 0xd0, beq: 0xf0 };

/**
 * Every opcode, once, with the registers put back between them.
 *
 * `displayOn` decides §7.1 from §7.2: the same bytes with $D011 bit 4 set or
 * clear, which is the difference between a machine whose VIC takes no cycles
 * and one whose VIC takes forty on every bad line.
 */
export function exerciser({ displayOn = false } = {}) {
  // Two passes: the helpers and the scratch page sit ABOVE the body, and where
  // that is depends on how long the body turns out to be. The layout of the
  // body is identical either way — only the operand VALUES change, never their
  // size — so the second pass lands on the same addresses the first measured.
  const first = buildExerciser(displayOn, { rts: 0x8000, scratch: 0x8100, cross: 0x8201 });
  const page = (first.end + 0x100) & 0xff00;
  return buildExerciser(displayOn, { rts: page, scratch: page + 0x100, cross: page + 0x201 });
}

/**
 * The state every measured program starts from: interrupts off, the VIC as the
 * gate wants it, a key waited for so the capture's window is the body, and then
 * all RAM — no I/O to read a moving value from, no ROM, and the vectors in cells
 * the program owns.
 */
function setup(a, { displayOn, vectors, scratch }) {
  a.b(0x78);                       // sei
  a.lda(0x7f).sta(0xdc0d).sta(0xdd0d);   // no CIA interrupts
  a.b(0xad, 0x0d, 0xdc);           // lda $dc0d — acknowledge
  a.b(0xad, 0x0d, 0xdd);           // lda $dd0d
  a.lda(0x00).sta(0xd015);         // no sprites
  a.lda(displayOn ? 0x1b : 0x0b).sta(0xd011);  // the display, on or off
  a.lda(0x00).sta(0xd01a);         // no VIC interrupts
  // Wait for a key before starting, so the capture's window is the BODY and not
  // the frames of KERNAL idling it takes to type `SYS 8192`. Read off the matrix
  // directly: the KERNAL is about to be banked out anyway.
  a.lda(0x00).sta(0xdc00);         // every keyboard row driven low
  // First wait for the keyboard to be EMPTY. The RETURN that ended `SYS 8192`
  // is still held down when the program starts — a bare "wait for a key" sees
  // it, starts at once, and the body is over before the capture opens.
  const keyClear = a.pc;
  a.b(0xad, 0x01, 0xdc);           // lda $dc01
  a.b(0xc9, 0xff);                 // cmp #$ff — nothing pressed
  a.b(0xd0, (keyClear - (a.pc + 2)) & 0xff);
  const keyWait = a.pc;
  a.b(0xad, 0x01, 0xdc);           // lda $dc01
  a.b(0xc9, 0xff);
  a.b(0xf0, (keyWait - (a.pc + 2)) & 0xff);
  a.b(0xba).b(0x86, ZP_SP);        // tsx / stx $F0 — park the stack pointer
  a.lda(0x34).staz(0x01);          // all RAM: no I/O, no ROM, and $FFFA-$FFFF are ours
  if (vectors) {
    a.lda(vectors.irq & 0xff).sta(0xfffe);
    a.lda(vectors.irq >> 8).sta(0xffff);
    a.lda(vectors.nmi & 0xff).sta(0xfffa);
    a.lda(vectors.nmi >> 8).sta(0xfffb);
  }
  if (scratch !== undefined) {
    a.lda(scratch & 0xff).staz(ZP_PTR);
    a.lda(scratch >> 8).staz(ZP_PTR + 1);
    a.lda(0xff).sta(scratch);      // a value with bit 6 and bit 7 set, for `bit`
    a.lda(0x01).staz(ZP_SCRATCH);
  }
  return a;
}

function buildExerciser(displayOn, L) {
  const HELPER_RTS = L.rts;
  const HELPER_IRQ = L.rts + 1;
  const HELPER_NMI = L.rts + 2;
  const SCRATCH = L.scratch;
  const CROSS_BASE = L.cross;
  const a = new Asm(EXERCISER_ORG);
  const covered = [];

  setup(a, { displayOn, vectors: { irq: HELPER_IRQ, nmi: HELPER_NMI }, scratch: SCRATCH });

  const reset = () => a.ldx(0x00).ldy(0x00).lda(0x01);
  reset();

  // ── every opcode the decoder knows ───────────────────────────────────────
  for (let op = 0; op < 256; op += 1) {
    const d = decode(op);
    const mn = d.mnemonic;
    if (mn === "jam") continue;                       // never retires: no cycles to prove
    if (["rts", "rti", "pla", "plp"].includes(mn)) continue;  // exercised as the second half of a pair
    if (["txs", "tas", "las"].includes(mn)) continue;         // the tail: they move the stack pointer

    if (mn === "brk") {
      // BRK reads its own vector and pushes three bytes, which is what an
      // interrupt entry looks like — §4.2 subtracts its own pair for exactly
      // this instruction. The handler is an `rti`, so `rti` is covered here.
      a.b(0x00, 0xea);
      covered.push(op, 0x40);
      reset();
      continue;
    }
    if (mn === "jsr") { a.b(0x20, HELPER_RTS & 0xff, HELPER_RTS >> 8); covered.push(op, 0x60); reset(); continue; }
    if (mn === "jmp" && d.mode === "abs") { const t = a.pc + 3; a.jmpTo(t); covered.push(op); reset(); continue; }
    if (mn === "jmp" && d.mode === "ind") {
      const target = a.pc + 4 + 4 + 3;               // two lda/sta pairs, then the jmp
      a.lda(target & 0xff).staz(ZP_JMP);
      a.lda(target >> 8).staz(ZP_JMP + 1);
      a.b(0x6c, ZP_JMP, 0x00);
      covered.push(op);
      reset();
      continue;
    }
    if (mn === "pha") { a.b(0x48, 0x68); covered.push(0x48, 0x68); reset(); continue; }
    if (mn === "php") { a.b(0x08, 0x28); covered.push(0x08, 0x28); reset(); continue; }
    if (mn === "cli") { a.b(0x58, 0x78); covered.push(0x58, 0x78); reset(); continue; }
    if (mn === "sed") { a.b(0xf8, 0xd8); covered.push(0xf8, 0xd8); reset(); continue; }
    if (d.mode === "rel") {
      // Both outcomes, and never with an offset of 0: a branch whose target IS
      // its fall-through cannot be told apart afterwards, and the whole point is
      // that the trace decides which it was.
      const flagSet = { bpl: [0xa9, 0x00], bmi: [0xa9, 0x80], bvc: [0xb8], bvs: [0x24, ZP_SCRATCH], bcc: [0x18], bcs: [0x38], bne: [0xa9, 0x01], beq: [0xa9, 0x00] };
      const flagClear = { bpl: [0xa9, 0x80], bmi: [0xa9, 0x00], bvc: [0x24, ZP_SCRATCH], bvs: [0xb8], bcc: [0x38], bcs: [0x18], bne: [0xa9, 0x00], beq: [0xa9, 0x01] };
      a.lda(0xc0).staz(ZP_SCRATCH);                  // bit 6 and 7 set, for `bit`
      a.b(...flagSet[mn]); a.b(op, 0x02, 0xea, 0xea);  // taken: over the two NOPs
      a.lda(0xc0).staz(ZP_SCRATCH);
      a.b(...flagClear[mn]); a.b(op, 0x02, 0xea, 0xea); // not taken: into them
      covered.push(op);
      a.lda(0x01).staz(ZP_SCRATCH);
      reset();
      continue;
    }
    const operand = operandFor(d.mode, L);
    if (operand === null) throw new Error(`no operand for mode ${d.mode} (opcode $${op.toString(16)})`);
    a.b(op, ...operand);
    covered.push(op);
    reset();
  }

  // ── the same indexed reads, crossing a page ──────────────────────────────
  a.lda(CROSS_BASE & 0xff).staz(ZP_PTR);
  a.lda(CROSS_BASE >> 8).staz(ZP_PTR + 1);
  const crossing = [];
  for (let op = 0; op < 256; op += 1) {
    const t = opcodeTiming(op);
    if (!t?.pageCross) continue;
    const d = decode(op);
    if (d.mnemonic === "las") continue;               // moves the stack pointer: in the tail
    if (d.mode === "abs,x") { a.ldx(0xff); a.b(op, CROSS_BASE & 0xff, CROSS_BASE >> 8); }
    else if (d.mode === "abs,y") { a.ldy(0xff); a.b(op, CROSS_BASE & 0xff, CROSS_BASE >> 8); }
    else if (d.mode === "(zp),y") { a.ldy(0xff); a.b(op, ZP_PTR); }
    else continue;
    crossing.push(op);
    reset();
  }
  a.lda(SCRATCH & 0xff).staz(ZP_PTR);
  a.lda(SCRATCH >> 8).staz(ZP_PTR + 1);

  // ── every branch taken ACROSS a page ─────────────────────────────────────
  // The rule is on the fall-through address and the target: a branch at $xxFC
  // with an offset of +4 has its fall-through on one page and its target on the
  // next, which is the only shape that pays the second cycle.
  const crossBranches = [];
  // `bvs` wants V set, and the setter for it is a `bit` on the scratch cell — so
  // the cell has to hold a value with bit 6 in it before the loop starts.
  a.lda(0xc0).staz(ZP_SCRATCH);
  for (const [mn, op] of Object.entries(BRANCHES)) {
    const page = (a.pc + 0x100) & 0xff00;
    a.at(page + 0xfc - 2);                            // room for the flag setter
    const set = { bpl: [0xa9, 0x00], bmi: [0xa9, 0x80], bvc: [0xb8], bvs: [0x24, ZP_SCRATCH], bcc: [0x18], bcs: [0x38], bne: [0xa9, 0x01], beq: [0xa9, 0x00] }[mn];
    if (set.length === 1) a.b(0xea);                  // keep the branch on $xxFC
    a.b(...set);
    if (a.pc !== page + 0xfc) throw new Error(`branch ${mn} landed at $${a.pc.toString(16)}, not $${(page + 0xfc).toString(16)}`);
    const at = a.pc;
    a.b(op, 0x04, 0xea, 0xea, 0xea, 0xea);            // → $xx+1,02
    crossBranches.push({ op, at });
  }
  // `bvs` needs V set, and `bit $FA` set it from a value the loop may have
  // changed; put the cell back for anything that follows.
  a.lda(0x01).staz(ZP_SCRATCH);
  reset();

  // ── the three that move the stack pointer, and the restore ───────────────
  a.b(0x9a);                                          // txs (X = 0)
  a.b(0x9b, SCRATCH & 0xff, SCRATCH >> 8);            // tas abs,y
  a.b(0xbb, SCRATCH & 0xff, SCRATCH >> 8);            // las abs,y
  a.ldy(0xff);
  a.b(0xbb, CROSS_BASE & 0xff, CROSS_BASE >> 8);      // las abs,y, crossing a page
  a.b(0xa6, ZP_SP).b(0x9a);                           // ldx $F0 / txs — the stack back
  covered.push(0x9a, 0x9b, 0xbb);
  crossing.push(0xbb);

  // ── the loop it ends in ──────────────────────────────────────────────────
  // Not an `rts`: with $01 = $34 there is no KERNAL to return to, and a tight
  // loop is also the cleanest thing for §7.2 to measure a bad line against.
  const end = a.pc;
  a.jmpTo(end);

  if (a.pc > HELPER_RTS) throw new Error(`the exerciser body reached $${a.pc.toString(16)}, over the helpers at $${HELPER_RTS.toString(16)}`);
  a.at(HELPER_RTS).b(0x60).b(0x40).b(0x40);           // rts / rti / rti

  return {
    load: EXERCISER_ORG,
    bytes: Uint8Array.from(a.bytes),
    entry: EXERCISER_ORG,
    end,
    helpers: { rts: HELPER_RTS, irq: HELPER_IRQ, nmi: HELPER_NMI },
    scratch: SCRATCH,
    crossBase: CROSS_BASE,
    covered: [...new Set(covered)].sort((x, y) => x - y),
    crossing: [...new Set(crossing)].sort((x, y) => x - y),
    crossBranches,
  };
}

/**
 * §7.7 — the loop `e2e:861-static` prices statically, run under §7.1's
 * conditions so the measurement has nothing in it but the loop.
 *
 * The bytes are the gate's, to the byte: `ldx #$27 / lda $1000,x /
 * sta $0400,x / dex / bpl / rts`. It is page-aligned, so the branch does not
 * cross one, and the indexed read never leaves $1000-$1027 — which is what makes
 * 567 the exact answer rather than a span.
 */
export const STATIC_LOOP = [0xa2, 0x27, 0xbd, 0x00, 0x10, 0x9d, 0x00, 0x04, 0xca, 0x10, 0xf7, 0x60];
export const STATIC_LOOP_CYCLES = 567;

export function loopProgram({ displayOn = false } = {}) {
  const a = new Asm(EXERCISER_ORG);
  setup(a, { displayOn, vectors: null });
  const at = (a.pc + 0x100) & 0xff00;                 // the loop, page-aligned
  a.b(0x20, at & 0xff, at >> 8);                      // jsr loop
  const end = a.pc;
  a.jmpTo(end);
  a.at(at).b(...STATIC_LOOP);
  return { load: EXERCISER_ORG, bytes: Uint8Array.from(a.bytes), entry: EXERCISER_ORG, loopAt: at, loopEnd: at + STATIC_LOOP.length - 1, end };
}

/**
 * §7.4 — one `sta $D020` at a known raster line, once a frame, forever.
 *
 * The wait is `cmp $d012`, so the store happens a few cycles into the line it
 * waited for, and the delay loop after it makes sure the next pass cannot
 * trigger on the same line.
 */
export function rasterWriter({ line = 0x64 } = {}) {
  const a = new Asm(EXERCISER_ORG);
  a.b(0x78);                                  // sei
  a.lda(0x7f).sta(0xdc0d).sta(0xdd0d);
  a.b(0xad, 0x0d, 0xdc);
  a.b(0xad, 0x0d, 0xdd);
  a.lda(0x00).sta(0xd015);
  a.lda(0x1b).sta(0xd011);                    // display on, raster bit 8 clear
  const loop = a.pc;
  a.lda(line);                                // A is also what goes into $D020
  const wait = a.pc;
  a.b(0xcd, 0x12, 0xd0);                      // cmp $d012
  a.b(0xd0, (wait - (a.pc + 2)) & 0xff);      // bne wait
  a.sta(0xd020);                              // ← the store §7.4 looks for
  a.ldx(0x40);
  const delay = a.pc;
  a.b(0xca);                                  // dex
  a.b(0xd0, (delay - (a.pc + 2)) & 0xff);     // bne delay
  a.jmpTo(loop);
  return { load: EXERCISER_ORG, bytes: Uint8Array.from(a.bytes), entry: EXERCISER_ORG, line, storeAt: undefined };
}

/**
 * §7.3 — a raster interrupt, with the vector in RAM so the handler is the
 * program's own first instruction and not the KERNAL's.
 */
export function rasterIrq({ line = 0x64 } = {}) {
  const a = new Asm(EXERCISER_ORG);
  const HANDLER = 0xcd00;
  a.b(0x78);                                  // sei
  a.lda(0x7f).sta(0xdc0d).sta(0xdd0d);
  a.b(0xad, 0x0d, 0xdc);
  a.b(0xad, 0x0d, 0xdd);
  a.lda(0x00).sta(0xd015);
  a.lda(0x1b).sta(0xd011);                    // display on, raster bit 8 clear
  a.lda(line).sta(0xd012);
  a.lda(0x01).sta(0xd01a);                    // raster interrupt on
  a.lda(0xff).sta(0xd019);                    // acknowledge whatever is pending
  a.lda(0x35).staz(0x01);                     // I/O in, both ROMs out: $FFFE is ours
  a.lda(HANDLER & 0xff).sta(0xfffe);
  a.lda(HANDLER >> 8).sta(0xffff);
  a.lda(HANDLER & 0xff).sta(0xfffa);          // an NMI would otherwise land in RAM noise
  a.lda(HANDLER >> 8).sta(0xfffb);
  a.b(0x58);                                  // cli
  const loop = a.pc;
  a.jmpTo(loop);
  a.at(HANDLER);
  a.b(0xee, 0x20, 0xd0);                      // inc $d020   ← the handler's first instruction
  a.lda(0xff).sta(0xd019);                    // acknowledge
  a.b(0x40);                                  // rti
  return { load: EXERCISER_ORG, bytes: Uint8Array.from(a.bytes), entry: EXERCISER_ORG, handler: HANDLER, line, loop };
}

/** A PRG with a BASIC line that SYSes into it, so a LOAD"…",8 + RUN starts it. */
export function withBasicStub(program) {
  const sys = String(program.entry);
  const line = [0x9e, ...[...sys].map((c) => c.charCodeAt(0)), 0x00];
  const next = 0x0801 + 4 + line.length;
  const basic = [next & 0xff, next >> 8, 0x0a, 0x00, ...line, 0x00, 0x00];
  // The BASIC stub and the program are not contiguous, so this is two files in
  // one PRG only if the loader honours the gap. It does not — so the stub is
  // its own PRG and the program is loaded by the caller at its own address.
  return Uint8Array.from([0x01, 0x08, ...basic]);
}
