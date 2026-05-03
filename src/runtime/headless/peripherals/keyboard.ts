// C64 keyboard matrix model + scriptable input queue (Sprint 79).
//
// Real C64 has an 8×8 key matrix scanned by CIA1: PA = column drive
// (active low), PB = row read (active low). Each key intersection has
// a row+col coordinate.
//
// Sprint 79 scope: queueable key presses with hold duration. Caller
// pushes (key, holdCycles) tuples; we honour them as the C64's CIA1
// scan reads.
//
// Approach: each "scan tick" the queue advances. While a key is
// active, CIA1 PB reads return $FF with the key's row bit cleared
// for the column the CIA is currently driving (PA active-low pulled
// column → PB active-low row bit pulled if key pressed at that
// intersection).

// Subset of the standard PETSCII → matrix coordinate map. Extend per
// game need. Coordinates are (row, col) 0-based.
const KEY_MATRIX: Record<string, [number, number]> = {
  // Row 0
  RUN_STOP: [7, 7], "Q": [7, 6], C_EQ: [7, 5], SPACE: [7, 4],
  "2": [7, 3], CTRL: [7, 2], LARROW: [7, 1], "1": [7, 0],
  // Row 1
  "/": [6, 7], UP_ARROW: [6, 6], "=": [6, 5], R_SHIFT: [6, 4],
  HOME: [6, 3], ";": [6, 2], "*": [6, 1], "POUND": [6, 0],
  // Row 2
  ",": [5, 7], "@": [5, 6], ":": [5, 5], ".": [5, 4],
  "-": [5, 3], "L": [5, 2], "P": [5, 1], "+": [5, 0],
  // Row 3
  "N": [4, 7], "O": [4, 6], "K": [4, 5], "M": [4, 4],
  "0": [4, 3], "J": [4, 2], "I": [4, 1], "9": [4, 0],
  // Row 4
  "V": [3, 7], "U": [3, 6], "H": [3, 5], "B": [3, 4],
  "8": [3, 3], "G": [3, 2], "Y": [3, 1], "7": [3, 0],
  // Row 5
  "X": [2, 7], "T": [2, 6], "F": [2, 5], "C": [2, 4],
  "6": [2, 3], "D": [2, 2], "R": [2, 1], "5": [2, 0],
  // Row 6
  L_SHIFT: [1, 7], "E": [1, 6], "S": [1, 5], "Z": [1, 4],
  "4": [1, 3], "A": [1, 2], "W": [1, 1], "3": [1, 0],
  // Row 7
  CRSR_DN: [0, 7], F5: [0, 6], F3: [0, 5], F1: [0, 4],
  F7: [0, 3], CRSR_RT: [0, 2], RETURN: [0, 1], DEL: [0, 0],
};

export type KeyName = keyof typeof KEY_MATRIX | string;

export interface KeyEvent {
  key: KeyName;
  // Cycle when the press starts.
  startCycle: number;
  // Cycle when the press ends.
  endCycle: number;
}

export class KeyboardMatrix {
  private events: KeyEvent[] = [];
  private cycleNow = 0;

  // Queue a key press starting from now for `holdCycles` cycles.
  // Convenience helper for "press a key for ~50ms": holdCycles ~50000.
  pressKey(key: KeyName, holdCycles: number = 50000, delayCycles: number = 0): void {
    const start = this.cycleNow + delayCycles;
    this.events.push({ key, startCycle: start, endCycle: start + holdCycles });
  }

  // Type a string of keys sequentially with default 50000 cycle hold +
  // 10000 cycle gap between each.
  typeText(text: string, holdCycles: number = 50000, gapCycles: number = 10000): void {
    let off = 0;
    for (const ch of text) {
      const key = ch === " " ? "SPACE" : (ch === "\n" || ch === "\r") ? "RETURN" : ch.toUpperCase();
      const start = this.cycleNow + off;
      this.events.push({ key, startCycle: start, endCycle: start + holdCycles });
      off += holdCycles + gapCycles;
    }
  }

  // Advance current time. Called by integrated session per CPU step.
  advance(cycles: number): void {
    this.cycleNow += cycles;
  }

  // Active row bits for given column (active-low = 0 = pressed).
  // CIA1 PA write selects column (column N driven low if PA bit N = 0).
  // CIA1 PB read returns row bits ANDed across all selected columns.
  readRowsForPa(paValue: number): number {
    let rowMask = 0xff; // all rows high (= no key pressed)
    for (const ev of this.events) {
      if (this.cycleNow < ev.startCycle || this.cycleNow >= ev.endCycle) continue;
      const coord = KEY_MATRIX[ev.key];
      if (!coord) continue;
      const [row, col] = coord;
      // Column N is "selected" if PA bit N = 0 (active-low column drive).
      if ((paValue & (1 << col)) === 0) {
        rowMask &= ~(1 << row);
      }
    }
    return rowMask;
  }

  resetClock(): void {
    this.cycleNow = 0;
  }
}
