#!/usr/bin/env node
// Spec 286 — CIA2 PA bank-switch cycle-exact smoke.
// Verify recordCia2PaChange immediately updates vbank_phi1/phi2.

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

console.log("=== Spec 286 CIA2 PA bank cycle-exact smoke ===\n");

const { session } = startIntegratedSession({
  diskPath: resolvePath(REPO, "samples/motm.g64"),
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "vice-rasterized",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });

const vic = session.vic;
const initialBankPhi1 = vic.vbank_phi1;
const initialBankPhi2 = vic.vbank_phi2;

// CIA2 PA bits 0..1 inverted: PA=0x3 → bank 0 = $0000;
//                              PA=0x2 → bank 1 = $4000;
//                              PA=0x1 → bank 2 = $8000;
//                              PA=0x0 → bank 3 = $C000.

vic.recordCia2PaChange(0x03); // bank 0
check("PA=0x3 → vbank_phi1 = 0x0000",
  vic.vbank_phi1 === 0x0000, `got=0x${vic.vbank_phi1.toString(16)}`);
check("PA=0x3 → vbank_phi2 = 0x0000",
  vic.vbank_phi2 === 0x0000);

vic.recordCia2PaChange(0x00); // bank 3
check("PA=0x0 → vbank_phi1 = 0xC000",
  vic.vbank_phi1 === 0xC000, `got=0x${vic.vbank_phi1.toString(16)}`);

vic.recordCia2PaChange(0x02); // bank 1
check("PA=0x2 → vbank_phi1 = 0x4000",
  vic.vbank_phi1 === 0x4000, `got=0x${vic.vbank_phi1.toString(16)}`);

vic.recordCia2PaChange(0x01); // bank 2
check("PA=0x1 → vbank_phi1 = 0x8000",
  vic.vbank_phi1 === 0x8000, `got=0x${vic.vbank_phi1.toString(16)}`);

// Mid-line write should still be in log AND live state updated
const beforeLog = vic.currentLineLog.writes.length;
vic.recordCia2PaChange(0x03);
check("recordCia2PaChange logs the event (= mid-line trace)",
  vic.currentLineLog.writes.length === beforeLog + 1);
check("...and live bank updated synchronously",
  vic.vbank_phi1 === 0x0000);

console.log(`\n${pass}/${pass + fail} pass${fail > 0 ? ` (${fail} fail)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
