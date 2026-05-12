// LNR headless w/ BK at $0199 (post-depack, just before STA $01).
// If hit: depacker finished — dump $4000-$5000 + ZP state.
// If miss: depacker fails — dump trace context at last PC.

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

console.log("LOAD...");
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
console.log(`  after LOAD: pc=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);

console.log("RUN + BK on $0199...");
session.typeText("RUN\r");

const BK = new Set([0x0199]);
const BUDGET = 300_000_000;
const STEP = 1_000_000;
let total = 0;
let result = null;
while (total < BUDGET) {
  const r = session.runFor(STEP, { breakpoints: BK });
  total += r.instructionsExecuted;
  if (r.aborted === "breakpoint") {
    result = { hit: true, cyc: session.c64Cpu.cycles, pc: session.c64Cpu.pc };
    break;
  }
  // periodic status
  if (total % 50_000_000 === 0 || total < 5_000_000) {
    process.stdout.write(`  cyc=${session.c64Cpu.cycles} pc=$${session.c64Cpu.pc.toString(16)}\n`);
  }
}

if (result) {
  console.log(`\n*** BK $0199 HIT *** cyc=${result.cyc} pc=$${result.pc.toString(16)}`);
  const cpu = session.c64Cpu;
  console.log(`  regs: A=$${cpu.a.toString(16)} X=$${cpu.x.toString(16)} Y=$${cpu.y.toString(16)} SP=$${cpu.sp.toString(16)} P=$${(cpu.flags ?? cpu.p ?? 0).toString(16)}`);
  // ZP critical
  const ram = session.c64Bus.ram;
  console.log(`  ZP \$00=$${ram[0].toString(16)} \$01=$${ram[1].toString(16)}`);
  console.log(`  ZP \$2D=$${ram[0x2d].toString(16)} \$2E=$${ram[0x2e].toString(16)} \$2F=$${ram[0x2f].toString(16)} \$30=$${ram[0x30].toString(16)}`);
  console.log(`  ZP \$B7=$${ram[0xb7].toString(16)}`);
  // $4000 first 32 bytes (game entry)
  let s = "  \$4000: ";
  for (let i = 0; i < 32; i++) s += ram[0x4000+i].toString(16).padStart(2,"0") + " ";
  console.log(s);
  // $FF00 (depack-end copy target)
  s = "  \$FF00: ";
  for (let i = 0; i < 16; i++) s += ram[0xff00+i].toString(16).padStart(2,"0") + " ";
  console.log(s);
} else {
  console.log(`\n*** BK $0199 NEVER HIT *** total=${total} pc=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);
  const ram = session.c64Bus.ram;
  console.log(`  ZP \$01=$${ram[1].toString(16)} \$2D=$${ram[0x2d].toString(16)} \$2E=$${ram[0x2e].toString(16)} \$2F=$${ram[0x2f].toString(16)} \$30=$${ram[0x30].toString(16)}`);
}
process.exit(0);
