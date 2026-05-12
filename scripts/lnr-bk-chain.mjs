// LNR multi-checkpoint: hit each BK in order, dump state.
// $0199 = post-depack (depacker finished)
// $4000 = game entry (M-W setup begins)
// $401C = first CIOUT call ("M")
// $A7AE = BASIC warmstart (= FAILURE exit)

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  driveDispatchMode: "vice-whole-instruction",
});
session.resetCold("pal-default");
session.runFor(5_000_000);
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
session.typeText("RUN\r");

function dump(label) {
  const ram = session.c64Bus.ram;
  const cpu = session.c64Cpu;
  const drv = session.drive;
  console.log(`\n=== ${label} ===`);
  console.log(`  c64.pc=$${cpu.pc.toString(16)} A=$${cpu.a.toString(16)} X=$${cpu.x.toString(16)} Y=$${cpu.y.toString(16)} SP=$${cpu.sp.toString(16)} P=$${(cpu.flags ?? cpu.p ?? 0).toString(16)} cyc=${cpu.cycles}`);
  console.log(`  drive.pc=$${(drv.cpu.pc ?? 0).toString(16)} cyc=${drv.cpu.cycles ?? 0}`);
  console.log(`  ZP \$00=$${ram[0].toString(16)} \$01=$${ram[1].toString(16)} \$2D=$${ram[0x2d].toString(16)} \$2E=$${ram[0x2e].toString(16)} \$2F=$${ram[0x2f].toString(16)} \$30=$${ram[0x30].toString(16)} \$B7=$${ram[0xb7].toString(16)} \$FB=$${ram[0xfb].toString(16)} \$FC=$${ram[0xfc].toString(16)}`);
}

function runUntilBk(bk, budget = 100_000_000) {
  const bkSet = new Set([bk]);
  const STEP = 1_000_000;
  let total = 0;
  while (total < budget) {
    const r = session.runFor(STEP, { breakpoints: bkSet });
    total += r.instructionsExecuted;
    if (r.aborted === "breakpoint") return true;
  }
  return false;
}

if (runUntilBk(0x0199)) {
  dump("BK $0199 (post-depack)");
} else {
  console.log("MISS $0199"); process.exit(1);
}

if (runUntilBk(0x4000)) {
  dump("BK $4000 (game entry)");
} else {
  console.log("MISS $4000"); process.exit(1);
}

if (runUntilBk(0x401C)) {
  dump("BK $401C (first CIOUT)");
}

if (runUntilBk(0xA7AE, 200_000_000)) {
  dump("BK $A7AE (BASIC warmstart = FAIL exit)");
} else {
  dump("NO BASIC EXIT — game made it past!");
}
process.exit(0);
