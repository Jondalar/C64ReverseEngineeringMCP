// Spec 429 — headless LNR boot + raster-IRQ split-state probe.
//
// Run:  npm run build:mcp && node scripts/lnr-headless-probe.mjs
//
// THE #1 GOTCHA (why a naive headless boot of LNR fails): you MUST boot the
// machine EMPTY first, THEN insert the disk via mountMedia(). If you attach
// the disk through the session ctor `diskPath` (disk present during the cold
// boot), LNR's fastloader LOAD never engages — the C64 just sits at the BASIC
// idle loop ($e5cd) and nothing loads. mountMedia-after-boot = how the UI and
// a real C64 do it, and LNR loads cleanly.
//
// Other essentials:
//   - drive1541 defaults to "vice" — do NOT override it.
//   - the LNR load is LONG (KERNAL boot file + the $DD00 streaming loader);
//     give it ~60M cycles for LOAD"*" and ~180M+ after RUN before the intro.
//   - to catch the intro raster IRQ, runFor with a breakpoint at $106F.
//   - read live VIC state from the literal-port singleton LIT_TYPES.vicii
//     (NOT session.vic — the legacy VicIIVice fields like raster_y stay 0 in
//     literal-port mode).

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import * as LIT from "../dist/runtime/headless/vic/literal/vicii-types.js";
import { resolve } from "node:path";

const G64 = resolve("samples/last_ninja_remix_s1[system3_1991].g64");

// 1) start an EMPTY session (no diskPath), boot to BASIC READY.
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  // drive1541 omitted → defaults to "vice"
});
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
console.log(`empty boot: C64 PC=$${session.c64Cpu.pc.toString(16)}`);

// 2) INSERT the disk (mountMedia) — the working path.
await mountMedia(session, 8, G64);
console.log("mounted LNR s1");

// 3) LOAD"*",8,1 then RUN. The boot file load takes ~60M cycles.
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
console.log(`after LOAD: C64 PC=$${session.c64Cpu.pc.toString(16)}`);
session.typeText("RUN\r");

// 4) run until the intro raster-IRQ handler entry $106F (the $DD00 streaming
//    load + intro install happen first; give it a generous budget).
let hit = false;
for (let i = 0; i < 80 && !hit; i++) {
  const r = session.runFor(3_000_000, { cycleBudget: 3_000_000, breakpoints: new Set([0x106f]) });
  if (r.aborted === "breakpoint") hit = true;
}

// 5) dump the raster-split state (the bug surface).
const v = LIT.vicii;
const hx = (n, w = 2) => "$" + (n >>> 0).toString(16).padStart(w, "0");
console.log(`\n=== intro raster IRQ $106F ${hit ? "HIT" : "NOT hit (raise the budget)"} ===`);
console.log(`C64 PC          = ${hx(session.c64Cpu.pc, 4)}`);
console.log(`raster_line     = ${v.raster_line}`);
console.log(`raster_irq_line = ${v.raster_irq_line}  ${v.raster_irq_line >= 256 ? "(>=256 → in-range storm compare)" : "(<256)"}`);
console.log(`D011 ($d011)    = ${hx(v.regs[0x11])}  RST8(bit7)=${(v.regs[0x11] >> 7) & 1}`);
console.log(`D012 ($d012)    = ${hx(v.regs[0x12])}  ${v.regs[0x12] === 0x2f ? "($2F=47 split → 303 storm)" : v.regs[0x12] === 0xf7 ? "($F7=247 split → 503 safe)" : ""}`);
console.log(`irq_status      = ${hx(v.irq_status)}  regs[0x1a](enable)=${hx(v.regs[0x1a])}`);

// 6) optional: render a screenshot to eyeball game-vs-intro.
session.renderToPng("/tmp/lnr-headless-probe.png", { frameAligned: false });
console.log(`\nscreenshot: /tmp/lnr-headless-probe.png`);
process.exit(0);
