#!/usr/bin/env node
// Spec 143 — VICE binmon → BusAccessEvent JSONL capture.
//
// Drives x64sc with -binarymonitor (NO -warp per Q10), sets four
// checkpoints (read+write × c64 $DD00 + drive $1800), captures hits
// into the same Spec 142 schema.
//
// Usage:
//   npm run trace:motm-vice -- [--id motm] [--port 6502] [--budget-ms 300000]
//                              [--max-events 2000]
//                              [--vice /Applications/vice-arm64-gtk3-3.10/bin/x64sc]
//
// Output: traces/<id>_vice_<ts>.jsonl
//
// Limitations (Q11 doc):
//   - at_boundary approximated (instruction_pc == checkpoint_pc heuristic).
//   - phase = undefined (VICE binmon doesn't expose microcode step).
//   - cycle_c64/cycle_drive from CLK register (R7) per memspace.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
const id = args.id ?? "motm";
const port = Number(args.port ?? 6502);
const budgetMs = Number(args["budget-ms"] ?? 300_000);
const maxEvents = Number(args["max-events"] ?? 2000);
const vicePath = args.vice ?? "/Applications/vice-arm64-gtk3-3.10/bin/x64sc";
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;

// Manifest lookup
const manifest = JSON.parse(readFileSync(join(repoRoot, "samples/test-manifest.json"), "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) {
  console.error(`Manifest entry not found: id=${id}`);
  process.exit(2);
}
const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) {
  console.error(`Disk image not found: ${diskPath}`);
  process.exit(2);
}

const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = args.out
  ? resolve(projectDir, args.out)
  : join(projectDir, "traces", `${id}_vice_${tsTag}.jsonl`);
mkdirSync(dirname(outPath), { recursive: true });

console.error(`Spec 143 VICE capture`);
console.error(`Manifest: ${entry.id} (${entry.family})`);
console.error(`Disk: ${diskPath}`);
console.error(`VICE: ${vicePath}`);
console.error(`Output: ${outPath}`);
console.error(`Budget: ${budgetMs} ms  Max events: ${maxEvents}`);

