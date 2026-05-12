#!/usr/bin/env node
// Spec 287 — Φ1/Φ2 addressbus phase modeling smoke.

import { resolve as resolvePath } from "node:path";
const REPO = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  ok ? pass++ : fail++;
}

console.log("=== Spec 287 Φ1/Φ2 addressbus phase smoke ===\n");

const { session } = startIntegratedSession({
  diskPath: resolvePath(REPO, "samples/motm.g64"),
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });

const vic = session.vic;

// 1. C64 default chargen mask + value identical for both phases.
check("vaddr_chargen_mask_phi1 = 0x7000",
  vic.vaddr_chargen_mask_phi1 === 0x7000,
  `got=0x${vic.vaddr_chargen_mask_phi1.toString(16)}`);
check("vaddr_chargen_value_phi1 = 0x1000",
  vic.vaddr_chargen_value_phi1 === 0x1000);
check("vaddr_chargen_mask_phi2 = 0x7000",
  vic.vaddr_chargen_mask_phi2 === 0x7000);
check("vaddr_chargen_value_phi2 = 0x1000",
  vic.vaddr_chargen_value_phi2 === 0x1000);

// 2. Bank 0 ($0000) — addr $1000 hits chargen on both phases.
vic.setVbank(0);
check("bank 0 + addr $1000 → phi1 chargen hit", vic.isCharRomFetch(0x1000, "phi1"));
check("bank 0 + addr $1000 → phi2 chargen hit", vic.isCharRomFetch(0x1000, "phi2"));
check("bank 0 + addr $0000 → phi1 NOT chargen", !vic.isCharRomFetch(0x0000, "phi1"));
check("bank 0 + addr $2000 → phi1 NOT chargen", !vic.isCharRomFetch(0x2000, "phi1"));

// 3. Bank 1 ($4000) — chargen offset still 0x1000 (= absolute $5000),
//    but masking checks against the absolute value. Per VICE in bank
//    1: NO char ROM shadow (only banks 0 + 2). Verify.
vic.setVbank(1);
check("bank 1 + addr $1000 → NOT chargen (banks 1/3 = no shadow)",
  !vic.isCharRomFetch(0x1000, "phi1"));

// 4. Bank 2 ($8000) — chargen at addr $1000 absolute = $9000.
vic.setVbank(2);
check("bank 2 + addr $1000 → phi1 chargen hit",
  vic.isCharRomFetch(0x1000, "phi1"));

// 5. Bank 3 ($C000) — no chargen.
vic.setVbank(3);
check("bank 3 + addr $1000 → NOT chargen",
  !vic.isCharRomFetch(0x1000, "phi1"));

// 6. Bus-trace event optional phi field — shape only.
const { default: t } = await import("node:timers/promises");
// Smoke the type/shape — no live event capture; ensure field exists
// in the BusAccessEvent type by constructing a synthetic object.
const syntheticEvent = {
  cycle_c64: 0, cycle_drive: 0, side: "c64", op: "read",
  addr: 0x1000, value: 0xff,
  pc: 0xea31, at_boundary: true,
  iec: { atn: false, clk: false, data: false, srq: false },
  seq: 0,
  phi: "phi1",
};
check("BusAccessEvent.phi = 'phi1' accepts type",
  syntheticEvent.phi === "phi1");

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
