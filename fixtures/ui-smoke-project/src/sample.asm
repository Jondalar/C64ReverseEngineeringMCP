// fixtures/ui-smoke-project/src/sample.asm
//
// Tiny synthetic PRG for the workspace UI smoke fixture.
// Prints "HELLO C64RE" via KERNAL CHROUT ($FFD2) and busy-loops.
// Hand-assembled so the byte layout is committed alongside this source
// without a build dependency. See fixtures/ui-smoke-project/input/prg/
// sample.prg for the materialized bytes.
//
// BASIC SYS 2062 stub launches code at $080E.

* = $0801
.byte $0C, $08          // next-line ptr -> $080C
.byte $0A, $00          // line number 10
.byte $9E               // BASIC SYS token
.byte $20               // space
.byte $32, $30, $36, $32 // "2062"
.byte $00               // end-of-line
.byte $00, $00          // end-of-program

* = $080E
        ldx #$00
print:  lda hello,x
        beq park
        jsr $FFD2
        inx
        bne print
park:   jmp park
        .byte $EA, $EA  // padding to align text at $0820
* = $0820
hello:  .text "HELLO C64RE"
        .byte $00
