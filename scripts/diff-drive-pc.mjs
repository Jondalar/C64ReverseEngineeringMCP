#!/usr/bin/env node
// Drive PC trajectory diff between headless and VICE.
// Patterned after working vice-iec-capture.mjs.
//
// Usage:
//   node diff-drive-pc.mjs --side headless --out h.jsonl
//   node diff-drive-pc.mjs --side vice --out v.jsonl
//   node diff-drive-pc.mjs --diff --headless h.jsonl --vice v.jsonl

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));

if (args.diff) {
  const headless = readFileSync(args.headless ?? "/tmp/drv_h.jsonl", "utf-8")
    .split("\n").filter(Boolean).map(JSON.parse);
  const vice = readFileSync(args.vice ?? "/tmp/drv_v.jsonl", "utf-8")
    .split("\n").filter(Boolean).map(JSON.parse);
  console.log(`headless: ${headless.length} drive instructions`);
  console.log(`vice:     ${vice.length} drive instructions`);
  const N = Math.min(headless.length, vice.length);
  for (let i = 0; i < N; i++) {
    if (headless[i].pc !== vice[i].pc) {
      console.log(`\nFIRST DIVERGENCE at index ${i}:`);
      console.log(`  headless: pc=$${headless[i].pc.toString(16).padStart(4, "0")} a=$${(headless[i].a ?? 0).toString(16).padStart(2, "0")}`);
      console.log(`  vice:     pc=$${vice[i].pc.toString(16).padStart(4, "0")} a=$${(vice[i].a ?? 0).toString(16).padStart(2, "0")}`);
      console.log(`\nLast 10 matching:`);
      for (let k = Math.max(0, i - 10); k < i; k++) {
        console.log(`  [${k}] pc=$${headless[k].pc.toString(16).padStart(4, "0")} a=$${(headless[k].a ?? 0).toString(16)}`);
      }
      console.log(`\nNext 10 headless after divergence:`);
      for (let k = i; k < Math.min(headless.length, i + 10); k++) {
        console.log(`  [${k}] pc=$${headless[k].pc.toString(16).padStart(4, "0")}`);
      }
      console.log(`\nNext 10 vice after divergence:`);
      for (let k = i; k < Math.min(vice.length, i + 10); k++) {
        console.log(`  [${k}] pc=$${vice[k].pc.toString(16).padStart(4, "0")}`);
      }
      process.exit(0);
    }
  }
  console.log(`\nNO DIVERGENCE in first ${N} matched instructions.`);
  process.exit(0);
}

const side = args.side ?? "headless";
const outPath = args.out ?? `/tmp/drv_${side}.jsonl`;
const histDepth = Number(args.depth ?? 4000);
const armPcStart = parseInt(String(args["arm-pc-start"] ?? "042F"), 16);
const armPcEnd = parseInt(String(args["arm-pc-end"] ?? "044C"), 16);

