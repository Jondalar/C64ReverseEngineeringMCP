// Spec 296a-2 — PAL 6569 per-cycle dispatch table.
//
// 1:1 port of viciisc/vicii-chip-model.c cycle_tab_pal[]. Each entry
// describes one half-cycle (Phi1 OR Phi2). 63 cycles × 2 phases = 126
// entries.
//
// VICE flag encoding (vicii-chip-model.h:55-117):
//   PHI1_TYPE_M    bits 11-9   None=0/Refresh=1/FetchG=2/SprPtr=3/SprDma1=4
//   PHI1_SPR_NUM_M bits 14-12  sprite index 0-7 for sprite fetches
//   PHI2_FETCH_C_M bit  15     FetchC on Φ2
//   VISIBLE_M      bit  22     visible-pixel flag
//   XPOS_M         bits 21-16  pixel-x / 8 for the cycle
//   UPDATE_VC_M    bit  24     update VC at end-of-cycle
//   UPDATE_RC_M    bit  23     update RC at end-of-cycle
//   FETCH_BA_M     bit  8      assert BA for matrix-fetch DMA
//   SPRITE_BA_MASK bits 7-0    per-sprite BA mask
//   plus border / sprite-disp / sprite-crunch checks (296a-2 keeps
//   these as opaque flags, future sub-specs decode them)

/** Phi1 fetch type for a cycle. */
export const PHI1_NONE = 0;
export const PHI1_REFRESH = 1;
export const PHI1_FETCH_G = 2;
export const PHI1_SPR_PTR = 3;       // fetches sprite pointer + DMA0
export const PHI1_SPR_DMA1 = 4;      // fetches DMA1 + DMA2
export const PHI1_IDLE = 5;          // explicit Idle (= cycles 56..57)
export type Phi1FetchType =
  | typeof PHI1_NONE
  | typeof PHI1_REFRESH
  | typeof PHI1_FETCH_G
  | typeof PHI1_SPR_PTR
  | typeof PHI1_SPR_DMA1
  | typeof PHI1_IDLE;

/** Per-half-cycle entry (combined flags). */
export interface CycleEntry {
  /** Cycle 1..63. */
  cycle: number;
  /** "phi1" or "phi2". */
  phase: "phi1" | "phi2";
  /** Pixel-X / 8 (cycle_get_xpos << 3 = pixel x). */
  xposDiv8: number;
  /** Visible pixel emitted this half-cycle. */
  visible: boolean;
  /** Φ1 fetch type. */
  phi1: Phi1FetchType;
  /** Sprite num 0-7 for SPR_PTR / SPR_DMA1 phi1 fetches. */
  phi1SpriteNum: number;
  /** Φ2 may-FetchC. */
  mayFetchC: boolean;
  /** BA asserted this cycle for matrix DMA. */
  baFetch: boolean;
  /** Per-sprite BA mask (bit n = sprite n requested). */
  baSpriteMask: number;
  /** UpdateVc end-of-cycle (= reset vmli). */
  updateVc: boolean;
  /** UpdateRc end-of-cycle. */
  updateRc: boolean;
  /** Check sprite crunch flags (cycle 15.Φ2 etc). */
  checkSprCrunch: boolean;
  /** UpdateMcBase (cycle 16.Φ2). */
  updateMcBase: boolean;
  /** Check sprite expand (cycle 56.Φ2). */
  checkSprExp: boolean;
  /** Check sprite display (cycle 58.Φ1). */
  checkSprDisp: boolean;
  /** Check sprite DMA (cycle 55/56.Φ1). */
  checkSprDma: boolean;
  /** Border-left checks (cycle 17/18.Φ2). */
  checkBrdL0: boolean;
  checkBrdL1: boolean;
  /** Border-right checks (cycle 56/57.Φ2). */
  checkBrdR0: boolean;
  checkBrdR1: boolean;
}

