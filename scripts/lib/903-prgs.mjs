// The synthetic program for the Spec 903 e2e: one split table of each shape the detector knows,
// an RTS table, a table whose targets have no name, and a pair that is not a pointer table at all.
// Built from a listing (asm6502-mini.mjs); nothing here is anybody's code.
import { assembleWithLabels } from "./asm6502-mini.mjs";

const ORIGIN = 0x080d; // after the `10 SYS2061` stub

/**
 * Routines (each reached by a JSR from `main`, so the code is confirmed):
 *   rz  LDA tz_lo,X / STA $FB / LDA tz_hi,X / STA $FC / JMP ($FB)      CPX #3 bounds X    -> zp_pointer, countHint 3
 *   rm  LDA ts_lo,X / STA patch+1 / LDA ts_hi,X / STA patch+2 / patch: JSR $0000            -> self_mod_operand
 *   rr  LDA tr_hi,X / PHA / LDA tr_lo,X / PHA / RTS                                          -> rts_dispatch (adjust 1)
 *   rf  LDA tf_lo,X / STA $FD / LDA tf_hi,X / STA $FE / LDA ($FD),Y — read through the pointer -> zp_pointer, NOT an address table (text)
 *   rb  LDA tb_lo,X / STA $F7 / LDA tb_hi,X / STA $F8 / JMP ($F7)       targets inside `blob` -> declared with `base`
 *   rx  the same, targets in RAM outside the image ($C1xx)                                   -> bare-address fallback
 */
export function splitTablePrg() {
  const prog = [
    "main:",
    "LDX #$00",
    "JSR rz", "JSR rm", "JSR rr", "JSR rf", "JSR rb", "JSR rx",
    "RTS",
    // ---- zero-page pointer, bounded by CPX #3
    "rz:",
    "CPX #$03", "BCS rzend",
    "LDA tz_lo,X", "STA $FB", "LDA tz_hi,X", "STA $FC", "JMP ($00FB)",
    "rzend:", "RTS",
    // ---- patched operand
    "rm:",
    "LDA ts_lo,X", "STA patch+1", "LDA ts_hi,X", "STA patch+2",
    "patch:", "JSR $0000", "RTS",
    // ---- RTS dispatch
    "rr:",
    "LDA tr_hi,X", "PHA", "LDA tr_lo,X", "PHA", "RTS",
    // ---- not a pointer table: the same shape over two byte tables the code only copies
    "rf:",
    "LDA tf_lo,X", "STA $FD", "LDA tf_hi,X", "STA $FE", "LDY #$00", "LDA ($FD),Y", "STA $C000", "RTS",
    // ---- targets without names, inside a data blob
    "rb:",
    "LDA tb_lo,X", "STA $F7", "LDA tb_hi,X", "STA $F8", "JMP ($00F7)",
    // ---- targets outside the image
    "rx:",
    "LDA tx_lo,X", "STA $F5", "LDA tx_hi,X", "STA $F6", "JMP ($00F5)",
    // ---- handlers (reached only through the tables)
    "zh0:", "INC $C000", "RTS",
    "zh1:", "INC $C001", "RTS",
    "zh2:", "INC $C002", "RTS",
    "sh0:", "INC $C010", "RTS",
    "sh1:", "INC $C011", "RTS",
    "rh0:", "INC $C020", "RTS",
    "rh1:", "INC $C021", "RTS",
    "rh2:", "INC $C022", "RTS",
    // ---- the data
    "blob:", ".byte $01, $02, $03, $04, $05, $06, $07, $08, $09, $0A, $0B, $0C",
    "tz_lo:", ".byte <zh0, <zh1, <zh2",
    "tz_hi:", ".byte >zh0, >zh1, >zh2",
    "ts_lo:", ".byte <sh0, <sh1",
    "ts_hi:", ".byte >sh0, >sh1",
    "tr_lo:", ".byte <rh0-1, <rh1-1, <rh2-1",
    "tr_hi:", ".byte >rh0-1, >rh1-1, >rh2-1",
    "tf_lo:", ".byte $48, $45, $4C, $4C",
    "tf_hi:", ".byte $4F, $20, $57, $52",
    "tb_lo:", ".byte <blob, <blob+4, <blob+8",
    "tb_hi:", ".byte >blob, >blob+4, >blob+8",
    "tx_lo:", ".byte $00, $00",
    "tx_hi:", ".byte $C1, $C2",
    "end:",
  ];
  const { bytes, labels } = assembleWithLabels(ORIGIN, prog);
  const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  return { prg: Buffer.from([...stub, ...bytes]), labels, origin: ORIGIN };
}

/**
 * A program whose zero-page pairs are loaded from two tables, to tell the pairs that ARE pointers from the ones that
 * only hold two byte values (a column and a row, a width and a height):
 *   rc  pair -> $12/$13, JSR rcdraw which only reads the two bytes                   -> not a pointer
 *   rw  pair -> $06/$07, then the loop code reads them as counters                   -> not a pointer
 *   rq  pair -> $16/$17, both cells overwritten, THEN ($16),Y                         -> not a pointer (the new value is)
 *   rp  pair -> $14/$15, JSR rpuse which does LDA ($14),Y                            -> a pointer, used in the callee
 *   rb  pair -> $18/$19, BEQ over a ($18),Y read                                      -> a pointer, used on one branch arm
 * `withPointers: false` leaves rp and rb out: a program whose only pairs are not pointers.
 */
export function pairUsePrg({ withPointers = true } = {}) {
  const prog = [
    "main:",
    "LDX #$00",
    "JSR rc", "JSR rw", "JSR rq",
    ...(withPointers ? ["JSR rp", "JSR rb"] : []),
    "RTS",
    "rc:", "LDA tc_lo,X", "STA $12", "LDA tc_hi,X", "STA $13", "JSR rcdraw", "RTS",
    "rcdraw:", "LDA $12", "STA $C030", "LDA $13", "STA $C031", "RTS",
    "rw:", "LDA tw_lo,X", "STA $06", "LDA tw_hi,X", "STA $07", "LDA $06", "STA $C040", "LDA $07", "STA $C041", "RTS",
    "rq:", "LDA tq_lo,X", "STA $16", "LDA tq_hi,X", "STA $17", "LDA #$00", "STA $16", "STA $17", "LDY #$00", "LDA ($16),Y", "STA $C060", "RTS",
    ...(withPointers ? [
      "rp:", "LDA tp_lo,X", "STA $14", "LDA tp_hi,X", "STA $15", "JSR rpuse", "RTS",
      "rpuse:", "LDY #$00", "LDA ($14),Y", "STA $C050", "RTS",
      "rb:", "LDA tb_lo,X", "STA $18", "LDA tb_hi,X", "STA $19", "BEQ rbend", "LDY #$00", "LDA ($18),Y", "STA $C070", "rbend:", "RTS",
    ] : []),
    "tc_lo:", ".byte $05, $0A", "tc_hi:", ".byte $03, $07",
    "tw_lo:", ".byte $04, $08", "tw_hi:", ".byte $02, $06",
    "tq_lo:", ".byte $31, $32", "tq_hi:", ".byte $41, $42",
    ...(withPointers ? [
      "tp_lo:", ".byte $00, $10", "tp_hi:", ".byte $C2, $C2",
      "tb_lo:", ".byte $20, $30", "tb_hi:", ".byte $C3, $C3",
    ] : []),
    "end:",
  ];
  const { bytes, labels } = assembleWithLabels(ORIGIN, prog);
  const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  return { prg: Buffer.from([...stub, ...bytes]), labels, origin: ORIGIN };
}
