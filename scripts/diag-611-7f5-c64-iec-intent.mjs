#!/usr/bin/env node
// Spec 611 phase 611.7f.5 — C64-side IEC transition trace per Codex 06:32.
//
// Read-only diagnostic. Captures EVERY C64 IEC line transition during
// LOAD"$",8 to decide whether C64 actually issues ATN-TALK after the
// LISTEN+filename+UNLISTEN sequence. Each event row:
//
//   c64Clk, c64Pc, CIA2 PA/DDR, ATN/CLK/DATA (combined bus),
//   prev → new state, VICE1541 drive PC + PRB at catch-up boundary.
//
// Decodes ATN command bytes from C64 output:
//   LISTEN  $28 (= $20 | dev8)
//   SECOND  $F0 (= open channel 0)
//   UNLISTEN $3F
//   TALK    $48 (= $40 | dev8)
//   TKSA    $60
//   UNTALK  $5F
//
// If TALK never appears in the trace, the bug is in the filename /
// UNLISTEN ack window (= drive-side post-UNLISTEN byte-recv).
// If TALK appears but drive doesn't enter TALK handling, the bug is
// in VICE1541 VIA1 PB read / CA1 / bus aggregation around TALK.

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
if (!existsSync(diskPath)) {
  console.error("missing", diskPath); process.exit(1);
}

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const k = session.kernel;
const vice = k.drive1541;
const drive = vice.diskunit.drives[0];
const driveCpu = vice.driveCpu;
const viceIec = driveCpu.iecBus;
const via1 = driveCpu.via1;
const iecBus = k.iecBus;
const core = iecBus.core;

// Event log entries.
const events = [];
const MAX_EVENTS = 4000;
function push(e) {
  if (events.length < MAX_EVENTS) events.push(e);
}

// Track current ATN-command-byte assembly when ATN asserted.
// CBM serial under ATN: C64 sends bytes via CLK/DATA bit-bang.
// We capture each ATN-cycle's emitted byte sequence via VIA1 PRB writes
// on the drive side (drive shifts bits IN). For C64-side intent
// detection we read CIA2 PA on each setC64Output.
let atnByteStartCycle = null;

// === Spy 1: bridge's setC64Output / iecLineDrive ===
const origSetC64Lines = driveCpu.setC64IecLines.bind(driveCpu);
let prevC64Atn = viceIec.c64AtnReleased;
let prevC64Clk = viceIec.c64ClkReleased;
let prevC64Data = viceIec.c64DataReleased;
driveCpu.setC64IecLines = (a, c, d) => {
  if (a !== prevC64Atn || c !== prevC64Clk || d !== prevC64Data) {
    const tag = a !== prevC64Atn
      ? (a ? "ATN-RELEASE" : "ATN-ASSERT")
      : "bus-toggle";
    push({
      kind: "iecLineDrive",
      tag,
      t: session.c64Cpu.cycles,
      c64Pc: session.c64Cpu.pc & 0xffff,
      cia2Pa: (session.cia2?.pra ?? 0) & 0xff,
      cia2Ddr: (session.cia2?.ddra ?? 0) & 0xff,
      atn: a ? 1 : 0, clk: c ? 1 : 0, data: d ? 1 : 0,
      drvPc: driveCpu.pc & 0xffff,
      cpuBus: core.cpu_bus & 0xff,
      cpuPort: core.cpu_port & 0xff,
    });
    prevC64Atn = a; prevC64Clk = c; prevC64Data = d;
  }
  return origSetC64Lines(a, c, d);
};

// === Spy 2: catchUpTo + flush boundaries ===
let catchUpCount = 0;
const origCatch = vice.catchUpTo.bind(vice);
vice.catchUpTo = (clk) => {
  catchUpCount++;
  return origCatch(clk);
};
let flushCount = 0;
const origFlush = vice.flush.bind(vice);
vice.flush = () => { flushCount++; return origFlush(); };

// === Spy 3: VIA1 PRB writes (drive's intended IEC contribution) ===
const origVia1Write = via1.write.bind(via1);
via1.write = (reg, value) => {
  const r = reg & 0x0f;
  if (r === 0x00) {
    const v = value & 0xff;
    // Decode drive-intended states from PRB write (after polarity fix).
    const driven = v & (via1.ddrb ?? 0x1a);
    push({
      kind: "drvPrbWrite",
      t: session.c64Cpu.cycles,
      drvClk: driveCpu.cpu.clk,
      drvPc: driveCpu.pc & 0xffff,
      prb: v,
      driven,
      drvData: (driven & 0x02) === 0 ? "rel" : "pull",
      drvClk_: (driven & 0x08) === 0 ? "rel" : "pull",
      drvAtna: (driven & 0x10) === 0 ? "rel" : "pull",
    });
  }
  return origVia1Write(reg, value);
};

// === Spy 4: CA1 IFR latches ===
let ca1Latches = 0;
const origSignalCa1 = via1.signalCa1.bind(via1);
via1.signalCa1 = (edge) => {
  const ifrBefore = via1.ifr;
  origSignalCa1(edge);
  if ((via1.ifr & 0x02) && !(ifrBefore & 0x02)) {
    ca1Latches++;
    push({
      kind: "ca1Latch",
      t: session.c64Cpu.cycles,
      drvPc: driveCpu.pc & 0xffff,
      edge: edge === 0 ? "FALL/release" : "RISE/assert",
    });
  }
};

