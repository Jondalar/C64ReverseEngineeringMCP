#!/usr/bin/env node
// Spec 611 phase 611.7f.6 — byte/bit-level LISTEN-burst diagnostic per
// Codex 06:47.
//
// Goal: answer 4 questions before any code patch:
//  1. Which bytes does C64 put on DATA/CLK during the LISTEN burst?
//  2. For each byte, does drive sample the same bits via VIA1 PB read?
//  3. Does drive assert + release ACK on DATA at the expected phase?
//  4. Does C64 observe drive ACK transitions, or are they missed because
//     catchUpTo/flush timing delivers them late/early?
//
// Approach: capture the LISTEN burst window only (t≈8.4M..8.5M), log
// EVERY event with cycle delta + drive PC + cpu_bus/cpu_port snapshot:
//   - C64 CIA2 PA write (= setC64Output, post-inversion)
//   - vice.iecLineDrive call with decoded ATN/CLK/DATA
//   - drive VIA1 PRB WRITE (driven bits + decoded state)
//   - drive VIA1 PB READ (returned byte + decoded DATA_IN/CLK_IN/ATN_IN)
//   - drive VIA1 CA1 latch
//   - drive 6502 NMI/IRQ entry transitions
//
// Decode C64-sent bytes from the C64-side bit stream using CBM IEC
// serial protocol bit timing: after each "drive ready" (drv DATA
// released), each bit = (drive DATA released → C64 sets DATA bit →
// C64 pulses CLK low → C64 releases CLK). Drive samples DATA on the
// CLK release rising edge.
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
const viceIec = driveCpu.iecBus;
const via1 = driveCpu.via1;
const iecBus = k.iecBus;
const core = iecBus.core;

// Event log. Use trigger-mode: enable capture only after first
// ATN-ASSERT, then run until first ATN-RELEASE + tail.
const events = [];
const MAX = 8000;
const state = { armed: false, captureEnabled: false, triggered: false, triggerT: 0, tailUntil: 0, captureT0: 0 };
function setCaptureT0(v) { state.captureT0 = v; }
function rec(ev) {
  if (!state.captureEnabled || events.length >= MAX) return;
  events.push({ ...ev, dt: ev.t - (events.length ? events[events.length - 1].t : state.captureT0) });
}

// --- Spy: setC64IecLines (= bridge entry) ---
const origSetLines = driveCpu.setC64IecLines.bind(driveCpu);
let prevAtn = viceIec.c64AtnReleased, prevClk = viceIec.c64ClkReleased, prevData = viceIec.c64DataReleased;
driveCpu.setC64IecLines = (a, c, d) => {
  // Trigger capture on first ATN-ASSERT after the trigger arm.
  if (!state.triggered && a === false && prevAtn === true && state.armed) {
    state.triggered = true;
    state.captureEnabled = true;
    state.captureT0 = session.c64Cpu.cycles;
    state.triggerT = session.c64Cpu.cycles;
    state.tailUntil = session.c64Cpu.cycles + 30000;
  }
  if (state.captureEnabled) {
    rec({
      kind: "c64IecLine",
      t: session.c64Cpu.cycles,
      c64Pc: session.c64Cpu.pc & 0xffff,
      cia2Pa: (session.cia2?.pra ?? 0) & 0xff,
      atn: a ? 1 : 0, clk: c ? 1 : 0, data: d ? 1 : 0,
      atnE: a !== prevAtn ? (a ? "↑" : "↓") : "·",
      clkE: c !== prevClk ? (c ? "↑" : "↓") : "·",
      dataE: d !== prevData ? (d ? "↑" : "↓") : "·",
      cpuBus: core.cpu_bus & 0xff,
      cpuPort: core.cpu_port & 0xff,
      drvPc: driveCpu.pc & 0xffff,
    });
  }
  prevAtn = a; prevClk = c; prevData = d;
  return origSetLines(a, c, d);
};

// --- Spy: VIA1 write (PRB only) ---
const origWrite = via1.write.bind(via1);
via1.write = (reg, value) => {
  const r = reg & 0x0f;
  const v = value & 0xff;
  if (state.captureEnabled && r === 0x00) {
    const driven = v & (via1.ddrb ?? 0x1a);
    rec({
      kind: "drvPbWrite",
      t: session.c64Cpu.cycles,
      drvClk: driveCpu.cpu.clk,
      drvPc: driveCpu.pc & 0xffff,
      prb: v,
      driven,
      dataOut: (driven & 0x02) === 0 ? "rel" : "PULL",
      clkOut: (driven & 0x08) === 0 ? "rel" : "PULL",
      atna: (driven & 0x10) === 0 ? "rel" : "ACK",
    });
  }
  return origWrite(reg, value);
};

// --- Spy: VIA1 read (PRB to track drive's input sampling) ---
const origRead = via1.read.bind(via1);
via1.read = (reg) => {
  const result = origRead(reg);
  const r = reg & 0x0f;
  if (state.captureEnabled && r === 0x00) {
    // Decode what drive sees per via1d1541.c read_prb formula bits.
    // After XOR-0x85: bit 0 set = DATA pulled, bit 2 set = CLK pulled,
    // bit 7 set = ATN asserted. Returned byte already has XOR baked in
    // by read_prb formula.
    rec({
      kind: "drvPbRead",
      t: session.c64Cpu.cycles,
      drvClk: driveCpu.cpu.clk,
      drvPc: driveCpu.pc & 0xffff,
      pb: result & 0xff,
      dataIn: (result & 0x01) ? "PULL" : "rel",
      clkIn: (result & 0x04) ? "PULL" : "rel",
      atnIn: (result & 0x80) ? "ASSERT" : "rel",
    });
  }
  return result;
};

