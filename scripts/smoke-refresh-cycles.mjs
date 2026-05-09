#!/usr/bin/env node
// Spec 294 — refresh cycles 11..15 r-access smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const m = await import(`${REPO}/dist/runtime/headless/vic/bus-owner-table.js`);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 294 refresh cycles smoke ===\n");

check("PAL_REFRESH_FIRST_CYCLE = 11", m.PAL_REFRESH_FIRST_CYCLE === 11);
check("PAL_REFRESH_LAST_CYCLE = 15", m.PAL_REFRESH_LAST_CYCLE === 15);
check("PAL_REFRESH_CYCLES_PER_LINE = 5", m.PAL_REFRESH_CYCLES_PER_LINE === 5);

// isRefreshCycle covers 11..15 inclusive.
check("isRefreshCycle(10) = false", !m.isRefreshCycle(10));
check("isRefreshCycle(11) = true",  m.isRefreshCycle(11));
check("isRefreshCycle(12) = true",  m.isRefreshCycle(12));
check("isRefreshCycle(13) = true",  m.isRefreshCycle(13));
check("isRefreshCycle(14) = true",  m.isRefreshCycle(14));
check("isRefreshCycle(15) = true",  m.isRefreshCycle(15));
check("isRefreshCycle(16) = false", !m.isRefreshCycle(16));

// Bus owner UNCHANGED by Spec 294 (= refresh doesn't steal CPU).
// On non-badline + no sprites, cycle 12 = CPU.
check("non-badline cycle 12 → CPU (refresh shares phi)",
  m.getBusOwner(12, false, 0) === "cpu");
// On badline, cycles 11..15 still VIC because badline DMA covers them.
check("badline cycle 12 → VIC (badline overlap)",
  m.getBusOwner(12, true, 0) === "vic");

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
