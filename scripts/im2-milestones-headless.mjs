// Spec 427 — track IM2 PC milestones in our headless emulator.
// Mirrors scripts/vice-im2-pc-stream.mjs schema. Reports:
//  - PC histogram at fixed clk landmarks (37M, 61M, 85M, 120M, 170M, 653M)
//  - first-entry cycles for $3310 (loader stub) and $48D3-$48EE (idle)
//  - PC region bucketing per second
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
});

session.resetCold("pal-default");
session.runFor(5_000_000);
await mountMedia(session, 8, resolve("samples/impossible_mission_ii[epyx_1987](!).g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
session.typeText("RUN\r");

// VICE landmarks
const LANDMARKS = [37_000_000, 61_000_000, 85_000_000, 120_000_000, 170_000_000, 246_000_000, 335_000_000, 462_000_000, 653_000_000];
const STAGES = {
  "$3310 IM2 loader stub": (pc) => pc === 0x3310,
  "$48D3-$48EE title idle": (pc) => pc >= 0x48d3 && pc <= 0x48ee,
  "$A580-$AD80 BASIC": (pc) => pc >= 0xa580 && pc < 0xae00,
};
const firstEntry = {};
for (const k of Object.keys(STAGES)) firstEntry[k] = null;

const histograms = {};  // landmark → { region: count }
function bucket(pc) {
  if (pc >= 0xE000) return "$Exxx-Fxxx (KERNAL ROM)";
  if (pc >= 0xA000 && pc < 0xC000) return "$A000-$BFFF (BASIC ROM)";
  if (pc >= 0xc000 && pc < 0xe000) return "$Cxxx-Dxxx (game/IO)";
  if (pc >= 0x4800 && pc < 0x4900) return "$48xx (TITLE IDLE TARGET)";
  if (pc >= 0x3000 && pc < 0x3400) return "$3xxx (LOADER STUB TARGET)";
  if (pc >= 0x1000 && pc < 0x1800) return "$1xxx (stuck range)";
  if (pc >= 0x0400 && pc < 0x0900) return "$04-08xx";
  return `$${(pc & 0xf000).toString(16)}000 area`;
}

// Step in 10k-cycle chunks, sample PC each chunk
let nextLandmarkIdx = 0;
const totalBudget = 700_000_000;  // beyond longest VICE landmark
const stepSize = 50_000;
let lastBaselineClk = session.c64Cpu.cycles;
let curBucket = {};

while (session.c64Cpu.cycles < lastBaselineClk + totalBudget) {
  session.runFor(stepSize);
  const pc = session.c64Cpu.pc;
  const clk = session.c64Cpu.cycles - lastBaselineClk;
  // Record first-entry
  for (const [stage, pred] of Object.entries(STAGES)) {
    if (firstEntry[stage] === null && pred(pc)) {
      firstEntry[stage] = { clk, c64pc: pc };
      console.log(`FIRST ENTRY ${stage}: clk=${clk} pc=$${pc.toString(16)}`);
    }
  }
  // Bucket
  const b = bucket(pc);
  curBucket[b] = (curBucket[b] ?? 0) + 1;
  // Landmark snapshot
  if (nextLandmarkIdx < LANDMARKS.length && clk >= LANDMARKS[nextLandmarkIdx]) {
    histograms[LANDMARKS[nextLandmarkIdx]] = { ...curBucket };
    console.log(`\n=== clk=${LANDMARKS[nextLandmarkIdx]} (VICE landmark) ===`);
    const sorted = Object.entries(curBucket).sort((a,b) => b[1] - a[1]);
    for (const [region, n] of sorted.slice(0, 5)) {
      console.log(`  ${region}: ${n} samples`);
    }
    console.log(`  current PC=$${pc.toString(16)} drive PC=$${session.drive.cpu.pc.toString(16)}`);
    curBucket = {};
    nextLandmarkIdx++;
  }
}

console.log("\n=== FIRST-ENTRY SUMMARY ===");
for (const [k, v] of Object.entries(firstEntry)) {
  console.log(`  ${k}: ${v ? "clk=" + v.clk + " pc=$" + v.c64pc.toString(16) : "NEVER REACHED"}`);
}
process.exit(0);
