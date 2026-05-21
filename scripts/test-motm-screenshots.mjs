import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";
// Boot EMPTY first, THEN insert the disk (mountMedia) — the real/UI path.
// Attaching via the ctor `diskPath` (disk present during the cold boot) leaves
// the drive in a state where motm's fastloader LOAD never engages (C64 sits at
// BASIC idle $e5cd). mountMedia-after-boot matches how a disk is actually
// inserted and motm loads cleanly.
const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "literal-port",
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
await mountMedia(session, 8, resolve("samples/motm.g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");
let total = 0;
// Option (a) PNG-stability cut: motm frames animated each second but PC
// stable in $b7bd main-loop region after ~150s; drop t180/t210/t240.
for (const sec of [30, 30, 30, 30, 30]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  total += sec;
  const path = `/tmp/motm-long-t${total.toString().padStart(3,"0")}s.png`;
  session.renderToPng(path);
  const v = session.vic.regs;
  const den = (v[0x11]>>4)&1;
  console.log(`  t=${total}s PC=$${session.c64Cpu.pc.toString(16)} D011=$${v[0x11].toString(16)} DEN=${den} D020=$${v[0x20].toString(16)}`);
}
process.exit(0);
