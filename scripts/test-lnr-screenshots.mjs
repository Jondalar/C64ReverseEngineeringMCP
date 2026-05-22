// Spec game-screenshot-gate — Last Ninja Remix s1 (LNR).
// GREEN target: reaches the SYSTEM3 / title / intro path (like VICE x64sc).
//
// Root cause (Spec 429): LNR's title code gates intro-vs-game on SID POTX
// ($D419) bit 7 ($0917 LDA $D419 / CMP #$00 / BMI $08F9 intro : JMP $0B7F game).
// Headless defaulted unconnected POTs to 0 (bit7=0 → game / Central Park);
// VICE returns $80 (bit7=1 → intro). Fixed in the SID/paddle POT default.
//
// GOTCHAS:
//  - boot the machine EMPTY first, THEN insert the disk via mountMedia()
//    (NOT the ctor diskPath — with the disk present at cold boot LNR's
//    fastloader LOAD never engages and the C64 sits at $e5cd).
//  - render with { frameAligned: false }. A frame-aligned render advances the
//    CPU (runUntilFrameReady, ~3 frames) which perturbs LNR's timing-sensitive
//    RUN -> SYS -> $DD00 fastloader and makes RUN fall back to ?SYNTAX ERROR.
//  - the LNR load is long; reach the title entry $4000 via a breakpoint loop.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});
const cpu = session.c64Cpu;

console.log("Boot empty...");
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
session.renderToPng("/tmp/lnr-00-ready.png", { frameAligned: false });
console.log("  /tmp/lnr-00-ready.png BASIC ready");

console.log("Mount LNR s1...");
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));

console.log('LOAD"*",8,1 + RUN');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/lnr-01-loaded.png", { frameAligned: false });
console.log("  /tmp/lnr-01-loaded.png after LOAD (~60s)");
session.typeText("RUN\r");

// Reach the title-file entry $4000 (load + unpack happen first).
let launched = false;
for (let i = 0; i < 120 && !launched; i++) {
  const r = session.runFor(3_000_000, { cycleBudget: 3_000_000, breakpoints: new Set([0x4000]) });
  if (r.aborted === "breakpoint") launched = true;
}
console.log(`reached $4000 title entry = ${launched}`);

// Confirm the intro branch ($08F9), not the in-game path ($0B7F). Spec 429.
let introBranch = false;
for (let i = 0; i < 80 && !introBranch; i++) {
  const r = session.runFor(3_000_000, { cycleBudget: 3_000_000, breakpoints: new Set([0x08f9]) });
  if (r.aborted === "breakpoint") introBranch = true;
}
console.log(`intro branch $08F9 (POTX bit7 set) = ${introBranch}`);

// Run into the intro and snapshot the SYSTEM3 / title sequence.
for (const sec of [5, 15, 30]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/lnr-t${sec.toString().padStart(3, "0")}s.png`;
  session.renderToPng(path, { frameAligned: false });
  console.log(`  ${path} +${sec}s PC=$${cpu.pc.toString(16)}`);
}

// Gate screenshot + final PC (intro region = GREEN; not a KERNAL stuck-PC).
session.renderToPng("/tmp/lnr-t090s.png", { frameAligned: false });
console.log(`  /tmp/lnr-t090s.png intro reached, PC=$${cpu.pc.toString(16)}`);
process.exit(0);