/** Build a single entry from VICE-style fields. */
function entry(
  cycle: number, phase: "phi1" | "phi2", xposDiv8: number, visible: boolean,
  phi1: Phi1FetchType, phi1SpriteNum: number, mayFetchC: boolean,
  baFetch: boolean, baSpriteMask: number,
  flags: Partial<Omit<CycleEntry,
    "cycle"|"phase"|"xposDiv8"|"visible"|"phi1"|"phi1SpriteNum"|"mayFetchC"|"baFetch"|"baSpriteMask">> = {},
): CycleEntry {
  return {
    cycle, phase, xposDiv8, visible, phi1, phi1SpriteNum,
    mayFetchC, baFetch, baSpriteMask,
    updateVc: !!flags.updateVc,
    updateRc: !!flags.updateRc,
    checkSprCrunch: !!flags.checkSprCrunch,
    updateMcBase: !!flags.updateMcBase,
    checkSprExp: !!flags.checkSprExp,
    checkSprDisp: !!flags.checkSprDisp,
    checkSprDma: !!flags.checkSprDma,
    checkBrdL0: !!flags.checkBrdL0,
    checkBrdL1: !!flags.checkBrdL1,
    checkBrdR0: !!flags.checkBrdR0,
    checkBrdR1: !!flags.checkBrdR1,
  };
}

// BA helpers per VICE BaSpr1/2/3 macros.
function baSpr1(s: number): number { return 1 << s; }
function baSpr2(a: number, b: number): number { return (1 << a) | (1 << b); }
function baSpr3(a: number, b: number, c: number): number { return (1 << a) | (1 << b) | (1 << c); }

// XPOS in VICE table is /8 already (col 16-21 of 26-bit field = 0x194 etc.
// — these are the raw flag word; xposDiv8 here is the "x position byte
// counter" which advances by 1 every half-cycle starting at cycle 1.Φ1
// from VICII_RASTER_X_BASE_PAL. We don't use the literal raw word; we
// store the post-decoded x position only for visibility checks. For
// 296a-2 the entries below set xposDiv8 = (rawWord >> 16) & 0x3f from
// the VICE table's second column.

/**
 * cycle_tab_pal[] — 126 entries (cycles 1..63, phi1 then phi2 each).
 * Order matches VICE source (chip-model.c:111-237).
 */
