// Synthetic PRGs for the Spec 899 e2e, built from listings (see asm6502-mini.mjs).
import { prgWithStub } from "./asm6502-mini.mjs";

const CIA_OFF_AND_IRQ_VECTOR = [
  "SEI",
  "LDA #$7F", "STA $DC0D", "STA $DD0D", "LDA $DC0D", "LDA $DD0D",   // no CIA interrupts
  "LDA #$35", "STA $01",                                            // I/O on, ROMs off: $FFFE is RAM
  "LDA #<irq", "STA $FFFE", "LDA #>irq", "STA $FFFF",
];
const RASTER_IRQ_AT_100 = [
  "LDA #$1B", "STA $D011",                                          // the KERNAL leaves $9B: bit 7 would make the line 356
  "LDA #$64", "STA $D012",                                          // line 100
  "LDA #$01", "STA $D01A",
  "LDA $D019", "STA $D019",
];

/**
 * The $D011 case (issue #67): a raster IRQ is armed for line 100, then a fire press runs a
 * read-modify-write of $D011. Bit 7 READS the beam's line bit 8 but WRITES the IRQ line's
 * bit 8, so a press with the beam at line 256 or below leaves the IRQ at line 356 — which a
 * PAL frame never reaches — and the IRQ is dead.
 *
 * $C000 counts IRQs. After the write the main program waits up to ~6 frames for $C000 to
 * move: $C002 = $01 when the IRQ still runs, $FF when it does not.
 *   rmw: "fault" lda/ora/sta · "heal" lda/and #$7F/ora/sta · "direct" lda #$1B / sta
 */
export function d011Prg(rmw) {
  const write = {
    fault: ["LDA $D011", "ORA #$10", "STA $D011"],
    heal: ["LDA $D011", "AND #$7F", "ORA #$10", "STA $D011"],
    direct: ["LDA #$1B", "STA $D011"],
  }[rmw];
  if (!write) throw new Error(`no such rmw ${rmw}`);
  return prgWithStub([
    ...CIA_OFF_AND_IRQ_VECTOR,
    "LDA #$00", "STA $C000", "STA $C002",
    ...RASTER_IRQ_AT_100,
    "CLI",
    "poll:", "LDA $DC00", "AND #$10", "BNE poll",                   // joystick 2 fire, low when pressed
    ...write,
    "LDA $C000", "STA $FB",
    "LDX #$00", "LDY #$00",
    "wait:", "LDA $C000", "CMP $FB", "BNE alive",
    "INX", "BNE wait",
    "INY", "CPY #$20", "BNE wait",
    "LDA #$FF", "STA $C002",
    "dead:", "JMP dead",
    "alive:", "LDA #$01", "STA $C002",
    "done:", "JMP done",
    "irq:", "PHA", "INC $C000", "LDA #$01", "STA $D019", "PLA", "RTI",
  ]);
}

/**
 * A register held at a wrong value for 3 frames out of every 200: the IRQ (line 100, once a
 * frame) counts 0..199 in $FB and writes $D01C — the sprite multicolour enable — as $04,
 * except for counts 100, 101 and 102, where it writes $00. `glitch: false` never does.
 */
export function glitchPrg(glitch) {
  return prgWithStub([
    ...CIA_OFF_AND_IRQ_VECTOR,
    "LDA #$00", "STA $FB",
    "LDA #$04", "STA $D01C",
    ...RASTER_IRQ_AT_100,
    "CLI",
    "idle:", "JMP idle",
    "irq:", "PHA",
    "INC $FB", "LDA $FB", "CMP #200", "BNE ok", "LDA #$00", "STA $FB",
    "ok:",
    ...(glitch
      ? ["LDA $FB", "SEC", "SBC #100", "CMP #3", "BCC bad", "LDA #$04", "JMP set", "bad:", "LDA #$00", "set:"]
      : ["LDA #$04"]),
    "STA $D01C",
    "LDA #$01", "STA $D019",
    "PLA", "RTI",
  ]);
}
