#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

globalThis.__drv_first_big_jump = { logged: false, entries: [], ring: [], regresses: [] };

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

// Capture from boot onward (don't reset entries).
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 12 * PAL_HZ;
// Stop early once we have 200 entries.
while (session.c64Cpu.cycles < target && globalThis.__drv_first_big_jump.regresses.length < 20) {
  session.runFor(50_000);
}
globalThis.__drv_first_big_jump.logged = true;

const regresses = globalThis.__drv_first_big_jump.regresses;
console.log(`Captured ${regresses.length} REGRESS events.\n`);
for (const r of regresses.slice(0, 5)) {
  console.log(`--- Regress #${r.idx} (with 3-call lookback) ---`);
  for (const e of r.context) {
    const reg = e.regress ? " *REGRESS*" : "";
    console.log(`   clk=${String(e.clk_value).padStart(10)} | last_before=${String(e.last_clk_before).padStart(10)} | ${e.caller}${reg}`);
  }
  console.log("");
}
