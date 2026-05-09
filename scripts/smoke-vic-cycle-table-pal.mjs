#!/usr/bin/env node
// Spec 296a-2 smoke — PAL 6569 cycle_tab dispatch parity.
//
// Verifies our TS port matches viciisc/vicii-chip-model.c expectations:
//   - 126 entries (63 cycles × 2 phases)
//   - sprite fetches at cycles 1-10 + 58-63
//   - refresh fetches at cycles 11-15
//   - FetchG at cycles 16-55 Φ1
//   - FetchC may-fire at cycles 15-54 Φ2
//   - UpdateVc at cycle 14 Φ2
//   - UpdateRc at cycle 58 Φ2
//   - UpdateMcBase at cycle 16 Φ2
//   - ChkSprCrunch at cycle 15 Φ2
//   - Visible bits cover cycles 16-56 with the offset shape from VICE table

import {
  CYCLE_TAB_PAL, PAL_HALF_CYCLES_PER_LINE, cycleEntry,
  PHI1_NONE, PHI1_REFRESH, PHI1_FETCH_G, PHI1_SPR_PTR, PHI1_SPR_DMA1, PHI1_IDLE,
} from "../dist/runtime/headless/vic/cycle-table-pal.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-cycle-table-pal — Spec 296a-2");

// 1. Count
ok("126 entries (63 cycles × 2 phases)",
   CYCLE_TAB_PAL.length === 126 && PAL_HALF_CYCLES_PER_LINE === 126,
   `got ${CYCLE_TAB_PAL.length}`);

// 2. Sequence: every (cycle, phase) appears exactly once in order
{
  let okSeq = true;
  for (let c = 1; c <= 63; c++) {
    for (const phase of ["phi1", "phi2"]) {
      const idx = (c - 1) * 2 + (phase === "phi1" ? 0 : 1);
      if (CYCLE_TAB_PAL[idx].cycle !== c || CYCLE_TAB_PAL[idx].phase !== phase) {
        okSeq = false;
        console.log(`  seq mismatch idx ${idx}: ${CYCLE_TAB_PAL[idx].cycle}.${CYCLE_TAB_PAL[idx].phase}`);
        break;
      }
    }
    if (!okSeq) break;
  }
  ok("entries in cycle×phase order", okSeq);
}

// 3. Sprite Φ1 fetches at cycles 1-10 + 58-63
{
  const sprCycles = [1,2,3,4,5,6,7,8,9,10,58,59,60,61,62,63];
  const allOk = sprCycles.every(c => {
    const e = cycleEntry(c, "phi1");
    return e.phi1 === PHI1_SPR_PTR || e.phi1 === PHI1_SPR_DMA1;
  });
  ok("sprite Φ1 fetches at cycles 1-10 + 58-63", allOk);
}

// 4. Refresh at cycles 11-15 Φ1
{
  const refresh = [11,12,13,14,15].every(c => cycleEntry(c, "phi1").phi1 === PHI1_REFRESH);
  ok("refresh Φ1 cycles 11-15", refresh);
}

// 5. FetchG at cycles 16-55 Φ1
{
  let fg = true;
  for (let c = 16; c <= 55; c++) {
    if (cycleEntry(c, "phi1").phi1 !== PHI1_FETCH_G) { fg = false; break; }
  }
  ok("FetchG Φ1 cycles 16-55", fg);
}

// 6. Idle Φ1 at cycles 56-57
ok("Idle Φ1 at cycle 56", cycleEntry(56, "phi1").phi1 === PHI1_IDLE);
ok("Idle Φ1 at cycle 57", cycleEntry(57, "phi1").phi1 === PHI1_IDLE);

// 7. mayFetchC at cycles 15-54 Φ2
{
  let mfc = true;
  for (let c = 15; c <= 54; c++) {
    if (!cycleEntry(c, "phi2").mayFetchC) { mfc = false; break; }
  }
  ok("mayFetchC Φ2 cycles 15-54", mfc);
}

// 8. UpdateVc at cycle 14 Φ2
ok("UpdateVc at cycle 14 Φ2", cycleEntry(14, "phi2").updateVc);
// 9. UpdateRc at cycle 58 Φ2
ok("UpdateRc at cycle 58 Φ2", cycleEntry(58, "phi2").updateRc);
// 10. UpdateMcBase at cycle 16 Φ2
ok("UpdateMcBase at cycle 16 Φ2", cycleEntry(16, "phi2").updateMcBase);
// 11. ChkSprCrunch at cycle 15 Φ2
ok("ChkSprCrunch at cycle 15 Φ2", cycleEntry(15, "phi2").checkSprCrunch);
// 12. ChkSprDma at cycle 55 + 56 Φ1
ok("ChkSprDma at cycle 55 Φ1", cycleEntry(55, "phi1").checkSprDma);
ok("ChkSprDma at cycle 56 Φ1", cycleEntry(56, "phi1").checkSprDma);
// 13. ChkSprDisp at cycle 58 Φ1
ok("ChkSprDisp at cycle 58 Φ1", cycleEntry(58, "phi1").checkSprDisp);
// 14. ChkSprExp at cycle 56 Φ2
ok("ChkSprExp at cycle 56 Φ2", cycleEntry(56, "phi2").checkSprExp);
// 15. ChkBrdL1 at cycle 17 Φ2; ChkBrdL0 at cycle 18 Φ2
ok("ChkBrdL1 at cycle 17 Φ2", cycleEntry(17, "phi2").checkBrdL1);
ok("ChkBrdL0 at cycle 18 Φ2", cycleEntry(18, "phi2").checkBrdL0);
// 16. ChkBrdR0 at cycle 56 Φ2; ChkBrdR1 at cycle 57 Φ2
ok("ChkBrdR0 at cycle 56 Φ2", cycleEntry(56, "phi2").checkBrdR0);
ok("ChkBrdR1 at cycle 57 Φ2", cycleEntry(57, "phi2").checkBrdR1);
// 17. Sprite numbers — cycle 1.Φ1 = sprite 3; cycle 58.Φ1 = sprite 0
ok("cycle 1.Φ1 = sprite 3", cycleEntry(1, "phi1").phi1SpriteNum === 3);
ok("cycle 58.Φ1 = sprite 0", cycleEntry(58, "phi1").phi1SpriteNum === 0);
ok("cycle 9.Φ1 = sprite 7", cycleEntry(9, "phi1").phi1SpriteNum === 7);
// 18. Visible coverage starts at cycle 16 Φ2
ok("cycle 15 Φ2 NOT visible", !cycleEntry(15, "phi2").visible);
ok("cycle 16 Φ2 visible", cycleEntry(16, "phi2").visible);
ok("cycle 56 Φ1 visible", cycleEntry(56, "phi1").visible);
ok("cycle 56 Φ2 NOT visible", !cycleEntry(56, "phi2").visible);

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
