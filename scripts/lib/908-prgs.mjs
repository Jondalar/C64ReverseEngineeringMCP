// The synthetic program for the Spec 908 e2e: an image that spans $0801-$EFFF, so $D000-$DFFF is
// INSIDE it (the case of four real games: they run with $01 = $35 and keep sprite data under the
// I/O window), whose code touches the registers of every chip. Built from a listing
// (asm6502-mini.mjs); nothing here is anybody's code.
import { assembleWithLabels } from "./asm6502-mini.mjs";

const LOAD = 0x0801;
const LAST = 0xefff;
const ORIGIN = 0x080d; // after the `10 SYS2061` stub

/**
 * main  reads and writes the registers of the VIC-II, SID, CIA 1, CIA 2 and colour RAM, a mirror
 *       ($D051 = $D011 + 64), a cell of colour RAM ($D828), an indexed access ($D800,X) and an address
 *       the chip has no register at ($D030), then calls dep.
 * dep   a depacker: stores under the I/O window with $01 at $34, so those stores are RAM. It calls
 *       help, which is a routine of its own: its store to $D012 is NOT dep's, and stays a register.
 * The bytes between the code and $EFFF are zero, except $D200-$D23F, which hold a sprite.
 */
export function ioWindowPrg() {
  const prog = [
    "main:",
    "LDX #$00",
    "LDA $D011", "STA $D020", "STA $D418", "LDA $DC0D", "STA $DD00",
    "LDA $D051",
    "STA $D828", "STA $D800,X",
    "STA $D030",
    "JSR dep",
    "RTS",
    "dep:",
    "LDA #$00",
    "STA $D011", "STA $D400,X", "JSR help",
    "RTS",
    "help:",
    "STA $D012",
    "RTS",
  ];
  const { bytes, labels } = assembleWithLabels(ORIGIN, prog);
  const stub = [0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  const body = Buffer.alloc(LAST - LOAD + 1, 0);
  Buffer.from(stub).copy(body, 0);
  Buffer.from(bytes).copy(body, ORIGIN - LOAD);
  for (let i = 0; i < 0x40; i += 1) body[0xd200 - LOAD + i] = i % 2 === 0 ? 0xaa : 0x55;
  const prg = Buffer.concat([Buffer.from([LOAD & 0xff, LOAD >> 8]), body]);
  return { prg, labels, load: LOAD, last: LAST };
}
