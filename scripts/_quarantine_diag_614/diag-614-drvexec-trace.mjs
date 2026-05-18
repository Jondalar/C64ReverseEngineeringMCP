#!/usr/bin/env node
// Codex P0 follow-up — capture drivecpu_execute caller + clk evolution.
// Looks for: clk_value < last_clk (out-of-order caller).

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

// Arm diag (read by drivecpu.ts module).
globalThis.__drvexec_diag = { hits: [], enabled: false, max: 40 };

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");

// Boot — diag off (avoid 1.78M hits).
session.runFor(2_000_000);

// Arm diag, type LOAD, capture first 40 calls.
globalThis.__drvexec_diag.enabled = true;
session.typeText('LOAD"$",8\r', 80_000, 80_000);
// Run just long enough to capture 40 calls.
while (globalThis.__drvexec_diag.hits.length < 40) session.runFor(100);
globalThis.__drvexec_diag.enabled = false;

const hits = globalThis.__drvexec_diag.hits;
console.log(`Captured ${hits.length} drivecpu_execute calls`);
console.log("");
console.log("idx | caller                                          | clk        | last_clk   | drv.clk_ptr | wrap?");
console.log("----+-------------------------------------------------+------------+------------+-------------+------");
for (const h of hits) {
  const wrap = h.clk < h.last_clk ? "  *OUT-OF-ORDER*" : "";
  console.log(`${String(h.i).padStart(3)} | ${h.caller.padEnd(47).slice(0, 47)} | ${String(h.clk).padStart(10)} | ${String(h.last_clk).padStart(10)} | ${String(h.clk_ptr).padStart(11)} |${wrap}`);
}

// Summary: count out-of-order.
const ooo = hits.filter(h => h.clk < h.last_clk);
console.log(`\nOut-of-order (clk < last_clk): ${ooo.length}/${hits.length}`);
const callers = new Map();
for (const h of ooo) callers.set(h.caller, (callers.get(h.caller) ?? 0) + 1);
for (const [c, n] of callers) console.log(`  ${c}: ${n}`);
