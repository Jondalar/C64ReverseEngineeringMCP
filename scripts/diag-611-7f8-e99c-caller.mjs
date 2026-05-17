#!/usr/bin/env node
// Spec 611 phase 611.7f.8 — drive-side $E99C caller trace per Codex 07:09.
//
// Identify which 1541 ROM path called $E99C (= STA $1800 at $E9A4 →
// PRB=$00 = release DATA) right after the post-LISTEN ATN-release.
//
// Capture window: 200 instructions before + 80 after the target PRB
// write. For each row: driveClk, PC, A/X/Y/P/SP, top 4 stack bytes,
// and flag whether instruction accessed $1800, $180D, $1804-7, $180B,
// $180E (= VIA1 PB / IFR / T1CL/CH/LL/LH / ACR / IER).
//
// Decision rule (Codex 07:09):
// - If caller is $E9F2 branch reached via "$180D AND #$40 != 0":
//   T1/IFR is the next VICE-shaped patch.
// - Else decode actual caller and identify VIA1/CA1/PRB cause.
//
// Read-only. No source mutation.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
const vice = k.drive1541;
const driveCpu = vice.driveCpu;
const cpu = driveCpu.cpu;
const via1 = driveCpu.via1;
const mem = driveCpu.mem;

// === Instruction ring buffer ===
const RING_SIZE = 800;
const ring = [];
function ringPush(entry) {
  if (ring.length < RING_SIZE) ring.push(entry);
  else { ring.shift(); ring.push(entry); }
}

let armed = false;
let targetHits = 0;
let captureMode = "pre"; // "pre" = collect ring; "post" = collect N after
let postCount = 0;
const POST_TARGET = 80;
const postRows = [];

const origExecuteCycle = cpu.executeCycle.bind(cpu);
cpu.executeCycle = function () {
  const pcBefore = this.reg_pc & 0xffff;
  const a = this.reg_a, x = this.reg_x, y = this.reg_y, p = this.reg_p, sp = this.reg_sp;
  const clk = cpu.clk;
  let row = null;
  if (armed) {
    // peek a few stack bytes (top of stack)
    const s = sp & 0xff;
    const stack0 = mem.read(0x100 + ((s + 1) & 0xff)) & 0xff;
    const stack1 = mem.read(0x100 + ((s + 2) & 0xff)) & 0xff;
    const stack2 = mem.read(0x100 + ((s + 3) & 0xff)) & 0xff;
    const stack3 = mem.read(0x100 + ((s + 4) & 0xff)) & 0xff;
    row = { clk, pc: pcBefore, a, x, y, p, sp, stack0, stack1, stack2, stack3 };
  }
  const result = origExecuteCycle();
  if (armed && row) {
    if (captureMode === "pre") {
      ringPush(row);
      // Trigger detection: $E9A4 corresponds to PC AFTER STA at $E9A1.
      // Better: trigger on the STA itself executing. STA $1800 opcode = $8D.
      // After STA $1800 at $E9A1, PC will be $E9A4. We check pcBefore = $E9A4
      // = next instruction RTS just finished setup. Use VIA1 write spy below
      // instead for cleaner trigger.
    } else if (captureMode === "post") {
      postRows.push(row);
      postCount++;
      if (postCount >= POST_TARGET) {
        captureMode = "done";
      }
    }
  }
  return result;
};

