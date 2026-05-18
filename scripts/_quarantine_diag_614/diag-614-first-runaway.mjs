#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

globalThis.__drv_first_big_jump = { logged: false, entries: [] };

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
console.log(`After boot: drv_clk=${session.kernel.drive1541.unit.clk_ptr.value} c64=${session.c64Cpu.cycles}`);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target && !globalThis.__drv_first_big_jump.logged) session.runFor(50_000);

console.log(`After LOAD: drv_clk=${session.kernel.drive1541.unit.clk_ptr.value} c64=${session.c64Cpu.cycles}`);
console.log(`Captured ${globalThis.__drv_first_big_jump.entries.length} jump/regress events:\n`);
for (const e of globalThis.__drv_first_big_jump.entries) {
  console.log(`[${e.kind}]`);
  console.log(`  clk_value=${e.clk_value} last_clk_before=${e.last_clk_before}`);
  console.log(`  clk_ptr_before=${e.clk_ptr_before} clk_ptr_after=${e.clk_ptr_after} delta=${e.delta}`);
  console.log(`  stop_clk_before=${e.stop_clk_before} stop_clk_after=${e.stop_clk_after}`);
  console.log(`  stack:`);
  for (const line of e.stack) console.log(`    ${line}`);
  console.log("");
}
