#!/usr/bin/env node
// Dump drive RAM ($0000-$07FF) from both headless + VICE at same logical
// point (drive PC enters motm range), diff byte-by-byte.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) out[key] = true;
      else { out[key] = v; i++; }
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const side = args.side ?? "diff";
const armPc = parseInt(String(args["arm-pc"] ?? "07A1"), 16);

if (side === "headless") {
  const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
  const { session } = startIntegratedSession({
    diskPath: join(repoRoot, "samples/motm.g64"),
    useCycleLockstep: true, useMicrocodedCpu: true,
  });
  const cpu = session.drive.cpu;
  let captured = false;
  let snap = null;
  const origExec = cpu.executeCycle.bind(cpu);
  let prevB = true;
  cpu.executeCycle = function () {
    origExec();
    const atB = cpu.isAtInstructionBoundary?.() ?? true;
    if (atB && !prevB && !captured && (cpu.pc & 0xffff) === armPc) {
      captured = true;
      snap = {
        pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, cycle: cpu.cycles,
        ram: Array.from(session.drive.bus.ram.slice(0, 0x800)),
      };
    }
    prevB = atB;
  };
  session.resetCold();
  if (session.scheduler) session.scheduler.runCycles(2_500_000);
  session.typeText('LOAD"*",8,1\n');
  if (session.scheduler) session.scheduler.runCycles(2_000_000);
  session.typeText("RUN\n");
  let stepped = 0;
  while (stepped < 50_000_000 && !captured) {
    if (session.scheduler) session.scheduler.runCycles(100_000);
    stepped += 100_000;
  }
  const out = args.out ?? "/tmp/drv_ram_h.json";
  writeFileSync(out, JSON.stringify(snap));
  console.error(`Headless captured at PC=$${snap?.pc.toString(16)}, cycle=${snap?.cycle} → ${out}`);
} else if (side === "vice") {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 500));
  } catch {}
  const VICE = "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
  const port = 6502;
  const child = spawn(VICE, [
    "-default", "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
    "-autostart", join(repoRoot, "samples/motm.g64"),
  ], { stdio: ["ignore", "ignore", "ignore"] });
  await new Promise(r => setTimeout(r, 2500));
  const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");
  const client = new ViceMonitorClient({ host: "127.0.0.1", port });
  for (let i = 0; i < 12; i++) { try { await client.connect(2000); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  const MEMSPACE_DRIVE = 1;
  const REG_PC = 3, REG_A = 0, REG_X = 1, REG_Y = 2, REG_SP = 4;
  await client.setCheckpoint({
    startAddress: armPc, endAddress: armPc,
    stopWhenHit: true, enabled: true, operation: 0x04, memspace: MEMSPACE_DRIVE,
  });
  let lastSeq = client.currentEventSequence;
  await client.resume();
  let armed = false;
  const dl = Date.now() + 90_000;
  while (!armed && Date.now() < dl) {
    let ev;
    try { ev = await client.waitForCheckpointOrStop(lastSeq, 30_000); } catch { break; }
    lastSeq = ev.sequence;
    if (ev.kind === "checkpoint") { armed = true; break; }
    if (ev.kind === "stopped") { try { await client.resume(); } catch {} continue; }
  }
  if (!armed) { console.error("never armed"); child.kill("SIGKILL"); process.exit(1); }
  const regs = await client.getRegisters(MEMSPACE_DRIVE);
  const get = id => regs.find(r => r.id === id)?.value ?? 0;
  // Get clock from cpu history
  const hist = await client.getCpuHistory(1, MEMSPACE_DRIVE);
  const cycle = hist.length > 0 ? Number(hist[0].clock) : 0;
  const mem = await client.readMemory(0x0000, 0x07ff, 0, MEMSPACE_DRIVE);
  const snap = {
    pc: get(REG_PC), a: get(REG_A), x: get(REG_X), y: get(REG_Y), sp: get(REG_SP),
    cycle,
    ram: Array.from(mem),
  };
  const out = args.out ?? "/tmp/drv_ram_v.json";
  writeFileSync(out, JSON.stringify(snap));
  console.error(`VICE captured at PC=$${snap.pc.toString(16)}, cycle=${snap.cycle} → ${out}`);
  await client.close();
  await new Promise(r => setTimeout(r, 300));
  child.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 300));
  child.kill("SIGKILL");
} else {
  // diff
  const h = JSON.parse(readFileSync(args.headless ?? "/tmp/drv_ram_h.json", "utf-8"));
  const v = JSON.parse(readFileSync(args.vice ?? "/tmp/drv_ram_v.json", "utf-8"));
  console.log(`Headless: pc=$${h.pc.toString(16)} a=$${h.a.toString(16).padStart(2,"0")} cycle=${h.cycle}`);
  console.log(`VICE:     pc=$${v.pc.toString(16)} a=$${v.a.toString(16).padStart(2,"0")} cycle=${v.cycle}`);
  console.log(`Register diff:`);
  for (const r of ["a","x","y","sp"]) {
    if (h[r] !== v[r]) console.log(`  ${r}: headless=$${h[r].toString(16)} vice=$${v[r].toString(16)}`);
  }
  let diffCount = 0;
  const diffs = [];
  for (let i = 0; i < 0x800; i++) {
    if (h.ram[i] !== v.ram[i]) {
      diffCount++;
      if (diffs.length < 50) diffs.push({ addr: i, h: h.ram[i], v: v.ram[i] });
    }
  }
  console.log(`\nRAM diff count: ${diffCount} bytes differ in $0000-$07FF`);
  console.log(`First 50 diffs:`);
  for (const d of diffs) {
    console.log(`  $${d.addr.toString(16).padStart(4,"0")}: headless=$${d.h.toString(16).padStart(2,"0")} vice=$${d.v.toString(16).padStart(2,"0")}`);
  }
}
