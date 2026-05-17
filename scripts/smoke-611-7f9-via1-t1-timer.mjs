#!/usr/bin/env node
// Spec 611 phase 611.7f.9 — VIA1 T1 timer contract smoke (Codex 07:18).
//
// Synthetic check codifying the VIA1 T1 timer behavior ported from
// VICE viacore.c. Catches regressions in T1 latch/counter/IFR_T1 path
// without needing the LOAD"$",8 runtime gate.
//
// VICE contract (viacore.c lines 224-263 + 741-783):
//
// 1. T1CL/T1LL write: updates latch LOW only.
// 2. T1CH write: updates latch HIGH; reloads counter; clears IFR_T1;
//    arms timer one-shot.
// 3. T1LH write: updates latch HIGH only (no counter reload); clears
//    IFR_T1 (Synertek-confirmed behavior).
// 4. T1CL read: returns counter LOW + clears IFR_T1.
// 5. T1CH read: returns counter HIGH (does NOT clear IFR_T1).
// 6. Counter decrements at drive clock rate. Underflow at t1ZeroClk+1
//    sets IFR_T1.
// 7. One-shot mode (ACR & 0x40 == 0): IRQ fires once until T1CH rewritten.
// 8. Free-run mode (ACR & 0x40 != 0): IRQ re-fires every (tal+2) cycles.
//
// 1541 use case: drive ROM at $FF29 STA $1805 (T1CH = $01) → starts T1
// for EOI timeout detect. Drive then polls IFR ($180D) at $E9E2; when
// IFR_T1 sets, branches to $E9F2 EOI-ack path.
//
// Exit 0 = PASS, 1 = FAIL.

import { Vice1541 } from "../dist/runtime/headless/_quarantine_vice1541_v4/vice1541.js";

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const vice = new Vice1541();
const drv = vice.driveCpu;
const via1 = drv.via1;
const clkPtr = vice.diskunit.clkPtr;

function advanceClk(n) { clkPtr.value += n; }

// === Contract 1: T1CL/T1LL write updates only latch LOW ===
via1.reset();
clkPtr.value = 0;
via1.write(0x04, 0x42); // T1CL
check("T1CL=$42 → T1LL read returns $42", (via1.read(0x06) & 0xff) === 0x42);
check("T1CL=$42 → T1LH read returns $00 (HIGH untouched)", (via1.read(0x07) & 0xff) === 0x00);
check("T1CL write does NOT activate timer (IFR_T1 stays clear)",
  (via1.read(0x0d) & 0x40) === 0);

via1.write(0x06, 0x99); // T1LL same as T1CL
check("T1LL=$99 → T1LL read returns $99", (via1.read(0x06) & 0xff) === 0x99);

// === Contract 2: T1CH write reloads counter + clears IFR_T1 ===
via1.reset();
clkPtr.value = 100;
via1.write(0x04, 0x10); // T1LL = $10
via1.write(0x05, 0x00); // T1CH = $00 → latch = $0010 = 16
// t1ZeroClk = 100 + 1 + 16 = 117. Counter at clk=100 = (117-100) = 17.
const t1at100 = ((via1.read(0x05) & 0xff) << 8) | (via1.read(0x04) & 0xff);
// Note: T1CL read clears IFR_T1, but the value we read came back. Counter
// at this clk = 17 = 0x0011.
check(`T1CH=$00 with T1LL=$10 at clk=100 → counter shows ${t1at100} (= 17 = 0x11)`,
  t1at100 === 0x11,
  `got 0x${t1at100.toString(16)}`);
check("T1CH write clears IFR_T1", (via1.read(0x0d) & 0x40) === 0);

// === Contract 3: counter decrements with clk ===
clkPtr.value = 110; // 10 cycles passed
const t1at110 = ((via1.read(0x05) & 0xff) << 8) | (via1.read(0x04) & 0xff);
check(`At clk=110 (10 cycles later) counter = 7 (= 17 - 10)`,
  t1at110 === 7,
  `got ${t1at110}`);

// === Contract 4: IFR_T1 sets at underflow ===
// t1ZeroClk = 117 from above; underflow at clk = 118.
clkPtr.value = 117;
check("At clk=t1ZeroClk (117): counter=0, IFR_T1 NOT yet set",
  ((via1.read(0x05) << 8) | via1.read(0x04)) === 0
  && (via1.read(0x0d) & 0x40) === 0);

via1.write(0x05, 0x00); // re-arm T1CH=$00 with T1LL=$10 → fresh; new t1ZeroClk = 117+1+16 = 134
check("T1CH rewrite clears IFR_T1 + re-arms",
  (via1.read(0x0d) & 0x40) === 0);

clkPtr.value = 134; // counter = 0
check("After T1CH re-arm at clk=117, at clk=134 (zero) IFR_T1 not yet",
  (via1.read(0x0d) & 0x40) === 0);

// === Contracts 4-7 SUPERSEDED by 7g1 alarm path ===
// Lazy-eval-on-register-read removed; alarm-based path is canonical
// per Codex 12:25. See scripts/smoke-611-7g1-via-t1-alarm.mjs.

// === Contract 7.5 SUPERSEDED by 7g1 alarm path ===
//
// Spec 611 phase 611.7g (Codex 12:25): lazy-eval `serviceTimers`
// removed; alarm-based T1 is canonical. The serviceTimers contract
// previously tested here is no longer valid behavior.
//
// See scripts/smoke-611-7g1-via-t1-alarm.mjs for canonical
// alarm-path smokes (A-F). The remaining checks in this file still
// cover T1 register store/read semantics (which alarm-path also uses)
// — those stay GREEN regardless of fire path.

// === Contract 8: T1LH write does NOT reload counter ===
via1.reset();
clkPtr.value = 0;
via1.write(0x04, 0x05); // T1LL = 5
via1.write(0x05, 0x00); // T1CH = 0 → arms; t1ZeroClk = 6
clkPtr.value = 3; // counter = 6 - 3 = 3
via1.write(0x07, 0xff); // T1LH = 0xff → latch = 0xff05; counter NOT reloaded
const t1at3 = ((via1.read(0x05) & 0xff) << 8) | (via1.read(0x04) & 0xff);
check("T1LH write does NOT reload counter (still counts to 0)",
  t1at3 === 3,
  `counter=0x${t1at3.toString(16)}`);

// === Summary ===
const failed = checks.filter((c) => !c.ok).length;
console.log("");
if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} T1 contract checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length}/${checks.length} VIA1 T1 timer contract checks passed.`);
process.exit(0);
