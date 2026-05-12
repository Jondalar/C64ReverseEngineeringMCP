// Spec 428 Phase C — gate smoke: drive whole-instruction dispatch flag ON.
// Run IM2 + MM + Scramble + motm with the VICE-shaped drive path enabled.
//
// Expected:
//  - IM2 reaches PC=$48D3-$48EE title idle within 200M c64 cycles
//  - MM s1 reaches character select PC=$65f
//  - Scramble Infinity in game code $9xxx
//  - motm in main loop PC=$B7BF

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const results = [];

async function runGame(label, disk, timeoutMs, expectFn) {
  const { session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    driveDispatchMode: "vice-whole-instruction",  // <- Phase C flag ON
  });
  session.resetCold("pal-default");
  session.runFor(5_000_000);
  await mountMedia(session, 8, resolve(disk));
  session.typeText('LOAD"*",8,1\r');
  session.runFor(60_000_000);
  session.typeText("RUN\r");
  session.runFor(timeoutMs / 1000 * 1_000_000);
  const pc = session.c64Cpu.pc;
  const cyc = session.c64Cpu.cycles;
  const passed = expectFn(pc);
  results.push({ label, pc, cyc, passed });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${label} PC=$${pc.toString(16)} cyc=${cyc}`);
  return passed;
}

console.log("Spec 428 Phase C — drive whole-instruction flag ON smoke");
console.log("");

await runGame("IM2 title-idle",
  "samples/impossible_mission_ii[epyx_1987](!).g64",
  150_000,  // 150s emulated
  pc => pc >= 0x48d3 && pc <= 0x48ee);

await runGame("MM s1 char-select",
  "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
  180_000,
  pc => pc >= 0x500 && pc <= 0x7ff);  // main game loop $61b-$65f range

await runGame("Scramble Infinity in-game",
  "samples/scramble_infinity.d64",
  180_000,
  pc => pc >= 0x9000 && pc <= 0x9fff);

await runGame("motm main-loop",
  "samples/motm.g64",
  180_000,
  pc => pc === 0xb7bf || pc === 0xb7bd);

console.log("");
const fails = results.filter(r => !r.passed).length;
console.log(`summary: ${results.length - fails}/${results.length} pass, ${fails} fail`);

if (fails > 0) {
  console.log("");
  console.log("FAIL details:");
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  ${r.label}: PC=$${r.pc.toString(16)} at cycle ${r.cyc}`);
  }
}
process.exit(fails > 0 ? 1 : 0);
