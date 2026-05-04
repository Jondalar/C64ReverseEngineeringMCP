// Spec 119 (M4.3) — screen-state JSON query.
//
// Returns structured snapshot of the C64 visual state without
// requiring agents to parse PNG output. Text mode produces a
// PETSCII-decoded grid; bitmap mode produces a hash; sprites are
// always returned with position + flags.

import type { IntegratedSession } from "../integrated-session.js";

export type VicMode = "text" | "multicolor-text" | "ecm-text" | "bitmap" | "multicolor-bitmap";

export interface SpriteState {
  index: number;
  x: number;
  y: number;
  active: boolean;
  color: number;
  expandX: boolean;
  expandY: boolean;
  multicolor: boolean;
  priority: boolean;
}

export interface ScreenState {
  textGrid: string[];     // 25 rows of length 40
  colorGrid: number[][];  // 25 × 40, low nibble of color RAM
  sprites: SpriteState[];
  bitmapHash?: string;
  vicMode: VicMode;
  vicBank: number;        // 0..3
  borderColor: number;
  bgColor: number;
  rasterLine: number;
}

// PETSCII screen-code → ASCII (printable). 0..63 are uppercase letters
// + symbols, 64..127 graphics, 128..191 inverse, 192+ reverse mappings.
function screenCodeToAscii(code: number): string {
  const c = code & 0x7f; // strip inverse-video bit
  // 0..25 = '@', 'A'..'Z'
  if (c === 0) return "@";
  if (c >= 1 && c <= 26) return String.fromCharCode("A".charCodeAt(0) + c - 1);
  // 27..31: graphics  -> show literal
  if (c === 0x20) return " ";
  if (c >= 0x30 && c <= 0x39) return String.fromCharCode(c);
  // Symbols 0x21..0x2F
  if (c >= 0x21 && c <= 0x2f) return String.fromCharCode(c);
  if (c === 0x3a || c === 0x3b || c === 0x3c || c === 0x3d || c === 0x3e || c === 0x3f) return String.fromCharCode(c);
  // Default: '?' for non-printable graphics
  return "?";
}

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function captureScreenState(session: IntegratedSession): ScreenState {
  const vic = session.vic;
  const ctrl1 = vic.regs[0x11];
  const ctrl2 = vic.regs[0x16];
  const bmm = (ctrl1 & 0x20) !== 0;
  const ecm = (ctrl1 & 0x40) !== 0;
  const mcm = (ctrl2 & 0x10) !== 0;
  const vicMode: VicMode =
    bmm ? (mcm ? "multicolor-bitmap" : "bitmap")
        : (ecm ? "ecm-text" : (mcm ? "multicolor-text" : "text"));
  const vicBank = session.cia2.pra & 0x03;

  const screenRamOff = vic.screenRamOffset();
  const bus = session.c64Bus;
  const bankBase = (3 - vicBank) * 0x4000;

  const textGrid: string[] = [];
  const colorGrid: number[][] = [];
  for (let row = 0; row < 25; row++) {
    let line = "";
    const colors: number[] = [];
    for (let col = 0; col < 40; col++) {
      const idx = row * 40 + col;
      const screenCode = bus.ram[(bankBase + screenRamOff + idx) & 0xffff]!;
      line += screenCodeToAscii(screenCode);
      const colorByte = bus.io[0x800 + idx]! & 0x0f;
      colors.push(colorByte);
    }
    textGrid.push(line);
    colorGrid.push(colors);
  }

  const sprites: SpriteState[] = [];
  const enableMask = vic.regs[0x15]!;
  const xMsb       = vic.regs[0x10]!;
  const expX       = vic.regs[0x1d]!;
  const expY       = vic.regs[0x17]!;
  const mcMask     = vic.regs[0x1c]!;
  const priMask    = vic.regs[0x1b]!;
  for (let s = 0; s < 8; s++) {
    sprites.push({
      index: s,
      x: vic.regs[s * 2]! | (((xMsb >> s) & 1) << 8),
      y: vic.regs[s * 2 + 1]!,
      active: (enableMask & (1 << s)) !== 0,
      color: vic.regs[0x27 + s]! & 0x0f,
      expandX: (expX & (1 << s)) !== 0,
      expandY: (expY & (1 << s)) !== 0,
      multicolor: (mcMask & (1 << s)) !== 0,
      priority: (priMask & (1 << s)) !== 0,
    });
  }

  let bitmapHash: string | undefined;
  if (bmm) {
    const bitmapOff = vic.bitmapBaseWithinBank();
    const slice = bus.ram.subarray(bankBase + bitmapOff, bankBase + bitmapOff + 8000);
    bitmapHash = fnv1a(slice);
  }

  return {
    textGrid,
    colorGrid,
    sprites,
    bitmapHash,
    vicMode,
    vicBank,
    borderColor: vic.regs[0x20]! & 0x0f,
    bgColor: vic.regs[0x21]! & 0x0f,
    rasterLine: vic.rasterLine,
  };
}

// Hash of the combined screen-state for visual-acceptance compare.
export function screenStateHash(state: ScreenState): string {
  const flat: number[] = [];
  for (const row of state.textGrid) for (let i = 0; i < row.length; i++) flat.push(row.charCodeAt(i));
  for (const row of state.colorGrid) for (const c of row) flat.push(c);
  for (const s of state.sprites) {
    flat.push(s.x & 0xff, (s.x >> 8) & 0xff, s.y, s.active ? 1 : 0, s.color, s.multicolor ? 1 : 0);
  }
  if (state.bitmapHash) for (const ch of state.bitmapHash) flat.push(ch.charCodeAt(0));
  flat.push(state.borderColor, state.bgColor, state.vicBank);
  return fnv1a(new Uint8Array(flat));
}