export const CYCLE_TAB_PAL: CycleEntry[] = [
  // Cycle 1: SprPtr(3) Φ1, SprDma0(3) Φ2, BaSpr2(3,4)
  entry(1, "phi1", 0x94, false, PHI1_SPR_PTR,  3, false, false, baSpr2(3,4)),
  entry(1, "phi2", 0x98, false, PHI1_NONE,     0, false, false, baSpr2(3,4)),
  // Cycle 2: SprDma1(3) Φ1, SprDma2(3) Φ2, BaSpr3(3,4,5)
  entry(2, "phi1", 0x9c, false, PHI1_SPR_DMA1, 3, false, false, baSpr3(3,4,5)),
  entry(2, "phi2", 0xa0, false, PHI1_NONE,     0, false, false, baSpr3(3,4,5)),
  // Cycle 3..10: same shape, sprites 4..7
  entry(3, "phi1", 0xa4, false, PHI1_SPR_PTR,  4, false, false, baSpr2(4,5)),
  entry(3, "phi2", 0xa8, false, PHI1_NONE,     0, false, false, baSpr2(4,5)),
  entry(4, "phi1", 0xac, false, PHI1_SPR_DMA1, 4, false, false, baSpr3(4,5,6)),
  entry(4, "phi2", 0xb0, false, PHI1_NONE,     0, false, false, baSpr3(4,5,6)),
  entry(5, "phi1", 0xb4, false, PHI1_SPR_PTR,  5, false, false, baSpr2(5,6)),
  entry(5, "phi2", 0xb8, false, PHI1_NONE,     0, false, false, baSpr2(5,6)),
  entry(6, "phi1", 0xbc, false, PHI1_SPR_DMA1, 5, false, false, baSpr3(5,6,7)),
  entry(6, "phi2", 0xc0, false, PHI1_NONE,     0, false, false, baSpr3(5,6,7)),
  entry(7, "phi1", 0xc4, false, PHI1_SPR_PTR,  6, false, false, baSpr2(6,7)),
  entry(7, "phi2", 0xc8, false, PHI1_NONE,     0, false, false, baSpr2(6,7)),
  entry(8, "phi1", 0xcc, false, PHI1_SPR_DMA1, 6, false, false, baSpr2(6,7)),
  entry(8, "phi2", 0xd0, false, PHI1_NONE,     0, false, false, baSpr2(6,7)),
  entry(9, "phi1", 0xd4, false, PHI1_SPR_PTR,  7, false, false, baSpr1(7)),
  entry(9, "phi2", 0xd8, false, PHI1_NONE,     0, false, false, baSpr1(7)),
  entry(10, "phi1", 0xdc, false, PHI1_SPR_DMA1, 7, false, false, baSpr1(7)),
  entry(10, "phi2", 0xe0, false, PHI1_NONE,     0, false, false, baSpr1(7)),
  // Cycle 11: refresh starts
  entry(11, "phi1", 0xe4, false, PHI1_REFRESH, 0, false, false, 0),
  entry(11, "phi2", 0xe8, false, PHI1_NONE,    0, false, false, 0),
  // Cycle 12-15: refresh + BaFetch
  entry(12, "phi1", 0xec, false, PHI1_REFRESH, 0, false, true, 0),
  entry(12, "phi2", 0xf0, false, PHI1_NONE,    0, false, true, 0),
  entry(13, "phi1", 0xf4, false, PHI1_REFRESH, 0, false, true, 0),
  entry(13, "phi2", 0x00, false, PHI1_NONE,    0, false, true, 0),
  entry(14, "phi1", 0x04, false, PHI1_REFRESH, 0, false, true, 0),
  entry(14, "phi2", 0x08, false, PHI1_NONE,    0, false, true, 0, { updateVc: true }),
  entry(15, "phi1", 0x0c, false, PHI1_REFRESH, 0, false, true, 0),
  entry(15, "phi2", 0x10, false, PHI1_NONE,    0, true,  true, 0, { checkSprCrunch: true }),
  // Cycle 16: first FetchG/FetchC pair, visible starts
  entry(16, "phi1", 0x14, false, PHI1_FETCH_G, 0, false, true, 0),
  entry(16, "phi2", 0x18, true,  PHI1_NONE,    0, true,  true, 0, { updateMcBase: true }),
  entry(17, "phi1", 0x1c, true,  PHI1_FETCH_G, 0, false, true, 0),
  entry(17, "phi2", 0x20, true,  PHI1_NONE,    0, true,  true, 0, { checkBrdL1: true }),
  entry(18, "phi1", 0x24, true,  PHI1_FETCH_G, 0, false, true, 0),
  entry(18, "phi2", 0x28, true,  PHI1_NONE,    0, true,  true, 0, { checkBrdL0: true }),
];

// Cycles 19-54: identical pattern (FetchG Φ1, FetchC Φ2, BaFetch).
// Generate in code to avoid 36 hand-written lines.
let _xpos = 0x2c;
for (let c = 19; c <= 54; c++) {
  CYCLE_TAB_PAL.push(
    entry(c, "phi1", _xpos,         true, PHI1_FETCH_G, 0, false, true, 0),
    entry(c, "phi2", (_xpos + 4) & 0xff, true, PHI1_NONE, 0, true,  true, 0),
  );
  _xpos = (_xpos + 8) & 0xff;
}

