#!/usr/bin/env node
// Capture every drivecpu_execute call where drv.clk_ptr jumps >100K.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

globalThis.__drvexec_diag = { hits: [], enabled: false, max: 20 };

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

globalThis.__drvexec_diag.enabled = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
while (session.c64Cpu.cycles < target) {
  session.runFor(50_000);
  if (globalThis.__drvexec_diag.hits.length >= 5) break;
}
globalThis.__drvexec_diag.enabled = false;

const hits = globalThis.__drvexec_diag.hits;
console.log(`Found ${hits.length} abnormal jumps (drv.clk_ptr delta > 100K)\n`);
console.log("idx | caller                                          | clk_value  | last_clk   | clk_ptr_before | clk_ptr_after | delta");
console.log("----+-------------------------------------------------+------------+------------+----------------+---------------+------------");
for (const h of hits) {
  const delta = (h.clk_ptr_after - h.clk_ptr_before) >>> 0;
  console.log(`${String(h.i).padStart(3)} | ${h.caller.padEnd(47).slice(0, 47)} | ${String(h.clk).padStart(10)} | ${String(h.last_clk).padStart(10)} | ${String(h.clk_ptr_before).padStart(14)} | ${String(h.clk_ptr_after).padStart(13)} | ${String(delta).padStart(10)}`);
  console.log(`    | stop_clk before=${h.stop_clk_before} after=${h.stop_clk_after}`);
}
