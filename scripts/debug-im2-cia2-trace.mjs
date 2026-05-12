// Trace CIA2 PRA writes during IM2 boot
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

// Monkeypatch cia2 PRA writes
const cia2 = session.cia2;
const origPraSet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cia2), "pra")?.set;
const writes = [];
let lastPra = -1;
function pollPra() {
  const cur = cia2.pra;
  if (cur !== lastPra) {
    writes.push({ cyc: session.c64Cpu.cycles, pc: session.c64Cpu.pc, pra: cur });
    lastPra = cur;
  }
}

session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
pollPra();
console.log(`READY: pra=$${cia2.pra.toString(16)}`);

await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));
session.typeText('LOAD"*",8,1\r');

// Poll every 100k cycles during load
for (let i = 0; i < 600; i++) {
  session.runFor(100_000, { cycleBudget: 100_000 });
  pollPra();
}
console.log(`POST-LOAD: pra=$${cia2.pra.toString(16)} writes=${writes.length}`);

session.typeText("RUN\r");
for (let i = 0; i < 600; i++) {
  session.runFor(100_000, { cycleBudget: 100_000 });
  pollPra();
}
console.log(`POST-RUN: pra=$${cia2.pra.toString(16)} total writes=${writes.length}`);

// Print first 20 transitions
console.log("--- PRA transitions ---");
for (const w of writes.slice(0, 30)) {
  console.log(`  cyc=${w.cyc} pc=$${w.pc.toString(16)} pra=$${w.pra.toString(16)} bank=${(~w.pra)&3}`);
}
process.exit(0);