// Cycle 55: last FetchG, BaSpr1(0), ChkSprDma
CYCLE_TAB_PAL.push(
  entry(55, "phi1", 0x4c, true, PHI1_FETCH_G, 0, false, false, baSpr1(0), { checkSprDma: true }),
  entry(55, "phi2", 0x50, true, PHI1_NONE,    0, false, false, baSpr1(0)),
);
// Cycle 56: Idle Φ1, ChkSprDma + ChkBrdR0 + ChkSprExp Φ2
CYCLE_TAB_PAL.push(
  entry(56, "phi1", 0x54, true,  PHI1_IDLE, 0, false, false, baSpr1(0), { checkSprDma: true }),
  entry(56, "phi2", 0x58, false, PHI1_NONE, 0, false, false, baSpr1(0),
        { checkBrdR0: true, checkSprExp: true }),
);
// Cycle 57: Idle Φ1, ChkBrdR1 Φ2, BaSpr2(0,1)
CYCLE_TAB_PAL.push(
  entry(57, "phi1", 0x5c, false, PHI1_IDLE, 0, false, false, baSpr2(0,1)),
  entry(57, "phi2", 0x60, false, PHI1_NONE, 0, false, false, baSpr2(0,1), { checkBrdR1: true }),
);
// Cycle 58: SprPtr(0) + SprDma0(0), ChkSprDisp Φ1, UpdateRc Φ2
CYCLE_TAB_PAL.push(
  entry(58, "phi1", 0x64, false, PHI1_SPR_PTR,  0, false, false, baSpr2(0,1), { checkSprDisp: true }),
  entry(58, "phi2", 0x68, false, PHI1_NONE,     0, false, false, baSpr2(0,1), { updateRc: true }),
);
// Cycle 59: SprDma1(0) + SprDma2(0), BaSpr3(0,1,2)
CYCLE_TAB_PAL.push(
  entry(59, "phi1", 0x6c, false, PHI1_SPR_DMA1, 0, false, false, baSpr3(0,1,2)),
  entry(59, "phi2", 0x70, false, PHI1_NONE,     0, false, false, baSpr3(0,1,2)),
);
// Cycles 60-63: sprites 1, 2 (sprite 3 starts the next line at cycle 1 again)
const tail: Array<[number, number, number]> = [
  // [cycle, sprite, baMaskNext]
  [60, 1, baSpr2(1,2)],
  [60, 1, baSpr2(1,2)],     // Φ2 placeholder (we override below)
];
// Just hand-write — only 8 entries total
CYCLE_TAB_PAL.push(
  entry(60, "phi1", 0x74, false, PHI1_SPR_PTR,  1, false, false, baSpr2(1,2)),
  entry(60, "phi2", 0x78, false, PHI1_NONE,     0, false, false, baSpr2(1,2)),
  entry(61, "phi1", 0x7c, false, PHI1_SPR_DMA1, 1, false, false, baSpr3(1,2,3)),
  entry(61, "phi2", 0x80, false, PHI1_NONE,     0, false, false, baSpr3(1,2,3)),
  entry(62, "phi1", 0x84, false, PHI1_SPR_PTR,  2, false, false, baSpr2(2,3)),
  entry(62, "phi2", 0x88, false, PHI1_NONE,     0, false, false, baSpr2(2,3)),
  entry(63, "phi1", 0x8c, false, PHI1_SPR_DMA1, 2, false, false, baSpr3(2,3,4)),
  entry(63, "phi2", 0x90, false, PHI1_NONE,     0, false, false, baSpr3(2,3,4)),
);
void tail; // consumed inline above; keep variable to silence unused

/** Number of half-cycles per PAL line (= 63 × 2). */
export const PAL_HALF_CYCLES_PER_LINE = 126;

/** Look up the entry for raster cycle (1..63) + phase. */
export function cycleEntry(cycle: number, phase: "phi1" | "phi2"): CycleEntry {
  if (cycle < 1 || cycle > 63) throw new Error(`cycle ${cycle} out of PAL range 1..63`);
  // Index = (cycle-1)*2 + phase-offset
  const phaseOff = phase === "phi1" ? 0 : 1;
  const idx = (cycle - 1) * 2 + phaseOff;
  const e = CYCLE_TAB_PAL[idx];
  if (!e || e.cycle !== cycle || e.phase !== phase) {
    throw new Error(`cycle table mismatch at cycle ${cycle}.${phase} (idx ${idx})`);
  }
  return e;
}
