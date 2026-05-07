#!/usr/bin/env node
// Render motm headless run as a sequence of PNG frames.
// Boots motm, types LOAD"*",8,1, runs to budget, dumps a frame every
// `RENDER_EVERY_CYC` C64 cycles into samples/screenshots/motm-frames/.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { startIntegratedSession } from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const RUN_SEC = Number(process.env.RUN_SEC ?? 30);
const RENDER_EVERY_CYC = Number(process.env.RENDER_EVERY_CYC ?? 985_248); // 1 PAL second
const OUT_DIR = resolvePath("samples/screenshots/motm-frames");
const PAL_CYCLES_PER_SEC = 985_248;
const TARGET_CYCLES = RUN_SEC * PAL_CYCLES_PER_SEC;
const DISK = resolvePath("samples/motm.g64");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`render-motm-frames`);
console.log(`  disk        : ${DISK}`);
console.log(`  RUN_SEC     : ${RUN_SEC}`);
console.log(`  every cyc   : ${RENDER_EVERY_CYC} (${(RENDER_EVERY_CYC / PAL_CYCLES_PER_SEC).toFixed(2)}s)`);
console.log(`  out dir     : ${OUT_DIR}`);

const t0 = Date.now();
const { session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive" });
session.resetCold("pal-default");

// Frame 0: cold-reset state (before any boot).
const f0Path = join(OUT_DIR, "frame-000-cold.png");
const f0 = session.renderToPng(f0Path);
console.log(`  frame 000 cold -> ${f0Path} ${f0.width}x${f0.height} (${f0.bytes} bytes)`);

// Boot KERNAL ~0.8s.
session.runFor(800_000);
const f1Path = join(OUT_DIR, "frame-001-ready.png");
const f1 = session.renderToPng(f1Path);
console.log(`  frame 001 ready -> ${f1Path} ${f1.bytes} bytes (PC=$${session.c64Cpu.pc.toString(16)})`);

session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
const f2Path = join(OUT_DIR, "frame-002-load-typed.png");
const f2 = session.renderToPng(f2Path);
console.log(`  frame 002 LOAD typed -> ${f2Path} ${f2.bytes} bytes (PC=$${session.c64Cpu.pc.toString(16)})`);

const c64Cpu = session.c64Cpu;
let nextRenderCyc = c64Cpu.cycles + RENDER_EVERY_CYC;
let frameIdx = 3;
while (c64Cpu.cycles < TARGET_CYCLES) {
  session.runFor(50_000);
  if (c64Cpu.cycles >= nextRenderCyc) {
    const sec = (c64Cpu.cycles / PAL_CYCLES_PER_SEC).toFixed(1);
    const idx = frameIdx.toString().padStart(3, "0");
    const path = join(OUT_DIR, `frame-${idx}-t${sec}s.png`);
    const r = session.renderToPng(path);
    console.log(`  frame ${idx} t=${sec}s -> ${path} ${r.bytes} bytes (PC=$${c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)})`);
    frameIdx++;
    nextRenderCyc += RENDER_EVERY_CYC;
  }
}

const ms = Date.now() - t0;
console.log(`done. ${frameIdx} frames in ${ms}ms`);
