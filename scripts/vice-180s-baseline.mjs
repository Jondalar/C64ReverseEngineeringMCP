#!/usr/bin/env node
// V2 1541-silicon prep — capture ~180 sec emulated VICE trace per game.
//
// Drives VICE forward via advanceInstructions(N) chunks, samples
// drive + C64 state each chunk, captures CpuHistory periodically.
//
// Output: samples/traces/v2-baseline/<game>/

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const VICE_X64SC = "/opt/homebrew/Cellar/vice/3.10/bin/x64sc";
const SAMPLES_ROOT = resolvePath("samples/traces/v2-baseline");

const games = [
  { id: "mm-s1",  disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64" },
  { id: "im2",    disk: "samples/impossible_mission_ii[epyx_1987](!).g64" },
  { id: "lnr-s1", disk: "samples/last_ninja_remix_s1[system3_1991].g64" },
  { id: "motm",   disk: "samples/motm.g64" },
  { id: "polarbear", disk: "samples/POLARBEAR.d64" },
];

const RUN_SEC_EMULATED = Number(process.env.RUN_SEC ?? 180);
const PORT_BASE = 6502;
const MEMSPACE_C64 = 0x00;
const MEMSPACE_DRIVE = 0x01;
const REG_PC = 3;
const REG_A = 0;
const INSTR_PER_CHUNK = 50_000;
const HISTORY_EVERY_CHUNKS = 20;
const HISTORY_DEPTH = 256;

const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runGame(g, port) {
  const outDir = resolvePath(SAMPLES_ROOT, g.id);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const diskAbs = resolvePath(g.disk);
  const args = [
    "-default", "-warp", "-autostart-warp",
    "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
    "-autostart", diskAbs,
  ];
  console.log(`[${g.id}] launching x64sc port ${port}`);
  const child = spawn(VICE_X64SC, args, { stdio: ["ignore", "ignore", "ignore"] });
  await sleep(2500);

  const client = new ViceMonitorClient({ host: "127.0.0.1", port });
  let connected = false;
  for (let i = 0; i < 12 && !connected; i++) {
    try { await client.connect(2000); connected = true; }
    catch { await sleep(500); }
  }
  if (!connected) { child.kill(); return; }
  console.log(`[${g.id}] binmon connected`);

  const samples = [];
  const driveHist = [];
  const c64Hist = [];
  const targetChunks = Math.ceil((RUN_SEC_EMULATED * 333_000) / INSTR_PER_CHUNK);
  console.log(`[${g.id}] targetChunks=${targetChunks}`);

  const startWallMs = Date.now();
  let chunk = 0;
  let firstEoiAt = -1;
  while (chunk < targetChunks) {
    try { await client.advanceInstructions(INSTR_PER_CHUNK, false); }
    catch (e) { console.log(`[${g.id}] advance err chunk ${chunk}: ${e.message}`); break; }
    chunk++;
    const ts = chunk * INSTR_PER_CHUNK;
    try {
      const c64Regs = await client.getRegisters(MEMSPACE_C64);
      const drvRegs = await client.getRegisters(MEMSPACE_DRIVE);
      const z90 = (await client.readMemory(0x90, 0x90, 0, MEMSPACE_C64))[0];
      const drvPb = (await client.readMemory(0x1800, 0x1800, 0, MEMSPACE_DRIVE))[0];
      const dd00 = (await client.readMemory(0xdd00, 0xdd00, 0, MEMSPACE_C64))[0];
      const c64Pc = c64Regs.find((r) => r.id === REG_PC)?.value ?? 0;
      const drvPc = drvRegs.find((r) => r.id === REG_PC)?.value ?? 0;
      samples.push({
        ts, c64Pc, drvPc,
        c64A: c64Regs.find((r) => r.id === REG_A)?.value ?? 0,
        drvA: drvRegs.find((r) => r.id === REG_A)?.value ?? 0,
        z90, dd00, drvPb,
      });
      if (firstEoiAt < 0 && (z90 & 0x40) !== 0) {
        firstEoiAt = ts;
        console.log(`[${g.id}] EOI at chunk ${chunk}`);
      }
    } catch (e) { console.log(`[${g.id}] sample err: ${e.message}`); }

    if (chunk % HISTORY_EVERY_CHUNKS === 0) {
      try {
        const c64H = await client.getCpuHistory(HISTORY_DEPTH, MEMSPACE_C64);
        const drvH = await client.getCpuHistory(HISTORY_DEPTH, MEMSPACE_DRIVE);
        c64Hist.push({ chunk, ts, items: c64H.slice(-32) });
        driveHist.push({ chunk, ts, items: drvH.slice(-32) });
      } catch { /* unsupported */ }
    }
  }
  const dtMs = Date.now() - startWallMs;
  console.log(`[${g.id}] ${samples.length} samples in ${dtMs}ms`);

  let driveRam = null, finalC64Regs = null, finalDrvRegs = null;
  try { driveRam = await client.readMemory(0x0000, 0x07ff, 0, MEMSPACE_DRIVE); } catch {}
  try { finalC64Regs = await client.getRegisters(MEMSPACE_C64); } catch {}
  try { finalDrvRegs = await client.getRegisters(MEMSPACE_DRIVE); } catch {}

  writeFileSync(resolvePath(outDir, "trace.jsonl"),
    samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(resolvePath(outDir, "c64-history.jsonl"),
    c64Hist.map((h) => JSON.stringify(h)).join("\n") + "\n");
  writeFileSync(resolvePath(outDir, "drive-history.jsonl"),
    driveHist.map((h) => JSON.stringify(h)).join("\n") + "\n");
  if (driveRam) writeFileSync(resolvePath(outDir, "drive-ram.bin"), driveRam);
  writeFileSync(resolvePath(outDir, "summary.json"), JSON.stringify({
    game: g.id, disk: g.disk, runSecEmulated: RUN_SEC_EMULATED,
    chunks: chunk, samples: samples.length, dtMs,
    instrPerChunk: INSTR_PER_CHUNK, firstEoiAt,
    finalC64Regs, finalDrvRegs,
    capturedAt: new Date().toISOString(),
  }, null, 2));

  client.close();
  await sleep(300);
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  console.log(`[${g.id}] saved → ${outDir}`);
}

const filter = process.argv[2];
const targets = filter ? games.filter((g) => g.id === filter) : games;
let port = PORT_BASE;
for (const g of targets) {
  await runGame(g, port);
  port++;
  await sleep(1500);
}
console.log("ALL DONE");