if (side === "headless") {
  const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
  const { session } = startIntegratedSession({
    diskPath: join(repoRoot, "samples/motm.g64"),
    useCycleLockstep: true, useMicrocodedCpu: true,
  });

  const records = [];
  let armed = false;
  const cpu = session.drive.cpu;
  const origExec = cpu.executeCycle.bind(cpu);
  let prevBoundary = true;
  cpu.executeCycle = function () {
    origExec();
    const atB = cpu.isAtInstructionBoundary?.() ?? true;
    if (atB && !prevBoundary) {
      const pc = cpu.pc & 0xffff;
      if (!armed && pc >= armPcStart && pc <= armPcEnd) armed = true;
      if (armed && records.length < histDepth) {
        records.push({ pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, cycle: cpu.cycles });
      }
    }
    prevBoundary = atB;
  };

  session.resetCold();
  if (session.scheduler) session.scheduler.runCycles(2_500_000);
  session.typeText('LOAD"*",8,1\n');
  if (session.scheduler) session.scheduler.runCycles(2_000_000);
  session.typeText("RUN\n");

  let stepped = 0;
  const chunk = 100_000;
  while (stepped < 50_000_000 && records.length < histDepth) {
    if (session.scheduler) session.scheduler.runCycles(chunk);
    stepped += chunk;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.error(`Captured ${records.length} drive instructions → ${outPath}`);
  console.error(`First: pc=$${records[0]?.pc.toString(16)} cycle=${records[0]?.cycle}`);
  console.error(`Last:  pc=$${records[records.length - 1]?.pc.toString(16)} cycle=${records[records.length - 1]?.cycle}`);
  process.exit(0);
}

if (side === "vice") {
  const VICE = args.vice_bin ?? "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
  const port = Number(args.port ?? 6502);
  const diskPath = join(repoRoot, "samples/motm.g64");
  try {
    const { execSync } = await import("node:child_process");
    execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  const child = spawn(VICE, [
    "-default", "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
    "-autostart", diskPath,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  await new Promise(r => setTimeout(r, 2500));

  const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");
  const client = new ViceMonitorClient({ host: "127.0.0.1", port });
  let connected = false;
  for (let i = 0; i < 12; i++) {
    try { await client.connect(2000); connected = true; break; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!connected) { child.kill("SIGKILL"); process.exit(1); }

  const MEMSPACE_DRIVE = 1;
  const REG_PC = 3, REG_A = 0, REG_X = 1, REG_Y = 2, REG_SP = 4;

  console.error(`Arming on drive PC range $${armPcStart.toString(16)}-$${armPcEnd.toString(16)} (memspace=1)`);
  await client.setCheckpoint({
    startAddress: armPcStart, endAddress: armPcEnd,
    stopWhenHit: true, enabled: true, operation: 0x04, memspace: MEMSPACE_DRIVE,
  });
  let lastSeq = client.currentEventSequence;
  await client.resume();
  let armed = false;
  const armDeadline = Date.now() + 180_000;
  while (!armed && Date.now() < armDeadline) {
    let ev;
    try { ev = await client.waitForCheckpointOrStop(lastSeq, 30_000); }
    catch (e) { console.error(`timeout: ${e?.message ?? e}`); break; }
    lastSeq = ev.sequence;
    if (ev.kind === "checkpoint") {
      const dRegs = await client.getRegisters(MEMSPACE_DRIVE);
      const dpc = (dRegs.find(r => r.id === REG_PC)?.value ?? 0) & 0xffff;
      if (dpc >= armPcStart && dpc <= armPcEnd) { console.error(`Armed at drive PC=$${dpc.toString(16)}`); armed = true; break; }
      await client.resume();
    } else if (ev.kind === "stopped") { try { await client.resume(); } catch {} }
  }
  if (!armed) { console.error("never armed"); child.kill("SIGKILL"); process.exit(1); }

  // After first arm hit, resume VICE for a window so drive runs further
  // in stage-2. Then re-pause to dump cpu history covering stage-2.
  console.error(`Armed. Running VICE forward for stage-2 capture...`);
  // Use advanceInstructions or just resume + sleep + checkpoint hit again.
  // Simplest: poll-pause-loop that lets drive run a chunk of cycles.
  await client.resume();
  await new Promise(r => setTimeout(r, 5_000));  // 5s wallclock = ~5M c64 cycles
  // Stop again by advancing a single instruction.
  try {
    await client.advanceInstructions(1, false);
  } catch (e) { console.error(`advance err: ${e?.message}`); }

  console.error(`Dumping drive cpu history depth=${histDepth}...`);
  const hist = await client.getCpuHistory(histDepth, MEMSPACE_DRIVE);
  const records = hist.map(item => {
    const get = id => item.registers.find(r => r.id === id)?.value ?? 0;
    return {
      pc: get(REG_PC),
      a: get(REG_A), x: get(REG_X), y: get(REG_Y), sp: get(REG_SP),
      cycle: Number(item.clock),
    };
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.error(`Captured ${records.length} VICE drive instructions → ${outPath}`);
  console.error(`First: pc=$${records[0]?.pc.toString(16)} cycle=${records[0]?.cycle}`);
  console.error(`Last:  pc=$${records[records.length - 1]?.pc.toString(16)} cycle=${records[records.length - 1]?.cycle}`);

  await client.close();
  await new Promise(r => setTimeout(r, 300));
  child.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 300));
  child.kill("SIGKILL");
}
