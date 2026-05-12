// Debug IM2 boot — capture VIC state + screenshots at boot stages.
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true,
  vicRenderer: "literal-port",
});

function snapshot(label) {
  const c64 = session.c64Cpu;
  const cia2 = session.cia2;
  const vic = session.vic;
  // CIA2 PA bank: bits 0..1 inverted = VIC bank base
  const banksel = (cia2.pra & 0x03);
  const bankBase = (3 - banksel) * 0x4000;
  // VIC D018 = video matrix (bits 4..7) + char/bitmap (bits 1..3)
  const d018 = vic.regs[0x18] ?? 0;
  const screenOff = ((d018 & 0xF0) >> 4) * 0x400;
  const charOff = ((d018 & 0x0E) >> 1) * 0x800;
  const screenAddr = bankBase + screenOff;
  const charAddr = bankBase + charOff;
  // D011 control register 1
  const d011 = vic.regs[0x11] ?? 0;
  const bmm = (d011 & 0x20) ? 1 : 0;  // bit 5 = bitmap mode
  const ecm = (d011 & 0x40) ? 1 : 0;  // bit 6 = extended color
  const den = (d011 & 0x10) ? 1 : 0;  // bit 4 = display enable
  // D016 mcm
  const d016 = vic.regs[0x16] ?? 0;
  const mcm = (d016 & 0x10) ? 1 : 0;
  const mode = (ecm << 2) | (bmm << 1) | mcm;
  console.log(`[${label}] PC=$${c64.pc.toString(16).padStart(4,"0")} cyc=${c64.cycles}`);
  console.log(`  CIA2 PA=$${cia2.pra.toString(16).padStart(2,"0")} DDR=$${cia2.ddra.toString(16).padStart(2,"0")} bank=${banksel} base=$${bankBase.toString(16).padStart(4,"0")}`);
  console.log(`  D011=$${d011.toString(16).padStart(2,"0")} D016=$${d016.toString(16).padStart(2,"0")} D018=$${d018.toString(16).padStart(2,"0")} mode=${mode} (ECM=${ecm} BMM=${bmm} MCM=${mcm} DEN=${den})`);
  console.log(`  screen=$${screenAddr.toString(16).padStart(4,"0")} char/bitmap=$${charAddr.toString(16).padStart(4,"0")}`);
  // Dump first 16 bytes of bitmap area + first 16 bytes of screen RAM
  const ram = session.c64Bus?.ram;
  if (ram) {
    const bmDump = Array.from(ram.slice(charAddr, charAddr + 32)).map(b => b.toString(16).padStart(2,"0")).join(" ");
    const scrDump = Array.from(ram.slice(screenAddr, screenAddr + 16)).map(b => b.toString(16).padStart(2,"0")).join(" ");
    console.log(`  bm[${charAddr.toString(16)}:+32]: ${bmDump}`);
    console.log(`  scr[${screenAddr.toString(16)}:+16]: ${scrDump}`);
    // Also dump first non-zero stretch near bitmap base
    let firstNz = -1;
    for (let i = 0; i < 8000; i++) {
      if (ram[charAddr + i]) { firstNz = i; break; }
    }
    console.log(`  bm first non-zero offset: ${firstNz}`);
  }
}

console.log("Boot empty...");
session.resetCold("pal-default");
session.runFor(5_000_000, { cycleBudget: 5_000_000 });
session.renderToPng("/tmp/im2-00-ready.png");
snapshot("READY");

console.log("Mount IM2...");
await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));

console.log('LOAD"*",8,1 + RUN');
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000, { cycleBudget: 60_000_000 });
session.renderToPng("/tmp/im2-01-loaded.png");
snapshot("LOADED");

session.typeText("RUN\r");
for (const sec of [5, 10, 20, 40, 60, 90, 120, 240, 360]) {
  session.runFor(sec * 1_000_000, { cycleBudget: sec * 1_000_000 });
  const path = `/tmp/im2-t${sec.toString().padStart(3,"0")}s.png`;
  session.renderToPng(path);
  snapshot(`t=${sec}s`);
}
process.exit(0);
