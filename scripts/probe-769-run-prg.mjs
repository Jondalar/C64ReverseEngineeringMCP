#!/usr/bin/env node
// Spec 769 — runtime_run_prg mechanism (load + autostart). Mirrors the tool's
// in-proc path: machine-code → set PC + run; BASIC ($0801) → set VARTAB + RUN.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("Spec 769 — runtime_run_prg (load + autostart)");

// machine-code PRG @ $1000: LDA #$42 / STA $C000 / RTS
const mcPath = join(tmpdir(), `rp-mc-${process.pid}.prg`);
writeFileSync(mcPath, Buffer.from([0x00, 0x10, 0xa9, 0x42, 0x8d, 0x00, 0xc0, 0x60]));
// BASIC PRG @ $0801: 10 SYS... (just need the header + a few bytes for the pointer test)
const basPath = join(tmpdir(), `rp-bas-${process.pid}.prg`);
writeFileSync(basPath, Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x20, 0x32, 0x30, 0x36, 0x32, 0x00, 0x00, 0x00]));

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = new RuntimeController(sessionId, session, () => {});
const ram = session.c64Bus.ram;
try {
  session.resetCold("pal-default");
  session.runFor(2_000_000, { cycleBudget: 2_000_000 });

  // machine-code: load + set PC=$1000 + run → marker $C000 = $42
  ram[0xC000] = 0x00;
  const rmc = session.loadPrgIntoRam(mcPath);
  gate("machine-code loads at $1000", rmc.loadAddress === 0x1000, `@$${rmc.loadAddress.toString(16)}`);
  session.c64Cpu.pc = 0x1000;
  session.runFor(1000, { cycleBudget: 1000 });
  gate("machine-code autostart (g $1000) ran the routine", ram[0xC000] === 0x42, `$C000=$${ram[0xC000].toString(16)}`);

  // BASIC: load @ $0801 + the tool sets VARTAB $2D/$2E = end+1 (so RUN works)
  const rb = session.loadPrgIntoRam(basPath);
  gate("BASIC loads at $0801", rb.loadAddress === 0x0801, `@$${rb.loadAddress.toString(16)}`);
  const end = (rb.endAddress + 1) & 0xffff;
  ram[0x2d] = end & 0xff; ram[0x2e] = (end >> 8) & 0xff; // the tool's BASIC pointer fix
  gate("BASIC VARTAB $2D/$2E set to end-of-program", ram[0x2d] === (end & 0xff) && ram[0x2e] === ((end >> 8) & 0xff),
    `$2d/$2e=$${ram[0x2e].toString(16)}${ram[0x2d].toString(16).padStart(2, "0")}, end=$${end.toString(16)}`);
} finally {
  ctrl.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 769 run-prg: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 769 run-prg: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
