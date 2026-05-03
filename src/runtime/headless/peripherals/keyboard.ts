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

// PETSCII → matrix coordinate map. Coordinates are (col, row) 0-based.
// (Original comment incorrectly said (row, col) — all entries are
// actually [col, row] which is what `readRowsForPa` consumes.)
// Real C64 hardware: PA = column drive (active-low), PB = row read
// (active-low). Scan codes computed by SCNKEY = (col * 8) + row.
const KEY_MATRIX: Record<string, [number, number]> = {
  // Col 7 (PA bit 7 driven low — KERNAL scan code group 56-63)
  RUN_STOP: [7, 7], "Q": [7, 6], C_EQ: [7, 5], SPACE: [7, 4],
  "2": [7, 3], CTRL: [7, 2], LARROW: [7, 1], "1": [7, 0],
  // Col 6
  "/": [6, 7], UP_ARROW: [6, 6], "=": [6, 5], R_SHIFT: [6, 4],
  HOME: [6, 3], ";": [6, 2], "*": [6, 1], "POUND": [6, 0],
  // Col 5
  ",": [5, 7], "@": [5, 6], ":": [5, 5], ".": [5, 4],
  "-": [5, 3], "L": [5, 2], "P": [5, 1], "+": [5, 0],
  // Col 4
  "N": [4, 7], "O": [4, 6], "K": [4, 5], "M": [4, 4],
  "0": [4, 3], "J": [4, 2], "I": [4, 1], "9": [4, 0],
  // Col 3
  "V": [3, 7], "U": [3, 6], "H": [3, 5], "B": [3, 4],
  "8": [3, 3], "G": [3, 2], "Y": [3, 1], "7": [3, 0],
  // Col 2
  "X": [2, 7], "T": [2, 6], "F": [2, 5], "C": [2, 4],
  "6": [2, 3], "D": [2, 2], "R": [2, 1], "5": [2, 0],
  // Col 1
  L_SHIFT: [1, 7], "E": [1, 6], "S": [1, 5], "Z": [1, 4],
  "4": [1, 3], "A": [1, 2], "W": [1, 1], "3": [1, 0],
  // Col 0
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
  // 10000 cycle gap between each. Sprint 93.1: PETSCII-aware mapping
  // with auto-SHIFT for shifted-only characters (`"`, `?`, `(`, `)` …).
  typeText(text: string, holdCycles: number = 50000, gapCycles: number = 10000): void {
    let off = 0;
    for (const ch of text) {
      const m = lookupChar(ch);
      if (!m) continue;
      const start = this.cycleNow + off;
      const end = start + holdCycles;
      this.events.push({ key: m.key, startCycle: start, endCycle: end });
      if (m.shift) {
        this.events.push({ key: "L_SHIFT", startCycle: start, endCycle: end });
      }
      off += holdCycles + gapCycles;
    }
  }

  // Sprint 93.1: queue an explicit key event with absolute timing.
  queueKeyEvent(key: KeyName, startCycleFromNow: number, holdCycles: number): void {
    const start = this.cycleNow + startCycleFromNow;
    this.events.push({ key, startCycle: start, endCycle: start + holdCycles });
  }

  // Sprint 93.1: drop pending events. Used by tests / reset paths.
  clearEvents(): void { this.events = []; }
  pendingEventCount(): number { return this.events.length; }
  currentCycle(): number { return this.cycleNow; }

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
      const [col, row] = coord;
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

// Sprint 93.1: PETSCII char → matrix entry (with optional SHIFT).
// Covers everything needed for `LOAD"*",8,1<RETURN>RUN<RETURN>` plus
// commonly-typed BASIC and game commands.
const SHIFTED_CHARS: Record<string, string> = {
  "\"": "2",
  "(": "8",
  ")": "9",
  "?": "/",
  "<": ",",
  ">": ".",
  "[": ":",
  "]": ";",
  "!": "1",
  "#": "3",
  "$": "4",
  "%": "5",
  "&": "6",
  "'": "7",
};

function lookupChar(ch: string): { key: string; shift?: boolean } | null {
  if (ch === " ") return { key: "SPACE" };
  if (ch === "\n" || ch === "\r") return { key: "RETURN" };
  if (ch === "\t") return null; // ignore
  const up = ch.toUpperCase();
  if (KEY_MATRIX[up]) return { key: up };
  const shifted = SHIFTED_CHARS[ch] ?? SHIFTED_CHARS[up];
  if (shifted && KEY_MATRIX[shifted]) return { key: shifted, shift: true };
  return null;
}

// Sprint 93.1: joystick port 2 backend. Real C64 wires joystick port 2
// to CIA1 PA bits 0-4 (active-low). When read, pulled bits indicate
// pressed direction / fire. We model this as a small state object the
// session can mutate; the CIA1 PA backend ANDs joystick mask into PA
// reads to make the CPU see the joystick.
export interface JoystickState {
  up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean;
}

export const JOY_BIT_UP = 1 << 0;
export const JOY_BIT_DOWN = 1 << 1;
export const JOY_BIT_LEFT = 1 << 2;
export const JOY_BIT_RIGHT = 1 << 3;
export const JOY_BIT_FIRE = 1 << 4;

export function joystickActiveLowMask(s: JoystickState): number {
  let mask = 0xff;
  if (s.up)    mask &= ~JOY_BIT_UP;
  if (s.down)  mask &= ~JOY_BIT_DOWN;
  if (s.left)  mask &= ~JOY_BIT_LEFT;
  if (s.right) mask &= ~JOY_BIT_RIGHT;
  if (s.fire)  mask &= ~JOY_BIT_FIRE;
  return mask & 0xff;
}
