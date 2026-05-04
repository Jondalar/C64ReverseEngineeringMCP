#!/usr/bin/env node
// Sprint 96 — after LOAD attempt completes (FNF), dump drive's
// $0700 buffer area (where directory sector 18.1 should be decoded).
// Compare against known directory bytes from G64 parser.

import { existsSync, readFileSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"BOOT\",8,1\r", 80_000, 80_000);
session.runFor(40_000_000);

const ram = session.drive.bus.ram;
const W = (n) => "$"+(n & 0xff).toString(16).padStart(2,"0");

// Drive RAM is only $0000-$07FF. So $0700-$07FF is the LAST page.
console.log(`Drive RAM $0700..$07FF (channel-0 / dir buffer):`);
for (let row = 0x0700; row < 0x0800; row += 32) {
  let hex = "";
  let asc = "";
  for (let i = 0; i < 32; i++) {
    const c = ram[row + i];
    hex += c.toString(16).padStart(2, "0") + " ";
    asc += (c >= 0x20 && c < 0x7e) ? String.fromCharCode(c) : ".";
  }
  console.log(`  $${row.toString(16)}: ${hex}|${asc}|`);
}

console.log(`\nDrive RAM $0300..$03FF (job/header buffers):`);
for (let row = 0x0300; row < 0x0400; row += 32) {
  let hex = "";
  let asc = "";
  for (let i = 0; i < 32; i++) {
    const c = ram[row + i];
    hex += c.toString(16).padStart(2, "0") + " ";
    asc += (c >= 0x20 && c < 0x7e) ? String.fromCharCode(c) : ".";
  }
  console.log(`  $${row.toString(16)}: ${hex}|${asc}|`);
}

// Compare to expected directory (parse track 18 sector 1 ourselves).
const { G64Parser } = await import("../dist/disk/g64-parser.js");
const parser = new G64Parser(readFileSync(disk));
console.log(`\nExpected directory entry should contain "BOOT" or first file name`);
console.log(`Drive RAM $0200..$02FF (command channel buffer):`);
for (let row = 0x0200; row < 0x0300; row += 32) {
  let hex = "";
  let asc = "";
  for (let i = 0; i < 32; i++) {
    const c = ram[row + i];
    hex += c.toString(16).padStart(2, "0") + " ";
    asc += (c >= 0x20 && c < 0x7e) ? String.fromCharCode(c) : ".";
  }
  console.log(`  $${row.toString(16)}: ${hex}|${asc}|`);
}
