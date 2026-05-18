#!/usr/bin/env node
// Check drive VIA1 T1 zero alarm registration + alarm context.

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 6 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const vice = session.kernel.drive1541;
const drv = vice.unit;
const via1 = drv.via1d1541;
function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }

console.log(`drv.clk_ptr.value = ${drv.clk_ptr.value}`);
console.log(`via1.t1zero       = ${via1.t1zero}`);
console.log(`via1.t1reload     = ${via1.t1reload}`);
console.log(`via1.ifr          = $${hex(via1.ifr)} (bit 6 = T1)`);
console.log(`via1.tal          = ${via1.tal}`);
console.log(`via1.via[ACR=$0B] = $${hex(via1.via[0x0b] ?? 0)} (bit 6 = T1 free-run mode)`);
console.log("");

const alarm = via1.t1_zero_alarm;
console.log(`via1.t1_zero_alarm:`);
console.log(`  type: ${typeof alarm}`);
console.log(`  exists: ${alarm !== null && alarm !== undefined}`);
if (alarm) {
  console.log(`  pending_idx: ${alarm.pending_idx ?? "?"}`);
  console.log(`  context: ${alarm.context ? "set" : "null"}`);
  console.log(`  name: ${alarm.name}`);
}
console.log("");

// Drive alarm context.
const drvcpu_ctx = drv.cpu.alarm_context;
console.log(`Drive alarm_context:`);
console.log(`  name: ${drvcpu_ctx?.name}`);
console.log(`  num_pending_alarms: ${drvcpu_ctx?.num_pending_alarms ?? "?"}`);
console.log(`  next_pending_alarm_clk: ${drvcpu_ctx?.next_pending_alarm_clk ?? "?"}`);
if (drvcpu_ctx?.pending_alarms) {
  console.log(`  pending_alarms entries:`);
  const pa = drvcpu_ctx.pending_alarms;
  for (let i = 0; i < Math.min(pa.length, 8); i++) {
    if (pa[i]?.alarm) {
      console.log(`    [${i}] clk=${pa[i].clk}  name=${pa[i].alarm.name}`);
    }
  }
}

// Try manually triggering alarm dispatch.
console.log("\n=== Force alarm context dispatch ===");
const { alarmContextDispatch } = await import("../dist/runtime/headless/alarm/alarm-context.js");
alarmContextDispatch(drvcpu_ctx, drv.clk_ptr.value);
console.log(`After manual dispatch: via1.ifr = $${hex(via1.ifr)}`);
