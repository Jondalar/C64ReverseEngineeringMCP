// Spec 862 §7.3 and §7.4 — the program the acceptance gates run on a machine.
//
// One program, four routines, each there to be a fact rather than an example:
//
//   hot    `clc / clc / rts`   — two cycles to save, called ten times a pass
//   cold   `jsr plain / rts`   — nine cycles to save, called ONCE in the capture
//   plain  `lda #$00 / rts`    — the callee `cold`'s tail call goes to
//   pager  a page-crossing copy loop — 24 of its 40 iterations cross, by
//          construction: the table is at $10F0 and the index runs $27 → $00,
//          so every index from $10 up leaves the page.
//
// §7.3 wants the small saving in the often-run routine to outrank the large one
// in code that runs once, and that only means anything if "once" is really
// once. So the program waits for a key before it does anything: the capture
// window opens on the key, `cold` runs on the first instruction after it, and
// the main loop runs for the rest of the window. Without the wait the single
// call would be a hundred frames behind the recording.
//
// The display is off, as in 861 §7.1's conditions: no bad lines, so measured
// equals static and a page crossing is the only thing that can add a cycle.

import { Asm, setup, EXERCISER_ORG } from "./spec861-programs.mjs";

/** How many iterations of `pager`'s loop cross a page — from the index values. */
export const PAGER_TABLE = 0x10f0;
export const PAGER_SEED = 0x27;
export const PAGER_CROSSINGS = (() => {
  let n = 0;
  for (let x = 0; x <= PAGER_SEED; x += 1) if (((PAGER_TABLE & 0xff) + x) > 0xff) n += 1;
  return n;
})();

export const HOT_CALLS_PER_PASS = 10;

export function candidateProgram() {
  const a = new Asm(EXERCISER_ORG);
  setup(a, { displayOn: false, vectors: null });

  // Fixed up once the routines below have addresses.
  const coldCall = a.pc;
  a.b(0x20, 0x00, 0x00);                       // jsr cold
  const main = a.pc;
  const hotCalls = [];
  for (let i = 0; i < HOT_CALLS_PER_PASS; i += 1) { hotCalls.push(a.pc); a.b(0x20, 0x00, 0x00); }
  const pagerCall = a.pc;
  a.b(0x20, 0x00, 0x00);                       // jsr pager
  a.jmpTo(main);

  const hot = a.pc;
  a.b(0x18, 0x18, 0x60);                       // clc / clc / rts
  const cold = a.pc;
  const plainCall = a.pc;
  a.b(0x20, 0x00, 0x00, 0x60);                 // jsr plain / rts
  const plain = a.pc;
  a.b(0xa9, 0x00, 0x60);                       // lda #$00 / rts

  // The loop starts on a page, so its branch never crosses one and the only
  // variable cycle left in the whole program is the indexed read's.
  const pager = (a.pc + 0x100) & 0xff00;
  a.at(pager);
  a.b(0xa2, PAGER_SEED);                       // ldx #$27
  const loop = a.pc;
  a.b(0xbd, PAGER_TABLE & 0xff, PAGER_TABLE >> 8);  // lda $10F0,x
  a.b(0x9d, 0x00, 0x04);                       // sta $0400,x
  a.b(0xca);                                   // dex
  a.b(0x10, (loop - (a.pc + 2)) & 0xff);       // bpl loop
  a.b(0x60);                                   // rts
  const pagerEnd = a.pc - 1;

  const put = (at, target) => {
    a.bytes[at - EXERCISER_ORG + 1] = target & 0xff;
    a.bytes[at - EXERCISER_ORG + 2] = target >> 8;
  };
  put(coldCall, cold);
  for (const at of hotCalls) put(at, hot);
  put(pagerCall, pager);
  put(plainCall, plain);

  return {
    load: EXERCISER_ORG,
    bytes: Uint8Array.from(a.bytes),
    entry: EXERCISER_ORG,
    main,
    routines: [
      { label: "hot", start: hot, end: hot + 2 },
      { label: "cold", start: cold, end: cold + 3 },
      { label: "plain", start: plain, end: plain + 2 },
      { label: "pager", start: pager, end: pagerEnd },
    ],
    /** the instruction §7.4 counts crossings at */
    indexedReadAt: loop,
    /** the `clc` §7.3's candidate removes */
    hotCandidateAt: hot + 1,
    coldCandidateAt: cold,
  };
}
