// The test game for the state-map gates: four rooms, built here from source of its own (64tass), no third-party bytes.
//
//   $02  the room, 0..3          joystick 2 left / right move one room (not past either end)
//   $03  the goal flag           fire in room 3 sets it to 1
//   $04  the joystick bits of the frame before, $05 the bits that are new this frame (a move happens on the edge)
//   $0A/$0B  a 16-bit hash of every frame's stick bits (x := 5x + bits + 1): bytes a key must not contain, every move changes them
//   down in room 2 jumps to a JAM opcode at $085F
//
// The loop waits for the raster at line $FA once per frame, reads the stick, acts, and writes the room and flag as
// two digits at $0400/$0401. `loop` is where the machine waits: the anchor is set there.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "./e2e-906-harness.mjs";

export const MAZE_SOURCE = `
        * = $0801
        .word (+), 2026
        .text $9e, "2061", 0
+       .word 0

        * = $080d
start   sei
        lda #0
        sta $02
        sta $03
        sta $04
        sta $05
        sta $0a
        sta $0b
        jmp loop

        * = $085f
crash   .byte $02

        * = $0870
loop
-       lda $d012
        cmp #$fa
        bne -
-       lda $d012
        cmp #$fa
        beq -

        lda $dc00
        eor #$ff
        and #$1f
        tax
        lda $04
        eor #$ff
        and #$1f
        sta $06
        txa
        sta $04
        and $06
        sta $05
        lda $0a
        sta $0c
        lda $0b
        sta $0d
        asl $0a
        rol $0b
        asl $0a
        rol $0b
        clc
        lda $0a
        adc $0c
        sta $0a
        lda $0b
        adc $0d
        sta $0b
        sec
        lda $0a
        adc $04
        sta $0a
        bcc nocarry
        inc $0b
nocarry

        lda $05
        and #$04
        beq noleft
        lda $02
        beq noleft
        dec $02
noleft  lda $05
        and #$08
        beq noright
        lda $02
        cmp #3
        beq noright
        inc $02
noright lda $05
        and #$02
        beq nodown
        lda $02
        cmp #2
        bne nodown
        jmp crash
nodown  lda $05
        and #$10
        beq nofire
        lda $02
        cmp #3
        bne nofire
        lda #1
        sta $03
nofire  lda $02
        ora #$30
        sta $0400
        lda $03
        ora #$30
        sta $0401
        jmp loop
`;

/** Assemble the maze in `dir`; returns the PRG bytes, the address of \`loop\` and of the JAM. */
export async function buildMaze(dir) {
  const { assembleSource } = await load("assemble-source.js");
  mkdirSync(join(dir, "src"), { recursive: true });
  const src = join(dir, "src", "maze.tas");
  writeFileSync(src, MAZE_SOURCE);
  const out = join(dir, "build", "maze.prg");
  const r = await assembleSource({ projectDir: dir, sourcePath: src, assembler: "64tass", outputPath: out, symbols: true });
  if (r.exitCode !== 0) throw new Error(`64tass failed: ${r.stderr || r.stdout}`);
  const vs = r.symbolsPath ? readFileSync(r.symbolsPath, "utf8") : "";
  const label = (name) => {
    const m = new RegExp(`^al\\s+([0-9a-f]+)\\s+\\.${name}\\s*$`, "im").exec(vs);
    if (!m) throw new Error(`label ${name} not in the symbol file`);
    return parseInt(m[1], 16);
  };
  return { prgPath: out, prg: readFileSync(out), loop: label("loop"), crash: label("crash") };
}

/** A program whose only state is a frame counter at $02: whatever the stick does, the next frame is the next number. */
export const COUNTER_SOURCE = `
        * = $0801
        .word (+), 2026
        .text $9e, "2061", 0
+       .word 0

        * = $080d
        sei
        lda #0
        sta $02
loop
-       lda $d012
        cmp #$fa
        bne -
-       lda $d012
        cmp #$fa
        beq -
        inc $02
        jmp loop
`;

export async function buildCounter(dir) {
  const { assembleSource } = await load("assemble-source.js");
  mkdirSync(join(dir, "src"), { recursive: true });
  const src = join(dir, "src", "counter.tas");
  writeFileSync(src, COUNTER_SOURCE);
  const out = join(dir, "build", "counter.prg");
  const r = await assembleSource({ projectDir: dir, sourcePath: src, assembler: "64tass", outputPath: out, symbols: true });
  if (r.exitCode !== 0) throw new Error(`64tass failed: ${r.stderr || r.stdout}`);
  const vs = readFileSync(r.symbolsPath, "utf8");
  const m = /^al\s+([0-9a-f]+)\s+\.loop\s*$/im.exec(vs);
  return { prg: readFileSync(out), loop: parseInt(m[1], 16) };
}