// Clean any prior x64sc on this port
try {
  const { execSync } = await import("node:child_process");
  execSync(`pkill -9 -f x64sc || true`, { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
} catch {}

// Spawn VICE
const viceArgs = [
  "-default",
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  "-autostart", diskPath,
];
console.error(`Spawning: ${vicePath} ${viceArgs.join(" ")}`);
const child = spawn(vicePath, viceArgs, { stdio: ["ignore", "ignore", "ignore"] });
await new Promise((r) => setTimeout(r, 2500));

const { ViceMonitorClient } = await import("../dist/runtime/vice/monitor-client.js");

const client = new ViceMonitorClient({ host: "127.0.0.1", port });
let connected = false;
for (let i = 0; i < 12; i++) {
  try { await client.connect(2000); connected = true; break; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!connected) {
  console.error("Could not connect to VICE binmon");
  child.kill("SIGKILL");
  process.exit(1);
}

const MEMSPACE_C64 = 0x00;
const MEMSPACE_DRIVE = 0x01;
const REG_PC = 3;
// VICE doesn't expose a single global CLK register. Use getCpuHistory(1)
// per side which returns `clock: string` per item.
async function getClock(memspace) {
  try {
    const hist = await client.getCpuHistory(1, memspace);
    if (hist.length > 0) return Number(hist[0].clock);
  } catch {}
  return 0;
}

// Optional arming: wait for drive PC to enter window before enabling
// R/W checkpoints. Symmetric with headless PC-window filter so both
// sides capture the same logical phase.
const armPcStart = args["arm-pc-start"] !== undefined ? Number(args["arm-pc-start"]) : (id === "motm" ? 0x042F : 0);
const armPcEnd = args["arm-pc-end"] !== undefined ? Number(args["arm-pc-end"]) : (id === "motm" ? 0x044C : 0);

if (armPcStart > 0) {
  console.error(`Arming on drive PC range $${armPcStart.toString(16)}-$${armPcEnd.toString(16)} (memspace=1)`);
  // Set exec checkpoint that pauses VICE when drive PC enters window.
  await client.setCheckpoint({
    startAddress: armPcStart, endAddress: armPcEnd,
    stopWhenHit: true, enabled: true, operation: 0x04, memspace: MEMSPACE_DRIVE,
  });
  // Resume VICE, wait for the arm hit.
  let armSeq = client.currentEventSequence;
  await client.resume();
  let armed = false;
  const armDeadline = Date.now() + 180_000;
  while (!armed && Date.now() < armDeadline) {
    let ev;
    try {
      ev = await client.waitForCheckpointOrStop(armSeq, 30_000);
    } catch {
      console.error(`Arm timeout — exiting`);
      child.kill("SIGKILL");
      process.exit(1);
    }
    armSeq = ev.sequence;
    if (ev.kind === "checkpoint") {
      const dRegs = await client.getRegisters(MEMSPACE_DRIVE);
      const dpc = (dRegs.find((r) => r.id === REG_PC)?.value ?? 0) & 0xffff;
      if (dpc >= armPcStart && dpc <= armPcEnd) {
        console.error(`Armed at drive PC=$${dpc.toString(16)}`);
        armed = true;
        break;
      }
      await client.resume();
    } else if (ev.kind === "stopped") {
      try { await client.resume(); } catch {}
    }
  }
  if (!armed) {
    console.error(`Arm window never hit — exiting`);
    child.kill("SIGKILL");
    process.exit(1);
  }
}

// Set 4 checkpoints. operation: 0x01=load(read), 0x02=store(write), 0x04=exec
// Per VICE binmon protocol — read+write = 0x03.
const cp_c64 = await client.setCheckpoint({
  startAddress: 0xdd00, endAddress: 0xdd00,
  stopWhenHit: true, enabled: true, operation: 0x03, memspace: MEMSPACE_C64,
});
const cp_drive = await client.setCheckpoint({
  startAddress: 0x1800, endAddress: 0x1800,
  stopWhenHit: true, enabled: true, operation: 0x03, memspace: MEMSPACE_DRIVE,
});
console.error(`Checkpoints: c64=${cp_c64.checkpointNumber} drive=${cp_drive.checkpointNumber}`);

const events = [];
const t0 = Date.now();
let seq = 0;
let exitReason = "max-events";

let lastSeq = client.currentEventSequence;
await client.resume();

while (events.length < maxEvents && (Date.now() - t0) < budgetMs) {
  const remaining = budgetMs - (Date.now() - t0);
  let ev;
  try {
    ev = await client.waitForCheckpointOrStop(lastSeq, Math.min(remaining, 10_000));
  } catch (e) {
    console.error(`Wait timeout / error: ${e?.message ?? e}`);
    exitReason = "wait-timeout";
    break;
  }
  lastSeq = ev.sequence;
  if (ev.kind === "stopped") {
    // VICE-side pause (autostart finished, user closed window, etc.).
    // Resume and continue.
    try { await client.resume(); } catch {}
    continue;
  }
  if (ev.kind === "jam") {
    console.error(`CPU JAM at pc=$${(ev.pc ?? 0).toString(16)} — stopping`);
    exitReason = "jam";
    break;
  }
  if (ev.kind !== "checkpoint") {
    console.error(`Unexpected event: ${ev.kind} — stopping`);
    break;
  }
  const cp = ev.checkpoint;
  const isC64 = cp.checkpointNumber === cp_c64.checkpointNumber;
  const memspace = isC64 ? MEMSPACE_C64 : MEMSPACE_DRIVE;
  const addr = isC64 ? 0xdd00 : 0x1800;
  // VICE checkpoint operation field tells us R or W. 1=load(read), 2=store(write).
  const op = (cp.operation === 2) ? "write" : "read";

  // Get registers + memory
  const regs = await client.getRegisters(memspace);
  const pc = (regs.find((r) => r.id === REG_PC)?.value ?? 0) & 0xffff;
  const cycle_c64 = await getClock(MEMSPACE_C64);
  const cycle_drive = await getClock(MEMSPACE_DRIVE);

  // Get memory byte at addr (post-event state — for write: what was written;
  // for read: current value, which equals what was read assuming no
  // mutation between).
  const mem = await client.readMemory(addr, addr, 0, memspace);
  const value = mem[0] ?? 0;

  // For drive events: dump VIA1 IFR/IER/PCR
  let via1;
  if (!isC64) {
    const viaMem = await client.readMemory(0x180d, 0x180e, 0, MEMSPACE_DRIVE);
    const pcrMem = await client.readMemory(0x180c, 0x180c, 0, MEMSPACE_DRIVE);
    via1 = { ifr: viaMem[0] ?? 0, ier: viaMem[1] ?? 0, pcr: pcrMem[0] ?? 0 };
  }

  // For IEC line state: read drive_port via VICE iecbus_drive_port hack
  // not exposed; approximate from c64 $DD00 readback.
  const dd00Mem = isC64 ? mem : await client.readMemory(0xdd00, 0xdd00, 0, MEMSPACE_C64);
  const dd00 = dd00Mem[0] ?? 0;
  // CIA2 PA bits: bit3=ATN_OUT (=ATN driven low), bit4=CLK_OUT, bit5=DATA_OUT,
  // bit6=CLK_IN, bit7=DATA_IN. For raw line state we use the IN bits:
  const atn = (dd00 & 0x08) ? 0 : 1;  // approximate (no direct ATN_IN bit, infer from c64 output)
  const clkLine = (dd00 & 0x40) ? 1 : 0;
  const dataLine = (dd00 & 0x80) ? 1 : 0;

  const event = {
    cycle_c64,
    cycle_drive,
    side: isC64 ? "c64" : "drive",
    op,
    addr,
    value,
    pc,
    at_boundary: true, // VICE checkpoint hits at access cycle = approximately boundary
    iec: {
      atn,
      clk: clkLine,
      data: dataLine,
      c64_atn: (dd00 & 0x08) ? 0 : 1,
      c64_clk: (dd00 & 0x10) ? 0 : 1,
      c64_data: (dd00 & 0x20) ? 0 : 1,
      drv_clk: 1,  // placeholder — VICE doesn't easily expose drv_data
      drv_data: 1, // (would need iecbus_t struct dump via direct addr)
      drv_atn_ack: 1,
    },
    via1,
    seq: seq++,
    vice_approx: { iec_drv_state: true, at_boundary: true },
  };
  appendFileSync(outPath, JSON.stringify(event) + "\n");
  events.push(event);

  await client.resume();
}

console.error(``);
console.error(`Captured ${events.length} events in ${Date.now() - t0} ms`);
console.error(`Exit: ${exitReason}`);
console.error(`Output: ${outPath}`);

await client.close();
await new Promise((r) => setTimeout(r, 300));
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
child.kill("SIGKILL");
