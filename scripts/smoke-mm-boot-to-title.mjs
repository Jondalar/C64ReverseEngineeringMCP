#!/usr/bin/env node
// Quick MM boot-to-title test: LOAD"*",8,1 + RUN + watch for title screen.
// MM title screen has distinctive sprites + "MANIAC MANSION" text in screen RAM.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { VicFramebuffer, renderFrame, computeVicBankBase } from "../dist/runtime/headless/peripherals/vic-renderer.js";
import { rgbaToPng } from "../dist/runtime/headless/peripherals/png-writer.js";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const disk = process.argv[2] ?? "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
const cycleBudget = Number(process.argv[3] ?? 200_000_000);

console.error(`MM boot-to-title test`);
console.error(`disk: ${disk}`);
console.error(`cycle-budget: ${cycleBudget.toLocaleString()}`);
console.error(`shifter flag: ${process.env.C64RE_USE_GCR_SHIFTER === "1" ? "ON" : "OFF"}`);

const { session } = startIntegratedSession({
  diskPath: resolve(process.cwd(), disk),
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});

const scheduler = session.scheduler;
session.resetCold();

if (scheduler) scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');
if (scheduler) scheduler.runCycles(8_000_000);
session.typeText("RUN\n");

console.error(`[load+run typed]`);

const startTs = Date.now();
let stepped = 0;
const chunk = 1_000_000;
while (stepped < cycleBudget) {
  if (scheduler) scheduler.runCycles(chunk);
  stepped += chunk;
  if (stepped % 20_000_000 === 0) {
    const c64Pc = session.c64Cpu.pc & 0xffff;
    const drvPc = session.drive.cpu.pc & 0xffff;
    const screen0 = readScreenSample(session);
    console.error(`  cyc=${stepped.toLocaleString()}  c64.pc=$${c64Pc.toString(16)}  drv.pc=$${drvPc.toString(16)}  screen[0..31]=${screen0}`);
  }
}

const elapsed = Date.now() - startTs;
console.error(`done. ${cycleBudget.toLocaleString()} cycles in ${elapsed}ms`);

// VIC state diagnostic
const d011 = session.c64Bus.read(0xD011);
const d016 = session.c64Bus.read(0xD016);
const d018 = session.c64Bus.read(0xD018);
const d020 = session.c64Bus.read(0xD020);
const d021 = session.c64Bus.read(0xD021);
console.error(`VIC: \$D011=$${d011.toString(16)} (display=${(d011 & 0x10) ? 'on' : 'off'} bitmap=${(d011 & 0x20) ? 'yes' : 'no'} ECM=${(d011 & 0x40) ? 'yes' : 'no'})  \$D016=$${d016.toString(16)} (multicolor=${(d016 & 0x10) ? 'yes' : 'no'})  \$D018=$${d018.toString(16)}  border=$${d020.toString(16)}  bg=$${d021.toString(16)}`);

// Render PNG.
const cia2Pa = session.c64Bus.read(0xDD00);
const vicBankBase = computeVicBankBase(cia2Pa & 0x03);
const fb = new VicFramebuffer(true);  // PAL
renderFrame(fb, { vic: session.vic, bus: session.c64Bus, vicBankBase });
const png = rgbaToPng(fb.width, fb.height, fb.pixels);
const flagSuffix = process.env.C64RE_USE_GCR_SHIFTER === "1" ? "shifter-on" : "shifter-off";
const pngPath = resolve(process.cwd(), `mm-title-${flagSuffix}.png`);
writeFileSync(pngPath, png);
console.error(`PNG written: ${pngPath}  (${fb.width}x${fb.height}, ${png.length} bytes)`);

const screenRam = readFullScreen(session);
const screenText = screenRamToText(screenRam);
console.error(`\n=== screen RAM (40x25) ===`);
console.error(screenText);

// Check for MM title indicators
const lower = screenText.toLowerCase();
const hasMM = lower.includes("maniac") || lower.includes("mansion");
const hasLucasfilm = lower.includes("lucasfilm") || lower.includes("activision");
console.error(`\n=== title indicators ===`);
console.error(`  "maniac/mansion" found: ${hasMM}`);
console.error(`  "lucasfilm/activision" found: ${hasLucasfilm}`);

if (hasMM || hasLucasfilm) {
  console.error(`\n✓ MM TITLE REACHED`);
  process.exit(0);
} else {
  console.error(`\n✗ No title detected (may need more cycles or boot stuck)`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readScreenSample(s) {
  const bus = s.c64Bus;
  const out = [];
  for (let i = 0; i < 32; i++) out.push(bus.read(0x0400 + i));
  return out.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readFullScreen(s) {
  const bus = s.c64Bus;
  const out = new Uint8Array(40 * 25);
  for (let i = 0; i < out.length; i++) out[i] = bus.read(0x0400 + i);
  return out;
}

function screenRamToText(ram) {
  // Convert C64 screen-code → ASCII (rough): 0-26 = '@A-Z', 32 = ' ', etc.
  let s = "";
  for (let row = 0; row < 25; row++) {
    let line = "";
    for (let col = 0; col < 40; col++) {
      const c = ram[row * 40 + col] ?? 0;
      let ch = ".";
      if (c === 0) ch = "@";
      else if (c >= 1 && c <= 26) ch = String.fromCharCode(64 + c);
      else if (c === 32) ch = " ";
      else if (c >= 48 && c <= 57) ch = String.fromCharCode(c);
      else if (c === 0x20) ch = " ";
      line += ch;
    }
    s += line + "\n";
  }
  return s;
}
