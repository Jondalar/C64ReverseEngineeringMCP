// Scan all VIC banks for IM2 bitmap signature
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.typeText("RUN\r");
session.runFor(60_000_000, { cycleBudget: 60_000_000 });

const ram = session.c64Bus.ram;

function countNonZero(start, len) {
  let nz = 0;
  for (let i = 0; i < len; i++) if (ram[start + i]) nz++;
  return nz;
}
function distinctBytes(start, len) {
  const s = new Set();
  for (let i = 0; i < len; i++) s.add(ram[start + i]);
  return s.size;
}

// Scan each VIC bank for screen+bitmap activity
console.log("=== RAM region density ===");
for (const [name, start] of [
  ["$0000-$0FFF (zp+stack+low)", 0x0000],
  ["$0400-$07FF (default screen)", 0x0400],
  ["$1000-$1FFF (chargen-overlay in bank 0)", 0x1000],
  ["$2000-$3FFF (bitmap in bank 0 if D018=$08)", 0x2000],
  ["$4000-$5FFF (bank 1 low)", 0x4000],
  ["$6000-$7FFF (bank 1 high — possible bitmap base)", 0x6000],
  ["$8000-$9FFF (bank 2 low)", 0x8000],
  ["$A000-$BFFF (bank 2 high)", 0xA000],
  ["$C000-$DFFF (bank 3 low — our current screen base)", 0xC000],
  ["$E000-$FFFF (bank 3 high — our current bitmap base)", 0xE000],
]) {
  const nz = countNonZero(start, 0x2000);
  const distinct = distinctBytes(start, 0x2000);
  console.log(`  ${name}: nz=${nz}/${0x2000} distinct=${distinct}`);
}

// Look for likely screen RAM (= varying bytes in 1KB-aligned region)
console.log("\n=== Likely screen RAMs (1KB blocks with high variance) ===");
for (let base = 0x0000; base < 0x10000; base += 0x400) {
  const distinct = distinctBytes(base, 0x400);
  if (distinct >= 8 && distinct <= 60) {  // not boring, not chaos
    const nz = countNonZero(base, 0x400);
    if (nz > 100 && nz < 1000) {
      console.log(`  $${base.toString(16).padStart(4,"0")}: distinct=${distinct} nz=${nz}`);
    }
  }
}

// CIA2 PA writes — track recent
console.log("\n=== CIA2 PRA + DDR ===");
const cia2 = session.cia2;
console.log(`  cia2.pra=$${cia2.pra.toString(16)} cia2.ddra=$${cia2.ddra.toString(16)}`);
const bank = (~cia2.pra) & 0x03;
console.log(`  effective VIC bank=${bank} base=$${(bank*0x4000).toString(16).padStart(4,"0")}`);

process.exit(0);