// === VIA1 access log + trigger ===
const viaAccesses = []; // { t, clk, pc, op, reg, value }
const origRead = via1.read.bind(via1);
via1.read = (reg) => {
  const result = origRead(reg);
  if (armed) {
    const r = reg & 0x0f;
    viaAccesses.push({ clk: cpu.clk, pc: cpu.reg_pc & 0xffff, op: "R", reg: r, val: result & 0xff });
  }
  return result;
};
const origWrite = via1.write.bind(via1);
via1.write = (reg, value) => {
  const r = reg & 0x0f;
  const v = value & 0xff;
  if (armed) {
    viaAccesses.push({ clk: cpu.clk, pc: cpu.reg_pc & 0xffff, op: "W", reg: r, val: v });
  }
  // Trigger on PRB write at the $E9A4 release-DATA event.
  // We want the SECOND PRB=$00 write at $E9A4 (post-burst). First $00 is during burst.
  const pcAtWrite = cpu.reg_pc & 0xffff;
  if (armed && r === 0x00 && v === 0x00 && pcAtWrite === 0xe9a4 && captureMode === "pre") {
    targetHits++;
    // Need to skip the burst-end PRB=$00; trigger on the post-burst one.
    // From 7f7 trace, post-burst $00 happens at t≈8447358 (after 7f6 trace
    // showed it at t=+23 within trigger window). We trigger ON THE FIRST
    // $E9A4 PRB=$00 because that IS the post-burst one (burst's last
    // write was $96, then $07, then $00 = the one we want).
    captureMode = "post";
    console.log(`Trigger fired at clk=${cpu.clk} pc=$${pcAtWrite.toString(16)} (target hit #${targetHits})`);
  }
  return origWrite(reg, value);
};

// === Run ===
const ramMount = await mountMedia(session, 8, diskPath);
if (ramMount.errors?.length) { console.error(ramMount.errors); process.exit(1); }
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
armed = true;
console.log(`Armed at t=${session.c64Cpu.cycles}`);

const PAL_HZ = 985_248;
const hardTimeout = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < hardTimeout) {
  session.runFor(20_000);
  if (captureMode === "done") break;
}
armed = false;

if (captureMode === "pre") {
  console.log("WARNING: trigger never fired");
}

// === Output ===
function fmt(v, w=2) { return "$" + (v & ((1 << (w*4)) - 1)).toString(16).padStart(w, "0"); }
function decodeReg(r) {
  return ["PRB","PRA","DDRB","DDRA","T1CL","T1CH","T1LL","T1LH","T2CL","T2CH","SR","ACR","PCR","IFR","IER","PRA_NHS"][r] ?? `r${r}`;
}

console.log("\n=== Drive instruction trace AROUND $E9A4 release-DATA event ===");
console.log("(PRE = 200 instructions before; POST = 80 instructions after the STA $1800 = $00 write at $E9A4)");
console.log("clk         PC    A  X  Y  P  SP  stack[sp+1..+4]");
// Last 200 of ring (or fewer)
const preRows = ring.slice(-200);
for (const r of preRows) {
  console.log(
    `${r.clk.toString().padStart(10)}  ${fmt(r.pc,4)}  ${fmt(r.a)} ${fmt(r.x)} ${fmt(r.y)} ${fmt(r.p)} ${fmt(r.sp)}  ` +
    `${fmt(r.stack0)} ${fmt(r.stack1)} ${fmt(r.stack2)} ${fmt(r.stack3)}`,
  );
}
console.log("--- TRIGGER ($E9A4 PRB=$00 write happened on previous cycle) ---");
for (const r of postRows) {
  console.log(
    `${r.clk.toString().padStart(10)}  ${fmt(r.pc,4)}  ${fmt(r.a)} ${fmt(r.x)} ${fmt(r.y)} ${fmt(r.p)} ${fmt(r.sp)}  ` +
    `${fmt(r.stack0)} ${fmt(r.stack1)} ${fmt(r.stack2)} ${fmt(r.stack3)}`,
  );
}

console.log("\n=== VIA1 accesses captured (whole armed window) — last 60 entries ===");
const accLast = viaAccesses.slice(-60);
for (const a of accLast) {
  console.log(`clk=${a.clk.toString().padStart(10)} pc=${fmt(a.pc,4)} ${a.op} ${decodeReg(a.reg).padEnd(7)} = ${fmt(a.val)}`);
}

console.log(`\n=== Summary ===`);
console.log(`Trigger hits on $E9A4 PRB=$00: ${targetHits}`);
console.log(`Pre rows: ${preRows.length}; Post rows: ${postRows.length}`);
console.log(`VIA accesses: ${viaAccesses.length} (last 60 shown above)`);
