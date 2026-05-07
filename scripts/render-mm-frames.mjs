#!/usr/bin/env node
// Render Maniac Mansion side 1 boot as frame sequence.

import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { startIntegratedSession } from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const RUN_SEC = Number(process.env.RUN_SEC ?? 60);
const RENDER_EVERY_CYC = Number(process.env.RENDER_EVERY_CYC ?? 2_955_744); // ~3s
const PAL_CYCLES_PER_SEC = 985_248;
const TARGET_CYCLES = RUN_SEC * PAL_CYCLES_PER_SEC;
const DISK = resolvePath("samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64");
const OUT_DIR = resolvePath("samples/screenshots/mm-frames");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`render-mm-frames`);
console.log(`  disk        : ${DISK}`);
console.log(`  RUN_SEC     : ${RUN_SEC}`);
console.log(`  every cyc   : ${RENDER_EVERY_CYC} (${(RENDER_EVERY_CYC / PAL_CYCLES_PER_SEC).toFixed(2)}s)`);
console.log(`  out dir     : ${OUT_DIR}`);

const t0 = Date.now();
const { session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive" });
session.resetCold("pal-default");

session.renderToPng(join(OUT_DIR, "frame-000-cold.png"));
console.log(`  frame 000 cold`);

session.runFor(800_000);
session.renderToPng(join(OUT_DIR, "frame-001-ready.png"));
console.log(`  frame 001 ready PC=$${session.c64Cpu.pc.toString(16)}`);

// MM uses BOOT-style; use LOAD"*",8,1 then RUN as standard.
session.typeText('LOAD"MM",8,1\r', 80_000, 80_000);
session.renderToPng(join(OUT_DIR, "frame-002-load-typed.png"));
console.log(`  frame 002 LOAD typed`);

const c64Cpu = session.c64Cpu;
const drvCpu = session.drive.cpu;
let nextRenderCyc = c64Cpu.cycles + RENDER_EVERY_CYC;
let frameIdx = 3;
while (c64Cpu.cycles < TARGET_CYCLES) {
  session.runFor(50_000);
  if (c64Cpu.cycles >= nextRenderCyc) {
    const sec = (c64Cpu.cycles / PAL_CYCLES_PER_SEC).toFixed(1);
    const idx = frameIdx.toString().padStart(3, "0");
    const path = join(OUT_DIR, `frame-${idx}-t${sec}s.png`);
    const r = session.renderToPng(path);
    console.log(`  frame ${idx} t=${sec}s -> ${r.bytes} bytes (PC=$${c64Cpu.pc.toString(16)} drvPC=$${drvCpu.pc.toString(16)})`);
    frameIdx++;
    nextRenderCyc += RENDER_EVERY_CYC;
  }
}

console.log(`done. ${frameIdx} frames in ${Date.now() - t0}ms`);
