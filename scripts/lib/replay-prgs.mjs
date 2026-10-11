// The synthetic PRG for the replay-determinism e2e: the reporter's program (issue #67, retest).
import { prgWithStub } from "./asm6502-mini.mjs";

/**
 * A raster IRQ at line $80 refreshes $FB ($01) every frame. After a joystick-2 fire press the main
 * code does lda $D011 / ora #$10 / sta $D011 and clears $FB once. Bit 7 of $D011 reads the beam's
 * line bit 8 and writes the IRQ line's bit 8, so a press with the beam at line 256 or below moves
 * the IRQ to line $180 — never reached — and $FB then stays $00: the check `$FB is $01` fails.
 */
export function replayPrg() {
  return prgWithStub([
    "SEI",
    "LDA #$7F", "STA $DC0D", "STA $DD0D", "LDA $DC0D", "LDA $DD0D",
    "LDA #$35", "STA $01",
    "LDA #<irq", "STA $FFFE", "LDA #>irq", "STA $FFFF",
    "LDA #$00", "STA $FB",
    "LDA #$1B", "STA $D011",
    "LDA #$80", "STA $D012",
    "LDA #$01", "STA $D01A",
    "LDA $D019", "STA $D019",
    "CLI",
    "poll:", "LDA $DC00", "AND #$10", "BNE poll",
    "LDA $D011", "ORA #$10", "STA $D011",
    "LDA #$00", "STA $FB",
    "done:", "JMP done",
    "irq:", "PHA", "LDA #$01", "STA $FB", "STA $D019", "PLA", "RTI",
  ]);
}
