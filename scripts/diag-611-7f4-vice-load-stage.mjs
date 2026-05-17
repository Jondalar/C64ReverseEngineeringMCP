#!/usr/bin/env node
// Spec 611 phase 611.7f.4 — DIAGNOSTIC (no patch).
//
// Per Codex 05:57: "identify which VICE1541 stage is missing between
// 'C64 in KERNAL serial RX' and 'drive emits TALK bytes'. Use
// probes/traces if needed, but the fix must be a literal-port
// correction in VICE1541, not a bridge shortcut."
//
// Mounts samples/synthetic/blank.d64, drives drive1541="vice", types
// LOAD"$",8 + LIST under bridge. While running, sample at intervals:
//   - drive PC (running? stuck? in ATN region $e85b/$e853 KERNAL serial?)
//   - drive cycles advance
//   - C64 ATN-edge count seen by drive
//   - drive's iecBus pull state (DATA / CLK / ATNA)
//   - VIA1 PCR + PRA + PRB values
//   - VIA2 PB values
//   - head-position halftrack
//
// Output: time series, then summary of first missing stage.
//
// NO source mutation. Read-only diagnostic.

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
const via2 = driveCpu.via2;

// Spy ATN edges into VIA1 CA1.
let atnEdgesIn = 0;
const origSetC64IecLines = driveCpu.setC64IecLines.bind(driveCpu);
let lastAtnSeen = viceIec.c64AtnReleased;
driveCpu.setC64IecLines = (a, c, d) => {
  if (a !== lastAtnSeen) { atnEdgesIn++; lastAtnSeen = a; }
  return origSetC64IecLines(a, c, d);
};

// Spy VIA1 PRB writes.
let prbWrites = 0;
const prbWriteHistory = [];
const origVia1Write = via1.write.bind(via1);
via1.write = (reg, value) => {
  if ((reg & 0x0f) === 0x00) {
    prbWrites++;
    if (prbWriteHistory.length < 32) {
      prbWriteHistory.push({
        t: session.c64Cpu.cycles,
        drvClk: driveCpu.cpu.clk,
        drvPc: driveCpu.pc & 0xffff,
        prb: value & 0xff,
      });
    }
  }
  return origVia1Write(reg, value);
};

// Spy CA1 IFR latches (= IRQ fires from ATN edge).
let ca1Latches = 0;
const origSignalCa1 = via1.signalCa1.bind(via1);
via1.signalCa1 = (edge) => {
  const ifrBefore = via1.ifr;
  origSignalCa1(edge);
  if ((via1.ifr & 0x02) && !(ifrBefore & 0x02)) {
    ca1Latches++;
  }
};

// Drive PC histogram — count instructions per PC bucket during LOAD.
// Capture every instruction so we can find caller of $EA60.
const pcHisto = new Map();
let sampleEnabled = false;
const origExecuteCycle = driveCpu.cpu.executeCycle.bind(driveCpu.cpu);
driveCpu.cpu.executeCycle = function () {
  if (sampleEnabled) {
    const pc = this.reg_pc & 0xffff;
    pcHisto.set(pc, (pcHisto.get(pc) ?? 0) + 1);
  }
  return origExecuteCycle();
};

// Sample drive RAM $79, $7A, $7D (the ATN-state flags from $E85B/$E8D7).
function ramFlags() {
  return {
    z79: driveCpu.mem.read(0x79) & 0xff,
    z7a: driveCpu.mem.read(0x7a) & 0xff,
    z7d: driveCpu.mem.read(0x7d) & 0xff,
    z77: driveCpu.mem.read(0x77) & 0xff,
    z78: driveCpu.mem.read(0x78) & 0xff,
  };
}

// Snapshot of VIA1 PRA/PRB/PCR. Read internals via property access
// when public not present.
function viaSnap(via) {
  return {
    pra: via?.pra ?? via?.regs?.[0x01] ?? "?",
    prb: via?.prb ?? via?.regs?.[0x00] ?? "?",
    ddra: via?.ddra ?? via?.regs?.[0x03] ?? "?",
    ddrb: via?.ddrb ?? via?.regs?.[0x02] ?? "?",
    pcr: via?.pcr ?? via?.regs?.[0x0c] ?? "?",
    ifr: via?.ifr ?? via?.regs?.[0x0d] ?? "?",
    ier: via?.ier ?? via?.regs?.[0x0e] ?? "?",
  };
}

