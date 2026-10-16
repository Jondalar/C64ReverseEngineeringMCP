// Synthetic programs and fixes for the feature-run gates. Built here, byte by byte; no third-party bytes.
//
//   pollPrg()   a PRG that clears $C300, plants an RTS at $C100 (the "lift" hook), waits for joystick 2 DOWN,
//               calls the hook, sets $C000 := $01 and spins. `poll` is where the machine waits.
//   efCrt()     an EasyFlash image whose boot code (ROMH bank 0 -> ROML bank 0, mirrored into bank 3) selects bank 3
//               and loops there, calling a hook in RAM ($0A20) and one in the bank ($9100), counting at $0300.
//   FIXES       the sources the variant lines name (64tass syntax).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assemble, assembleWithLabels } from "./asm6502-mini.mjs";

const STUB = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];

export function pollPrg() {
  const { bytes, labels } = assembleWithLabels(0x080d, [
    "LDA #$60", "STA $C100", "LDA #$00", "STA $C000", "STA $C300",
    "poll:", "LDA $DC00", "AND #$02", "BNE poll",
    "JSR $C100", "LDA #$01", "STA $C000",
    "done:", "JMP done",
  ]);
  return { prg: Buffer.from([...STUB, ...bytes]), poll: labels.poll, done: labels.done };
}

const pad = (arr) => { const b = Buffer.alloc(0x2000, 0xff); Buffer.from(arr).copy(b); return b; };
const vectors = (b) => { for (const o of [0x1ffa, 0x1ffc, 0x1ffe]) { b[o] = 0x00; b[o + 1] = 0xe0; } return b; };

/** The image and where its parts are. */
export function efCrt() {
  const romhBoot = () => vectors(pad([0x78, 0xa2, 0xff, 0x9a, 0x4c, 0x00, 0x81])); // SEI LDX #$FF TXS JMP $8100
  const tramp = assemble(0x8100, ["LDA #$60", "STA $0A20", "LDA #$03", "STA $DE00", "JMP $9000"]);
  const main = assemble(0x9000, ["loop:", "JSR $0A20", "JSR $9100", "INC $0300", "JMP loop"]);
  const roml0 = pad([]); Buffer.from(tramp).copy(roml0, 0x100);
  // the bank register switches ROML AND ROMH at once: the trampoline is in bank 3 too, at the same place
  const roml3 = pad([]); Buffer.from(tramp).copy(roml3, 0x100); Buffer.from(main).copy(roml3, 0x1000); roml3[0x1100] = 0x60;
  const chips = [];
  for (const b of [{ bank: 0, roml: roml0, romh: romhBoot() }, { bank: 3, roml: roml3, romh: romhBoot() }]) {
    for (const [load, data] of [[0x8000, b.roml], [0xa000, b.romh]]) {
      const h = Buffer.alloc(0x10);
      h.write("CHIP", 0, "ascii"); h.writeUInt32BE(0x10 + 0x2000, 4); h.writeUInt16BE(2, 8);
      h.writeUInt16BE(b.bank, 0x0a); h.writeUInt16BE(load, 0x0c); h.writeUInt16BE(0x2000, 0x0e);
      chips.push(Buffer.concat([h, data]));
    }
  }
  const hdr = Buffer.alloc(0x40);
  hdr.write("C64 CARTRIDGE   ", 0, "ascii"); hdr.writeUInt32BE(0x40, 0x10); hdr.writeUInt16BE(0x0100, 0x14);
  hdr.writeUInt16BE(32, 0x16); hdr[0x18] = 1; hdr[0x19] = 0; hdr.write("FIXTEST", 0x20, "ascii");
  return Buffer.concat([hdr, ...chips]);
}

export const FIXES = {
  // reaches $C102, sets the border, $C300 and $C301
  "fix1.tas": "* = $c100\n        lda #$05\n        sta $d020\n        lda #$77\n        sta $c300\n        sta $c301\n        rts\n",
  // reaches $C102, sets another border, leaves $C300 alone
  "fix2.tas": "* = $c100\n        lda #$02\n        sta $d020\n        rts\n",
  // the same byte the program planted there itself: no difference to the baseline
  "noop.tas": "* = $c100\n        rts\n",
  // the cartridge-side hooks
  "ramfix.tas": "* = $0a20\n        lda #$2a\n        sta $0310\n        rts\n",
  "romfix.tas": "* = $9100\n        lda #$55\n        sta $0311\n        rts\n",
};

export function writeFixes(dir) {
  for (const [name, text] of Object.entries(FIXES)) {
    const f = join(dir, "fixes", name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}

export const hex2 = (n) => `$${n.toString(16).toUpperCase().padStart(2, "0")}`;
export const hex4 = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
