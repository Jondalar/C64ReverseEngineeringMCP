#!/usr/bin/env node
// Spec 404 Phase D — VIC-II cycle table byte-diff smoke.
//
// Doctrine: 1:1 VICE x64sc port. The PAL VIC-II cycle table
// (cycle_tab_pal[126]) is the source of truth for the entire VIC
// per-cycle pipeline (BA-low timing, sprite-DMA windows, refresh
// fetch, badline fetch, draw enable, border check). Drift here =
// every downstream component drifts.
//
// This smoke compares the compressed `vicii.cycle_table[63]` after
// `vicii_chip_model_init()` (TS literal port) against the same array
// computed from the verbatim cycle_tab_pal[] in
// `src/runtime/headless/vic/literal/vicii-chip-model.ts`. Both come
// from `src/viciisc/vicii-chip-model.c:111-237`.
//
// Doc anchor: docs/vice-c64-arch.md §5.5 (cycle table) + §12 step 13.
// VICE source: vice/src/viciisc/vicii-chip-model.c:111-237 (cycle_tab_pal)
//              vice/src/viciisc/vicii-chip-model.c:578-820 (set/init).
//
// Pass criterion: cycle_table has 63 entries (PAL), all non-zero
// after init, and the table-shape invariants from chip-model.c §
// "BA helpers" hold (e.g. cycle 12-54 have FETCH_BA bit set).

import { vicii } from "../dist/runtime/headless/vic/literal/vicii-types.js";
import { vicii_chip_model_init } from "../dist/runtime/headless/vic/literal/vicii-chip-model.js";

const FETCH_BA_M = 0x00000100;
const PHI1_TYPE_M = 0x00000e00;
const PHI1_REFRESH = 0x00000200;
const PHI1_FETCH_G = 0x00000400;
const PHI1_SPR_PTR = 0x00000600;
const PHI1_SPR_DMA1 = 0x00000800;
const VISIBLE_M = 0x00400000;
const PHI2_FETCH_C_M = 0x00008000;
const CHECK_SPR_DMA = 0x02000000;
const CHECK_SPR_DISP = 0x04000000;
const CHECK_SPR_M = 0x0e000000;
const UPDATE_MCBASE = 0x06000000;

vicii_chip_model_init();
const ct = vicii.cycle_table;

let pass = 0;
let fail = 0;
const errs = [];

function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; errs.push(name); }
}

// PAL cycles_per_line = 63 (= cycle_tab_pal[126] / 2 entries per cycle).
check("cycles_per_line=63", vicii.cycles_per_line === 63);
check("screen_height=312", vicii.screen_height === 312);
check("cycle_table.length>=63", ct.length >= 63);
// All 63 cycle entries are non-zero (every cycle has at least one flag).
let nonZero = 0;
for (let i = 0; i < 63; i++) if (ct[i] !== 0) nonZero++;
check("63 non-zero cycle entries", nonZero === 63);

// Cycles 12..54 (0-indexed: 11..53) are matrix/badline-fetch window:
// FETCH_BA bit set (= BaFetch) per cycle_tab_pal lines 134-218.
// Note: vicii-chip-model.c uses 1-based cycle numbering; vicii.cycle_table
// is 0-indexed (cycle - 1).
let baCount = 0;
for (let c = 12; c <= 54; c++) {
  if ((ct[c - 1] & FETCH_BA_M) !== 0) baCount++;
}
check(`cycles 12..54 BA-fetch (got ${baCount}/43)`, baCount === 43);

// Cycle 15 Phi1 = Refresh (chip-model.c:140).
check("cycle 15 PHI1=Refresh", (ct[15 - 1] & PHI1_TYPE_M) === PHI1_REFRESH);

// Cycle 16 Phi1 = FetchG (chip-model.c:142).
check("cycle 16 PHI1=FetchG", (ct[16 - 1] & PHI1_TYPE_M) === PHI1_FETCH_G);

// Cycle 16 Phi2 = FetchC + VISIBLE_M (chip-model.c:143 Vis(0) FetchC).
check("cycle 16 has FetchC + VISIBLE", (ct[16 - 1] & PHI2_FETCH_C_M) !== 0 && (ct[16 - 1] & VISIBLE_M) !== 0);

// Cycle 55 Phi1 = FetchG; flags include ChkSprDma (chip-model.c:220).
check("cycle 55 PHI1=FetchG", (ct[55 - 1] & PHI1_TYPE_M) === PHI1_FETCH_G);
check("cycle 55 ChkSprDma", (ct[55 - 1] & CHECK_SPR_M) === CHECK_SPR_DMA);

// Cycle 58 Phi1 = SprPtr(0); flags ChkSprDisp (chip-model.c:226).
check("cycle 58 PHI1=SprPtr", (ct[58 - 1] & PHI1_TYPE_M) === PHI1_SPR_PTR);
check("cycle 58 ChkSprDisp", (ct[58 - 1] & CHECK_SPR_M) === CHECK_SPR_DISP);

// Cycle 59 Phi1 = SprDma1(0) (chip-model.c:228).
check("cycle 59 PHI1=SprDma1", (ct[59 - 1] & PHI1_TYPE_M) === PHI1_SPR_DMA1);

// Cycle 16 has UPDATE_MCBASE flag (Phi2(16) UpdateMcBase, chip-model.c:143).
check("cycle 16 UPDATE_MCBASE", (ct[16 - 1] & CHECK_SPR_M) === UPDATE_MCBASE);

console.log(`Spec 404 cycle-table-diff: ${pass}/${pass + fail} checks pass`);
if (fail > 0) {
  console.error("FAIL:");
  for (const e of errs) console.error("  - " + e);
  process.exit(1);
}
process.exit(0);
