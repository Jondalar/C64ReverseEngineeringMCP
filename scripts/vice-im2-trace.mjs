// Capture VICE x64sc trace during IM2 boot for diff against our emulator.
// Spawns x64sc with binarymonitor, autostart IM2 G64, then samples
// CPU history, screen RAM, color RAM, CIA2 PA, VIC regs at intervals.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const port = 6502;
const vicePath = "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
const diskPath = join(repoRoot, "samples/impossible_mission_ii[epyx_1987](!).g64");

const outDir = join(repoRoot, "samples", "vice-trace-im2");
mkdirSync(outDir, { recursive: true });

try { execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" }); } catch {}
await new Promise(r => setTimeout(r, 500));

const viceArgs = [
  "-default",
  "-warp",
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-autostart", diskPath,
];
console.error(`Spawning: ${vicePath} ${viceArgs.join(" ")}`);
const child = spawn(vicePath, viceArgs, { stdio: ["ignore", "ignore", "ignore"] });

await new Promise(r => setTimeout(r, 3000));

const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");
const client = new ViceMonitorClient({ host: "127.0.0.1", port });

let connected = false;
for (let i = 0; i < 12; i++) {
  try { await client.connect(2000); connected = true; break; }
  catch { await new Promise(r => setTimeout(r, 500)); }
}
if (!connected) {
  console.error("FAIL: connect to binmon");
  child.kill("SIGKILL");
  process.exit(1);
}

const MEMSPACE_C64 = 0x00;
async function readBytes(start, end) {
  const buf = await client.readMemory(start, end, 0, MEMSPACE_C64);
  return Array.from(buf);
}
async function snap(label) {
  try {
    const hist = await client.getCpuHistory(8, MEMSPACE_C64);
    const last = hist[hist.length - 1];
    const cia2pa = (await readBytes(0xDD00, 0xDD00))[0];
    const cia2ddr = (await readBytes(0xDD02, 0xDD02))[0];
    const vicRegs = await readBytes(0xD000, 0xD02F);
    const screenC000 = await readBytes(0xC000, 0xC03F);
    const screen0400 = await readBytes(0x0400, 0x043F);
    const screen2800 = await readBytes(0x2800, 0x283F);
    const colorRam = await readBytes(0xD800, 0xD83F);
    const bmpE000 = await readBytes(0xE000, 0xE01F);
    return {
      label,
      pc: last ? Number(last.pc) : 0,
      clk: last ? Number(last.clock) : 0,
      cia2: { pra: cia2pa, ddra: cia2ddr },
      d011: vicRegs[0x11], d016: vicRegs[0x16], d018: vicRegs[0x18], d012: vicRegs[0x12],
      screenC000: screenC000.map(b => b.toString(16).padStart(2, "0")).join(" "),
      screen0400: screen0400.map(b => b.toString(16).padStart(2, "0")).join(" "),
      screen2800: screen2800.map(b => b.toString(16).padStart(2, "0")).join(" "),
      colorRam: colorRam.map(b => (b & 0xf).toString(16)).join(""),
      bmpE000: bmpE000.map(b => b.toString(16).padStart(2, "0")).join(" "),
    };
  } catch (e) {
    return { label, error: String(e) };
  }
}

// Resume execution from binmon prompt
try { await client.exit(); } catch {}

const samples = [];
// Sample at multiple boot stages
for (const sec of [5, 10, 20, 30, 45, 60]) {
  await new Promise(r => setTimeout(r, sec === 5 ? 5000 : (sec - samples[samples.length-1]?.targetSec ?? 0) * 1000 - 0));
  // Pause to read state
  try { await client.ping(); } catch {}
  // Wait for VICE to enter monitor on next safe stop — use a different approach:
  // send a CPU sample by getting current state without stopping
  const s = await snap(`t=${sec}s`);
  s.targetSec = sec;
  samples.push(s);
  console.log(`[${s.label}] PC=$${s.pc?.toString(16)} clk=${s.clk}`);
  if (s.d011 !== undefined) {
    console.log(`  D011=$${s.d011.toString(16)} D016=$${s.d016.toString(16)} D018=$${s.d018.toString(16)}`);
    console.log(`  CIA2 pra=$${s.cia2.pra.toString(16)} ddra=$${s.cia2.ddra.toString(16)}`);
    console.log(`  scr@$C000[0..16]: ${s.screenC000.split(" ").slice(0, 16).join(" ")}`);
    console.log(`  scr@$2800[0..16]: ${s.screen2800.split(" ").slice(0, 16).join(" ")}`);
    console.log(`  bmp@$E000[0..16]: ${s.bmpE000.split(" ").slice(0, 16).join(" ")}`);
    console.log(`  colorRAM[0..40]: ${s.colorRam.slice(0, 40)}`);
  }
}

writeFileSync(join(outDir, "samples.json"), JSON.stringify(samples, null, 2));
console.log(`\nSaved ${samples.length} samples to ${outDir}/samples.json`);

child.kill("SIGKILL");
process.exit(0);