const ramMount = await mountMedia(session, 8, diskPath);
console.log("mount:", { errors: ramMount.errors ?? "none", gcrLoaded: drive.gcrImageLoaded });

session.resetCold("pal-default");

// Helper: PC bucket — KERNAL serial regions of interest.
// $E853..$E8B7  = serial byte RX (CIA2 bit-bang)
// $E909..$E97D  = serial byte TX
// $ED40..       = c64 IECIN / IECOUT / OPEN routines
// $ED5A         = serial RX wait
// $EDB9         = serial TX wait
// $F4A5..$F50A  = OPEN
// $F4F8..       = LOAD
// $E45F         = LIST loop
function c64PcRegion(pc) {
  if (pc >= 0xe853 && pc < 0xe8b7) return "C64-serial-RX";
  if (pc >= 0xe909 && pc < 0xe97d) return "C64-serial-TX";
  if (pc >= 0xed00 && pc < 0xee00) return "C64-IECIN/IECOUT";
  if (pc >= 0xf400 && pc < 0xf600) return "C64-OPEN/LOAD";
  if (pc >= 0xa400 && pc < 0xa800) return "C64-BASIC-LOAD";
  if (pc >= 0xe5cd && pc <= 0xe5d4) return "C64-BASIC-READY";
  return null;
}
// 1541 ROM regions of interest (KERNAL 1541 at $C000-$FFFF):
// $EA0E       = ATN service entry (via IRQ vector $0094 typically)
// $E853..     = drive serial RX byte
// $E909..     = drive serial TX byte
// $EC9E       = listen routine
// $E2B0       = idle loop
// $C194/C1BD  = DOS command handler entry
function drivePcRegion(pc) {
  if (pc >= 0xea00 && pc < 0xea60) return "DRV-ATN-svc";
  if (pc >= 0xea60 && pc < 0xeb00) return "DRV-listen";
  if (pc >= 0xeb00 && pc < 0xec00) return "DRV-talk-handler";
  if (pc >= 0xec00 && pc < 0xed00) return "DRV-TALK-byte-out";
  if (pc >= 0xe853 && pc < 0xe8b7) return "DRV-serial-RX";
  if (pc >= 0xc100 && pc < 0xc400) return "DRV-DOS-cmd";
  if (pc >= 0xeb22 && pc < 0xeb80) return "DRV-idle-loop";
  if (pc >= 0xeaa0 && pc < 0xeb00) return "DRV-init";
  return null;
}

function snap(label) {
  const ddr_pa = (session.cia2?.ddra ?? 0) & 0xff;
  const cia2_pa = (session.cia2?.pra ?? 0) & 0xff;
  const cpu_bus = session.iecBus.core.cpu_bus & 0xff;
  const cpu_port = session.iecBus.core.cpu_port & 0xff;
  const drv_port = session.iecBus.core.drv_port & 0xff;
  const c64Pc = session.c64Cpu.pc & 0xffff;
  const drvPc = driveCpu.pc & 0xffff;
  const drvClk = driveCpu.cpu.clk;
  const via1S = viaSnap(via1);
  const via2S = viaSnap(via2);

  console.log(`[${label}] t=${session.c64Cpu.cycles}`);
  console.log(`  C64 PC=$${c64Pc.toString(16).padStart(4,"0")} (${c64PcRegion(c64Pc) ?? "other"})`);
  console.log(`  DRV PC=$${drvPc.toString(16).padStart(4,"0")} (${drivePcRegion(drvPc) ?? "other"}) drvClk=${drvClk}`);
  console.log(`  IEC C64: atn=${viceIec.c64AtnReleased?1:0} clk=${viceIec.c64ClkReleased?1:0} data=${viceIec.c64DataReleased?1:0}`);
  console.log(`  IEC DRV: data=${viceIec.drvDataReleased?1:0} clk=${viceIec.drvClkReleased?1:0} atna=${viceIec.drvAtnaReleased?1:0}`);
  console.log(`  CIA2 PA=$${cia2_pa.toString(16).padStart(2,"0")} DDR=$${ddr_pa.toString(16).padStart(2,"0")} core.cpu_bus=$${cpu_bus.toString(16).padStart(2,"0")} cpu_port=$${cpu_port.toString(16).padStart(2,"0")} drv_port=$${drv_port.toString(16).padStart(2,"0")}`);
  console.log(`  VIA1 PRA=$${(typeof via1S.pra==="number"?via1S.pra.toString(16):via1S.pra).padStart(2,"0")} PRB=$${(typeof via1S.prb==="number"?via1S.prb.toString(16):via1S.prb).padStart(2,"0")} PCR=$${(typeof via1S.pcr==="number"?via1S.pcr.toString(16):via1S.pcr).padStart(2,"0")} IFR=$${(typeof via1S.ifr==="number"?via1S.ifr.toString(16):via1S.ifr).padStart(2,"0")} IER=$${(typeof via1S.ier==="number"?via1S.ier.toString(16):via1S.ier).padStart(2,"0")}`);
  console.log(`  VIA2 PRA=$${(typeof via2S.pra==="number"?via2S.pra.toString(16):via2S.pra).padStart(2,"0")} PRB=$${(typeof via2S.prb==="number"?via2S.prb.toString(16):via2S.prb).padStart(2,"0")}`);
  console.log(`  ATN edges in: ${atnEdgesIn}, head HT=${drive.currentHalfTrack}`);
  const f = ramFlags();
  console.log(`  drv-RAM: $77=$${f.z77.toString(16).padStart(2,"0")} $78=$${f.z78.toString(16).padStart(2,"0")} $79=$${f.z79.toString(16).padStart(2,"0")} $7a=$${f.z7a.toString(16).padStart(2,"0")} $7d=$${f.z7d.toString(16).padStart(2,"0")}`);
}

