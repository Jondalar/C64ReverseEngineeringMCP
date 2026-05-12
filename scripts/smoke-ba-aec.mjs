#!/usr/bin/env node
// Spec 283 Phase 283d — BA / AEC state-machine smoke.
//
// Per OQ3 = (a): synthetic single-line micro-benchmark verifying:
//   - isBaAsserted returns the right cycles for badline / sprite combos
//   - updateBaAec transitions baLow → aecLow after 3 cycles
//   - CPU stalls at AEC-low (= BA + 3), resumes at BA-clear
//   - RMW write phase exempt from stall

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const m = await import(`${REPO}/dist/runtime/headless/vic/ba-aec.js`);
const bus = await import(`${REPO}/dist/runtime/headless/vic/bus-owner-table.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 283 BA / AEC smoke ===\n");

// 1. BA_PRE_ASSERT_CYCLES = 3 (real-HW constant).
check("BA_PRE_ASSERT_CYCLES = 3", m.BA_PRE_ASSERT_CYCLES === 3);

// 2. isBaAsserted on badline-only: BA from cycle 8 through 56.
check("badline cycle 7  → BA off", !m.isBaAsserted(7,  true, 0));
check("badline cycle 8  → BA on (= 11-3 pre-warning)",
  m.isBaAsserted(8,  true, 0));
check("badline cycle 11 → BA on (= matrix start)",
  m.isBaAsserted(11, true, 0));
check("badline cycle 53 → BA on (= matrix tail)",
  m.isBaAsserted(53, true, 0));
check("badline cycle 56 → BA on (= p-access tail)",
  m.isBaAsserted(56, true, 0));
check("badline cycle 57 → BA off",
  !m.isBaAsserted(57, true, 0));

// 3. isBaAsserted with sprite 0 only (no badline). Sprite 0 s-access
// at cycles 57..58 per spriteSAccessStartCycle(0) = 57.
const sp0 = 1 << 0;
check("sprite0 cycle 50 → BA off", !m.isBaAsserted(50, false, sp0));
check("sprite0 cycle 51 → BA on (= 54-3 pre-warning)",
  m.isBaAsserted(51, false, sp0));
check("sprite0 cycle 56 → BA on (= p-access)",
  m.isBaAsserted(56, false, sp0));
check("sprite0 cycle 58 → BA on (= last s-access)",
  m.isBaAsserted(58, false, sp0));
check("sprite0 cycle 59 → BA off",
  !m.isBaAsserted(59, false, sp0));

// 4. isBaAsserted with all 8 sprites. Layout:
//   sp0: 57..58, sp1: 59..60, sp2: 61..62, sp3: 0..1 (wrap),
//   sp4: 2..3, sp5: 4..5, sp6: 6..7, sp7: 8..9
// BA continuous from cycle 51 through cycle 62, then wraps to 0..9.
const sp_all = 0xff;
check("all-sprites cycle 51 → BA on", m.isBaAsserted(51, false, sp_all));
check("all-sprites cycle 9 → BA on (sprite 7 wrap end)",
  m.isBaAsserted(9, false, sp_all));
check("all-sprites cycle 10 → BA off (= after wrap)",
  !m.isBaAsserted(10, false, sp_all));

// 5. updateBaAec transitions: baLow → aecLow after exactly 3 cycles.
const state = m.createBaAecState();
let r;

// Cycle 100: BA goes low for the first time.
r = m.updateBaAec(state, 100, true);
check("BA cycle 0 → baLow=true, aecLow=false, cpuStalled=false",
  state.baLow && !state.aecLow && !r.cpuStalled);

r = m.updateBaAec(state, 101, true);
check("BA cycle 1 → still aecLow=false, cpuStalled=false",
  state.baLow && !state.aecLow && !r.cpuStalled);

r = m.updateBaAec(state, 102, true);
check("BA cycle 2 → still aecLow=false, cpuStalled=false",
  state.baLow && !state.aecLow && !r.cpuStalled);

r = m.updateBaAec(state, 103, true);
check("BA cycle 3 → aecLow=true, cpuStalled=true",
  state.baLow && state.aecLow && r.cpuStalled);

r = m.updateBaAec(state, 104, true);
check("BA cycle 4 → still cpuStalled=true",
  r.cpuStalled);

// 6. RMW exemption: when rmwActive=true, cpuStalled=false even at AEC-low.
state.rmwActive = true;
r = m.updateBaAec(state, 105, true);
check("BA cycle 5 + RMW write phase → cpuStalled=false (exempt)",
  state.aecLow && !r.cpuStalled);
state.rmwActive = false;

// 7. BA released → aecLow clears immediately, CPU resumes.
r = m.updateBaAec(state, 106, false);
check("BA released → baLow=false, aecLow=false, cpuStalled=false",
  !state.baLow && !state.aecLow && !r.cpuStalled);

// 8. Re-asserting BA later restarts the 3-cycle warning.
r = m.updateBaAec(state, 200, true);
check("BA re-asserted later → baLowSinceCycle reset, aecLow=false",
  state.baLow && state.baLowSinceCycle === 200 && !state.aecLow);

r = m.updateBaAec(state, 203, true);
check("3 cycles later → aecLow=true",
  state.aecLow);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
