// Sprint 66 iterative debug harness.
//
// Pick a sample G64, cold-boot the IntegratedSession, run in chunks,
// log telemetry. Use to discover what breaks first as KERNAL tries
// to talk to the drive.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
const candidates = [
  "maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
  "impossible_mission_ii[epyx_1987](!).g64",
  "last_ninja_remix_s1[system3_1991].g64",
];
let pick = null;
for (const c of candidates) {
  const p = join(samples, c);
  if (existsSync(p)) { pick = p; break; }
}
if (!pick) { console.log("No sample available."); process.exit(0); }

console.log(`Iterating on: ${pick}\n`);

const { sessionId, session } = startIntegratedSession({ diskPath: pick });
session.resetCold();

function snap(label) {
  const s = session.status();
  const fmt = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
  const cpuPort = session.c64Bus.getCpuPortValue();
  const dd00 = session.c64Bus.io[0xdd00 - 0xd000] ?? 0;
  console.log(
    `[${label}] C64 PC=$${fmt(s.c64.pc, 4)} A=${fmt(s.c64.a)} SP=${fmt(s.c64.sp)} cyc=${s.c64.cycles} $01=${fmt(cpuPort)} $DD00=${fmt(dd00)} | ` +
    `drive PC=$${fmt(s.drive.pc, 4)} A=${fmt(s.drive.a)} SP=${fmt(s.drive.sp)} cyc=${s.drive.cycles} trk=${s.drive.track} | ` +
    `IEC ATN=${s.iecBus.line.atn ? 1 : 0} CLK=${s.iecBus.line.clk ? 1 : 0} DATA=${s.iecBus.line.data ? 1 : 0}`
  );
}

snap("reset");

// Run KERNAL cold-start to READY prompt. Standard KERNAL takes ~3
// frames to complete init = ~150k cycles. Run 200k instructions to
// be safe.
let lastError = null;
function tryRun(n, label) {
  try {
    const r = session.runFor(n);
    snap(`${label} (${r.instructionsExecuted} insns)`);
    return r;
  } catch (e) {
    snap(`${label} FAULTED`);
    console.log(`    error: ${e.message}`);
    lastError = e;
    return null;
  }
}

// Phase 1: cold-start to KERNAL keyboard-wait ($E5C0-$E5E0).
const PHASE1_BUDGET = 2_000_000;
const CHUNK = 250_000;
let total = 0;
while (total < PHASE1_BUDGET && !lastError) {
  const r = tryRun(CHUNK, `${(total + CHUNK) / 1000}k`);
  if (!r) break;
  total += CHUNK;
  const pc = session.status().c64.pc;
  if (pc >= 0xe5c0 && pc <= 0xe5e0) {
    console.log(`  >>> Reached KERNAL keyboard-wait at PC=$${pc.toString(16)} after ${total} insns`);
    break;
  }
}

// Phase 2: inject "LO\"*\",8,1\rRUN\r".
// Bypass BASIC entirely: setup KERNAL LOAD parameters in zero page,
// inject filename, set PC to $FFD5 (KERNAL LOAD JMP table entry),
// fake-push a return address (so RTS goes back to READY area).
function callKernalLoad(filename = "*", device = 8, sa = 1) {
  // Filename at $0334+ (cassette buffer area, safe scratch).
  const fnAddr = 0x0334;
  for (let i = 0; i < filename.length; i++) {
    session.c64Bus.ram[fnAddr + i] = filename.charCodeAt(i);
  }
  // Zero page LOAD parameters.
  session.c64Bus.ram[0xb7] = filename.length;             // FNLEN
  session.c64Bus.ram[0xbb] = fnAddr & 0xff;               // FNADR low
  session.c64Bus.ram[0xbc] = (fnAddr >> 8) & 0xff;        // FNADR high
  session.c64Bus.ram[0xb8] = 1;                           // LFN
  session.c64Bus.ram[0xb9] = sa;                          // secondary address
  session.c64Bus.ram[0xba] = device;                      // device 8
  // Fake the call: push return address $A483 (BASIC main wait area)
  // onto the stack so KERNAL LOAD's RTS returns there.
  const ret = 0xa482;
  session.c64Cpu.sp = (session.c64Cpu.sp - 2) & 0xff;
  // Stack grows downward; push hi then lo.
  session.c64Bus.ram[0x0100 | ((session.c64Cpu.sp + 2) & 0xff)] = (ret >> 8) & 0xff;
  session.c64Bus.ram[0x0100 | ((session.c64Cpu.sp + 1) & 0xff)] = ret & 0xff;
  // Set A=0 (= LOAD, not VERIFY) and jump to $FFD5 (KERNAL LOAD vector).
  session.c64Cpu.a = 0;
  session.c64Cpu.pc = 0xffd5;
  console.log(`  [direct LOAD call] filename="${filename}" device=${device} sa=${sa} -> JMP $FFD5`);
}

if (!lastError) {
  console.log("\n--- Calling KERNAL LOAD directly (bypass BASIC) ---");
  callKernalLoad("*", 8, 1);
  for (let i = 0; i < 12 && !lastError; i++) tryRun(250_000, `post-LOAD ${(i+1)*250}k`);
}

if (lastError) console.log(`\nFinal fault: ${lastError.message}`);
console.log(`\nSession ${sessionId} kept alive for further inspection.`);