// --- Spy: CA1 latches ---
const origSignalCa1 = via1.signalCa1.bind(via1);
via1.signalCa1 = (edge) => {
  const ifrBefore = via1.ifr;
  origSignalCa1(edge);
  if (state.captureEnabled && (via1.ifr & 0x02) && !(ifrBefore & 0x02)) {
    rec({
      kind: "ca1Latch",
      t: session.c64Cpu.cycles,
      drvPc: driveCpu.pc & 0xffff,
      edge: edge === 0 ? "FALL/release" : "RISE/assert",
    });
  }
};

// === Run ===
const ramMount = await mountMedia(session, 8, diskPath);
if (ramMount.errors?.length) { console.error(ramMount.errors); process.exit(1); }

session.resetCold("pal-default");

// Boot.
session.runFor(2_000_000);

// Type LOAD"$",8
session.typeText('LOAD"$",8\r', 80_000, 80_000);

// Arm trigger now. Capture starts on first ATN-ASSERT after typing.
state.armed = true;
const PAL_HZ = 985_248;
console.log(`Trigger armed at t=${session.c64Cpu.cycles}`);

// Run until trigger fires + tail elapses (or 14s timeout).
const hardTimeout = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < hardTimeout) {
  session.runFor(20_000);
  if (state.triggered && session.c64Cpu.cycles >= state.tailUntil) break;
  if (events.length >= MAX) break;
}
state.captureEnabled = false;
if (!state.triggered) console.log("NO trigger fired in 14s!");
console.log(`Capture END at t=${session.c64Cpu.cycles}, ${events.length} events; trigger at t=${state.triggerT}`);

// === Output ===
console.log("");
console.log("=== Compact LISTEN burst event stream ===");
console.log("(dt = cycles since previous event; '↓'=line went LOW/assert, '↑'=HIGH/release, '·'=unchanged)");
console.log("");

let inBurst = false;
for (const e of events) {
  if (e.kind === "c64IecLine") {
    const burstMark = e.atnE === "↓" ? " [BURST START]" : (e.atnE === "↑" ? " [BURST END]" : "");
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `c64=$${e.c64Pc.toString(16).padStart(4,"0")} ` +
      `PA=$${e.cia2Pa.toString(16).padStart(2,"0")}  ` +
      `ATN=${e.atn}${e.atnE} CLK=${e.clk}${e.clkE} DATA=${e.data}${e.dataE}  ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}${burstMark}`,
    );
  } else if (e.kind === "drvPbWrite") {
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `                          ` +
      `[DRV W $1800 = $${e.prb.toString(16).padStart(2,"0")}] ` +
      `DATA=${e.dataOut} CLK=${e.clkOut} ATNA=${e.atna}  ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}`,
    );
  } else if (e.kind === "drvPbRead") {
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `                          ` +
      `[DRV R $1800 → $${e.pb.toString(16).padStart(2,"0")}] ` +
      `DATA=${e.dataIn} CLK=${e.clkIn} ATN=${e.atnIn}  ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}`,
    );
  } else if (e.kind === "ca1Latch") {
    console.log(
      `+${e.dt.toString().padStart(5)} ` +
      `                          ` +
      `[CA1 LATCHED edge=${e.edge}]  ` +
      `drv=$${e.drvPc.toString(16).padStart(4,"0")}`,
    );
  }
}

// === Analysis: try to decode C64-sent byte from c64IecLine events ===
//
// CBM serial byte (under ATN): C64 pulls CLK between bits, sets DATA,
// releases CLK to clock the bit. Drive samples DATA on CLK rising edge.
// Bit order: LSB first.
//
// Simple heuristic: between ATN-assert and ATN-release, capture every
// CLK rising edge (clkE="↑") and read the DATA value at that point;
// shift into byte LSB-first. Output the bytes.
console.log("");
console.log("=== Decoded C64-sent bytes from CLK rising edges (LSB first) ===");

let bits = [];
let bytes = [];
let inAtn = false;
for (const e of events) {
  if (e.kind !== "c64IecLine") continue;
  if (e.atnE === "↓") { inAtn = true; bits = []; }
  if (e.atnE === "↑") { inAtn = false; bytes = []; continue; }
  if (!inAtn) continue;
  // Bit clocked when CLK rises (release).
  if (e.clkE === "↑") {
    bits.push(e.data); // 1 = released = data bit 1; 0 = pulled = data bit 0
    if (bits.length === 8) {
      let v = 0;
      for (let i = 0; i < 8; i++) v |= (bits[i] << i);
      bytes.push(v);
      bits = [];
    }
  }
}
console.log("bytes:", bytes.map((b) => "$" + b.toString(16).padStart(2, "0")).join(" "));
console.log("(expected: $28 LISTEN, $F0 SECOND, $3F UNLISTEN)");