console.log(`\n=== Stage A: boot to READY ===\n`);
session.runFor(2_000_000);
snap("post-boot");

console.log(`\n=== Stage B: type LOAD"$",8 ===\n`);
sampleEnabled = true; // begin PC histogram capture
session.typeText('LOAD"$",8\r', 80_000, 80_000);

const PAL_HZ = 985_248;
// Sample 16 windows of ~2 sec each (extend to 32s total).
const target = session.c64Cpu.cycles + 32 * PAL_HZ;
const slice = (32 * PAL_HZ) / 16;
for (let i = 0; i < 16; i++) {
  const end = session.c64Cpu.cycles + slice;
  while (session.c64Cpu.cycles < end) session.runFor(200_000);
  snap(`t+${(i+1)*1.5}s`);
}

console.log(`\n=== Stage C: type LIST ===\n`);
session.typeText("LIST\r", 80_000, 80_000);
{
  const e = session.c64Cpu.cycles + 2 * PAL_HZ;
  while (session.c64Cpu.cycles < e) session.runFor(200_000);
}
snap("post-LIST");

console.log(`\n=== Summary ===`);
console.log(`atnEdgesIn (whole LOAD window): ${atnEdgesIn}`);
console.log(`ca1Latches (= IFR_CA1 set from edge):  ${ca1Latches}`);
console.log(`prbWrites (= drive ROM wrote VIA1 PB): ${prbWrites}`);
console.log(`drive cycles ran: ${driveCpu.cpu.clk}`);
console.log(`drive final PC: $${(driveCpu.pc & 0xffff).toString(16)}`);
console.log(`drive iecBus pulls: data=${!viceIec.drvDataReleased?1:0} clk=${!viceIec.drvClkReleased?1:0} atna=${!viceIec.drvAtnaReleased?1:0}`);

console.log(`\n=== First ${Math.min(32, prbWriteHistory.length)} PRB writes ===`);
for (const e of prbWriteHistory) {
  console.log(`  t=${e.t} drvClk=${e.drvClk} drvPc=$${e.drvPc.toString(16).padStart(4,"0")} PRB=$${e.prb.toString(16).padStart(2,"0")}`);
}

console.log(`\n=== Top 30 drive PC buckets (whole LOAD window) ===`);
const sorted = [...pcHisto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
const totalSamples = [...pcHisto.values()].reduce((a, b) => a + b, 0);
for (const [pc, n] of sorted) {
  const pct = (100 * n / totalSamples).toFixed(1);
  console.log(`  $${pc.toString(16).padStart(4,"0")}  ${n}  (${pct}%)`);
}
console.log(`(total samples: ${totalSamples}; unique PCs: ${pcHisto.size})`);
