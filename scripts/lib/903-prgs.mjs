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
 *   rf  LDA tf_lo,X / STA $FD / LDA tf_hi,X / STA $FE / LDA ($FD),Y-ish read                -> zp_pointer, NOT a pointer table
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
    "LDA tf_lo,X", "STA $FD", "LDA tf_hi,X", "STA $FE", "LDA $FD", "STA $C000", "RTS",
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