const ramMount = await mountMedia(session, 8, diskPath);
if (ramMount.errors?.length) {
  console.error("mount errs", ramMount.errors); process.exit(1);
}

session.resetCold("pal-default");
session.runFor(2_000_000); // boot to READY

console.log(`\n=== Stage B: type LOAD"$",8 ===`);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
{
  const target = session.c64Cpu.cycles + 14 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}

// === Event-stream output (filtered) ===
console.log(`\n=== ${events.length} events captured (cap=${MAX_EVENTS}) ===`);
console.log(`catchUpCount=${catchUpCount}, flushCount=${flushCount}, ca1Latches=${ca1Latches}`);
console.log("");

// Pass 1 — ATN-related milestone events
console.log("=== ATN-edge milestones ===");
for (const e of events) {
  if (e.kind === "iecLineDrive" && e.tag !== "bus-toggle") {
    console.log(`  t=${e.t.toString().padEnd(9)} c64Pc=$${e.c64Pc.toString(16).padStart(4,"0")} cia2Pa=$${e.cia2Pa.toString(16).padStart(2,"0")} ${e.tag} (drv at $${e.drvPc.toString(16).padStart(4,"0")})`);
  } else if (e.kind === "ca1Latch") {
    console.log(`  t=${e.t.toString().padEnd(9)} drv=$${e.drvPc.toString(16).padStart(4,"0")} CA1-latched edge=${e.edge}`);
  }
}

// Pass 2 — total bus-toggle count (just count, full table too long)
const busToggles = events.filter((e) => e.kind === "iecLineDrive" && e.tag === "bus-toggle");
const drvPrbWrites = events.filter((e) => e.kind === "drvPrbWrite");
console.log("");
console.log(`=== iecLineDrive bus-toggle count: ${busToggles.length} ===`);
console.log(`=== drv PRB writes: ${drvPrbWrites.length} ===`);

// Pass 3 — show C64-side IEC events within ±50 events of each ATN-edge.
const atnIdxs = events
  .map((e, i) => [e, i])
  .filter(([e]) => e.kind === "iecLineDrive" && e.tag !== "bus-toggle")
  .map(([, i]) => i);

console.log("");
console.log("=== Detailed event windows around each ATN edge (±10 events) ===");
for (const idx of atnIdxs) {
  const lo = Math.max(0, idx - 10);
  const hi = Math.min(events.length, idx + 10);
  console.log(`--- around event #${idx} ---`);
  for (let i = lo; i < hi; i++) {
    const e = events[i];
    if (e.kind === "iecLineDrive") {
      const m = i === idx ? "*" : " ";
      console.log(`  ${m} #${i} t=${e.t} c64Pc=$${e.c64Pc.toString(16).padStart(4,"0")} cia2Pa=$${e.cia2Pa.toString(16).padStart(2,"0")} ATN=${e.atn} CLK=${e.clk} DATA=${e.data} ${e.tag}`);
    } else if (e.kind === "drvPrbWrite") {
      console.log(`    #${i} t=${e.t} DRV PRB=$${e.prb.toString(16).padStart(2,"0")} (data=${e.drvData} clk=${e.drvClk_} atna=${e.drvAtna}) drvPc=$${e.drvPc.toString(16).padStart(4,"0")}`);
    } else if (e.kind === "ca1Latch") {
      console.log(`    #${i} t=${e.t} CA1-latched edge=${e.edge}`);
    }
  }
}

// Decoded ATN command bytes: examine drive PRB writes during ATN-asserted
// windows. The drive shifts the C64-sent byte into $85 via bit-bang;
// the actual byte arrives in drive RAM by the end of the byte cycle.
// We can't directly read "byte received" without tracking $85, but the
// COUNT of PRB-write bursts between ATN-edges tells us approximately
// how many bytes traversed.

console.log("");
console.log("=== ATN command byte burst analysis ===");
let atnAsserted = false;
let burstWrites = 0;
const bursts = [];
let burstStart = 0;
for (const e of events) {
  if (e.kind === "iecLineDrive" && e.tag === "ATN-ASSERT") {
    atnAsserted = true; burstWrites = 0; burstStart = e.t;
  } else if (e.kind === "iecLineDrive" && e.tag === "ATN-RELEASE") {
    if (atnAsserted) {
      bursts.push({ start: burstStart, end: e.t, drvWrites: burstWrites });
    }
    atnAsserted = false;
  } else if (e.kind === "drvPrbWrite" && atnAsserted) {
    burstWrites++;
  }
}
for (const [i, b] of bursts.entries()) {
  console.log(`  burst #${i}: t=${b.start}..${b.end} drvPrbWrites=${b.drvWrites}`);
}
console.log(`  total bursts: ${bursts.length}`);
console.log(`  (expected for LOAD"$",8: 2 bursts — LISTEN-seq + TALK-seq)`);
