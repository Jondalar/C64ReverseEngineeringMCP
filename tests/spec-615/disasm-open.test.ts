// Dump drive ROM bytes at OPEN entry through op021 + LOADIR to verify path.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(
  session,
  8,
  resolvePath(import.meta.dirname, "..", "..", "samples/POLARBEAR.d64"),
);
session.resetCold("pal-default");
session.runFor(2_000_000);

const vice = session.kernel.drive1541!;
const drv = (vice as { unit: unknown }).unit as { cpud: any };
function drvR(a: number): number {
  const fn = drv.cpud?.read_func_ptr?.[(a >> 8) & 0xff];
  return fn ? fn(drv, a) & 0xff : 0;
}
function hex(n: number, w = 2): string {
  return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0");
}

console.log("OPEN body $D7B4-$D7E5:");
for (let a = 0xd7b4; a < 0xd7e5; a += 8) {
  let l = `  $${hex(a, 4)}: `;
  for (let i = 0; i < 8 && a + i <= 0xd7e5; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}
console.log("\nop021 area $D7F3-$D820:");
for (let a = 0xd7f3; a < 0xd820; a += 8) {
  let l = `  $${hex(a, 4)}: `;
  for (let i = 0; i < 8 && a + i <= 0xd820; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}
console.log("\nop90 area $D940-$D965:");
for (let a = 0xd940; a < 0xd965; a += 8) {
  let l = `  $${hex(a, 4)}: `;
  for (let i = 0; i < 8 && a + i <= 0xd965; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}
console.log("\nLOADIR area $DA55-$DA80:");
for (let a = 0xda55; a < 0xda80; a += 8) {
  let l = `  $${hex(a, 4)}: `;
  for (let i = 0; i < 8 && a + i <= 0xda80; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}
console.log(`\ncmdset $C2B3-$C2E5:`);
for (let a = 0xc2b3; a < 0xc2e5; a += 8) {
  let l = `  $${hex(a, 4)}: `;
  for (let i = 0; i < 8 && a + i <= 0xc2e5; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}
