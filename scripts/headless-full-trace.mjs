#!/usr/bin/env node
// Spec 152 — Headless per-instruction full-trace capture.
//
// Emits ONE JSONL row per C64 CPU instruction boundary AND one row per
// drive CPU instruction boundary, interleaved by master clock.
//
// Schema matches VICE side exactly (Spec 152 § Row schema):
// {
//   ts, tdrv, side, pc, op, operand, a, x, y, sp, p,
//   vic, cia1, cia2, iec, via1, via2, bus
// }
//
// Bus field: per-instruction accumulation of all memory-bus accesses on
// that side, flushed to row at each instruction boundary.
//
// Usage:
//   node scripts/headless-full-trace.mjs \
//     [--id motm] \
//     [--max-rows 1000000] \
//     [--end-cycle 10000000] \
//     [--stop-at-c64-pc 4000] \
//     [--out traces/<id>_headless_full_<ts>.jsonl]
//
// Output: traces/<id>_headless_full_<ts>/headless-full.jsonl  (default)
//
// ─────────────────────────────────────────────────────────────────────────────
// INSTRUCTION-BOUNDARY DETECTION
//
// C64 side:
//   - useMicrocodedCpu=true → c64Cpu is Cpu65xxVice which has
//     isAtInstructionBoundary(). Detect false→true transition per cycle.
//   - useMicrocodedCpu=false → session.cpuCycled.isAtInstructionBoundary()
//     (Cpu6510Cycled.cyclesOwed === 0).
//
// Drive side:
//   - useMicrocodedCpu=true → drive.cpu is Cpu65xxVice with
//     isAtInstructionBoundary().
//   - useMicrocodedCpu=false → DriveCpuCycled.cyclesOwed === 0.
//     DriveCpuCycled is not stored publicly; track boundary via legacy
//     PC-change heuristic on the non-microcoded drive cpu.
//
// We use the scheduler.executeCycle() loop and poll boundary after each
// cycle. When a transition false→true is detected on either side, we
// emit a row for that side BEFORE the boundary-completing cycle.
//
// ─────────────────────────────────────────────────────────────────────────────
// BUS ACCESS HOOKS
//
// We intercept ALL memory bus reads/writes on both sides:
//   C64: session.c64Bus.registerIoHandler wrapping is NOT global.
//        Instead we monkey-patch c64Bus.read/write to accumulate every
//        access. HeadlessMemoryBus exposes read()/write() methods.
//   Drive: wrap driveBus.read/write (same pattern as headless-swimlane-capture.mjs).
//
// Accumulate in per-side ring buffers, flush at instruction boundary.
//
// ─────────────────────────────────────────────────────────────────────────────
// NON-SIDE-EFFECTING STATE READS
//   cia.irqflags & 0xff   — ICR peek (no clear)
//   cia.irq_enabled       — IMR
//   cia.ta.readTimer()    — current timer count (no side effect)
//   via.ifr / .ier        — direct fields
//   vic.raster_y          — direct field
//   vic.irq_status        — direct field

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ─────────────────────────────────────────────────────────────────────────────
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
const maxRows = Number(args["max-rows"] ?? 1_000_000);
const endCycle = Number(args["end-cycle"] ?? 10_000_000);
const stopAtC64Pc = args["stop-at-c64-pc"] !== undefined
  ? parseInt(args["stop-at-c64-pc"], 16)
  : 0x4000;
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;

// ─────────────────────────────────────────────────────────────────────────────
// Manifest / disk lookup
// ─────────────────────────────────────────────────────────────────────────────
const manifestPath = join(repoRoot, "samples/test-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) {
  console.error(`Manifest entry not found: id=${id}`);
  console.error(`Available ids: ${manifest.entries.map((e) => e.id).join(", ")}`);
  process.exit(2);
}
const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) {
  console.error(`Disk image missing (gitignored — local only): ${diskPath}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output path
// ─────────────────────────────────────────────────────────────────────────────
const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
let outPath;
if (args.out) {
  outPath = resolve(projectDir, args.out);
} else {
  const traceDir = join(projectDir, "traces", `${id}_headless_full_${tsTag}`);
  mkdirSync(traceDir, { recursive: true });
  outPath = join(traceDir, "headless-full.jsonl");
}
mkdirSync(dirname(outPath), { recursive: true });

console.error(`Headless full-trace (Spec 152)`);
console.error(`Manifest: ${entry.id} (${entry.family})`);
console.error(`Disk: ${diskPath}`);
console.error(`Output: ${outPath}`);
console.error(`Max rows: ${maxRows.toLocaleString()}  End cycle: ${endCycle.toLocaleString()}`);
console.error(`Stop at c64.pc: $${stopAtC64Pc.toString(16).toUpperCase()}`);

// ─────────────────────────────────────────────────────────────────────────────
// Import runtime
// ─────────────────────────────────────────────────────────────────────────────
const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

// ─────────────────────────────────────────────────────────────────────────────
// Start session — microcoded CPU for per-cycle boundary detection
// ─────────────────────────────────────────────────────────────────────────────
const { session } = startIntegratedSession({
  diskPath,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});

const cia1 = session.cia1;
const cia2 = session.cia2;
const vic = session.vic;
const via1 = session.drive.bus.via1;
const via2 = session.drive.bus.via2;
const iecBus = session.iecBus;
const c64Cpu = session.c64Cpu;         // Cpu65xxVice (microcoded)
const driveCpu = session.drive.cpu;    // Cpu65xxVice (microcoded)
const scheduler = session.scheduler;
const c64Bus = session.c64Bus;
const driveBus = session.drive.bus;

if (!scheduler) {
  console.error("ERROR: scheduler not available — need useCycleLockstep=true");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock helpers
// ─────────────────────────────────────────────────────────────────────────────
function ts() { return scheduler.c64Cycle(); }
function tdrv() { return scheduler.driveCycle(); }

// ─────────────────────────────────────────────────────────────────────────────
// Per-instruction bus accumulation buffers
// ─────────────────────────────────────────────────────────────────────────────
const c64BusAccum = [];   // { addr, value, kind }
const drvBusAccum = [];   // { addr, value, kind }

// ─────────────────────────────────────────────────────────────────────────────
// Patch c64Bus to intercept every read/write
// ─────────────────────────────────────────────────────────────────────────────
const origC64Read = c64Bus.read.bind(c64Bus);
const origC64Write = c64Bus.write.bind(c64Bus);

c64Bus.read = (addr) => {
  const val = origC64Read(addr);
  c64BusAccum.push({ addr: addr & 0xffff, value: val & 0xff, kind: "r" });
  return val;
};

c64Bus.write = (addr, val) => {
  origC64Write(addr, val);
  c64BusAccum.push({ addr: addr & 0xffff, value: val & 0xff, kind: "w" });
};

// ─────────────────────────────────────────────────────────────────────────────
// Patch drive bus to intercept every read/write
// ─────────────────────────────────────────────────────────────────────────────
const origDrvRead = driveBus.read.bind(driveBus);
const origDrvWrite = driveBus.write.bind(driveBus);

driveBus.read = (addr) => {
  const val = origDrvRead(addr);
  drvBusAccum.push({ addr: addr & 0xffff, value: val & 0xff, kind: "r" });
  return val;
};

driveBus.write = (addr, val) => {
  origDrvWrite(addr, val);
  drvBusAccum.push({ addr: addr & 0xffff, value: val & 0xff, kind: "w" });
};

// ─────────────────────────────────────────────────────────────────────────────
// CIA snapshot — non-side-effecting (same as headless-swimlane-capture.mjs)
// ─────────────────────────────────────────────────────────────────────────────
function snapCia(cia) {
  const icr = cia.irqflags & 0xff;
  const imr = cia.irq_enabled & 0xff;
  const ta  = cia.ta.readTimer() & 0xffff;
  const tb  = cia.tb.readTimer() & 0xffff;
  const cra = cia.c_cia[14] ?? 0;
  const crb = cia.c_cia[15] ?? 0;
  return { icr, imr, ta, tb, cra, crb };
}

function snapCia2Extended(cia) {
  const base = snapCia(cia);
  const pra = cia.c_cia[0] ?? 0;
  return { ...base, pra };
}

// ─────────────────────────────────────────────────────────────────────────────
// VIC snapshot
// ─────────────────────────────────────────────────────────────────────────────
function snapVic() {
  return {
    raster:     vic.raster_y & 0x1ff,
    irq_status: vic.irq_status & 0xff,
    imr:        (vic.regs[0x1a] ?? 0) & 0xff,
    ctrl1:      (vic.regs[0x11] ?? 0) & 0xff,
    ctrl2:      (vic.regs[0x16] ?? 0) & 0xff,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IEC snapshot — from IecBus getters (1:1 VICE per Sprint 112)
// ─────────────────────────────────────────────────────────────────────────────
function snapIec() {
  // IecBus.snapshot() returns { line: { atn, clk, data }, c64: {...}, drive: {...} }
  // Line: true = released (high). Spec 152: 0|1 values.
  // Use iecBus.snapshot() directly — it's the authoritative non-side-effecting accessor.
  const snap = iecBus.snapshot();
  return {
    atn:  snap.line.atn  ? 0 : 1,   // 1 = asserted (line low) per VICE convention
    clk:  snap.line.clk  ? 0 : 1,
    data: snap.line.data ? 0 : 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VIA snapshots
// ─────────────────────────────────────────────────────────────────────────────
function snapVia1() {
  return {
    ifr: via1.ifr & 0xff,
    ier: via1.ier & 0xff,
    prb: via1.orb & 0xff,
    pcr: via1.pcr & 0xff,
    acr: via1.acr & 0xff,
    t1c: (via1.t1c !== undefined ? via1.t1c : 0) & 0xffff,
    t2c: (via1.t2c !== undefined ? via1.t2c : 0) & 0xffff,
  };
}

function snapVia2() {
  return {
    ifr: via2.ifr & 0xff,
    ier: via2.ier & 0xff,
    prb: via2.orb & 0xff,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read opcode + operands from memory (non-side-effecting RAM read)
// ─────────────────────────────────────────────────────────────────────────────
// 6502 opcode sizes by addressing mode.
// We do a naive RAM/ROM peek — same bytes the CPU just fetched.
const OPCODE_SIZES = new Uint8Array(256).fill(1);
// 2-byte instructions (immediate, zero-page, zero-page-x, zero-page-y, relative, indirect-x, indirect-y)
const OP2 = [
  0x05,0x06,0x09,0x0a,0x15,0x16,0x18,0x1a,0x25,0x26,0x29,0x35,0x36,0x38,
  0x3a,0x45,0x46,0x49,0x4a,0x55,0x56,0x58,0x5a,0x65,0x66,0x69,0x75,0x76,
  0x78,0x7a,0x85,0x86,0x89,0x8a,0x95,0x96,0x98,0x9a,0xa0,0xa1,0xa2,0xa4,
  0xa5,0xa6,0xa9,0xaa,0xac,0xb0,0xb1,0xb2,0xb4,0xb5,0xb6,0xb8,0xb9,0xba,
  0xc0,0xc1,0xc4,0xc5,0xc6,0xc9,0xca,0xd0,0xd1,0xd2,0xd4,0xd5,0xd6,0xe0,
  0xe1,0xe4,0xe5,0xe6,0xe9,0xea,0xf0,0xf1,0xf2,0xf4,0xf5,0xf6,
  // branches (all relative = 2 bytes)
  0x10,0x30,0x50,0x70,0x90,
  // ZP indirect (65C02-ish, but let's cover 0x12 style = 2 bytes in 6502 context)
];
for (const op of OP2) OPCODE_SIZES[op] = 2;
// 3-byte instructions (absolute, absolute-x, absolute-y, indirect)
const OP3 = [
  0x0c,0x0d,0x0e,0x1d,0x1e,0x20,0x2c,0x2d,0x2e,0x3d,0x3e,0x4c,0x4d,0x4e,
  0x5d,0x5e,0x6c,0x6d,0x6e,0x7d,0x7e,0x8c,0x8d,0x8e,0x9d,0xac,0xad,0xae,
  0xbc,0xbd,0xbe,0xcc,0xcd,0xce,0xdd,0xde,0xec,0xed,0xee,0xfd,0xfe,
  // also JMP indirect and JSR = 3 bytes
];
for (const op of OP3) OPCODE_SIZES[op] = 3;

function peekByte(side, addr) {
  if (side === "c64") {
    const a = addr & 0xffff;
    // Read from c64Bus.ram directly to avoid side effects (hooks accumulate)
    // For ROM areas, fall back to origC64Read (ROM read is side-effect-free).
    // RAM: $0000-$9FFF, $C000-$CFFF.
    if (a <= 0x9fff || (a >= 0xc000 && a <= 0xcfff)) return c64Bus.ram[a] ?? 0;
    // For ROM/IO areas we'll use origC64Read but NOT accumulate into bus buffer.
    return origC64Read(a);
  } else {
    // Drive: RAM $0000-$07FF, ROM $C000-$FFFF, VIA $1800/$1C00.
    const a = addr & 0xffff;
    if (a < 0x0800) return driveBus.ram[a] ?? 0;
    // ROM or VIA — use origDrvRead (no accumulate).
    return origDrvRead(a);
  }
}

function readOpcodeAndOperands(side, pc) {
  const op = peekByte(side, pc);
  const size = OPCODE_SIZES[op] ?? 1;
  const operand = [];
  for (let i = 1; i < size; i++) {
    operand.push(peekByte(side, (pc + i) & 0xffff));
  }
  return { op, operand };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emit row
// ─────────────────────────────────────────────────────────────────────────────
let rowCount = 0;
let stopped = false;

function emitRow(side, cpu, busAccum) {
  if (stopped) return;

  const rowTs   = ts();
  const rowTdrv = tdrv();
  const pc = cpu.pc & 0xffff;
  const { op, operand } = readOpcodeAndOperands(side, pc);

  const cia1Snap = snapCia(cia1);
  const cia2Full = snapCia2Extended(cia2);
  // cia2 in Spec 152: { icr, imr, pra, ta, tb, cra, crb }
  const cia2Snap = {
    icr: cia2Full.icr,
    imr: cia2Full.imr,
    pra: cia2Full.pra,
    ta:  cia2Full.ta,
    tb:  cia2Full.tb,
    cra: cia2Full.cra,
    crb: cia2Full.crb,
  };

  const row = {
    ts: rowTs,
    tdrv: rowTdrv,
    side,
    pc,
    op,
    operand,
    a:  cpu.a  & 0xff,
    x:  cpu.x  & 0xff,
    y:  cpu.y  & 0xff,
    sp: cpu.sp & 0xff,
    p:  (cpu.flags ?? cpu.p ?? 0) & 0xff,
    vic:  snapVic(),
    cia1: cia1Snap,
    cia2: cia2Snap,
    iec:  snapIec(),
    via1: snapVia1(),
    via2: snapVia2(),
    bus:  busAccum.splice(0),   // flush + clear accumulator
  };

  appendFileSync(outPath, JSON.stringify(row) + "\n");
  rowCount++;

  if (rowCount % 10000 === 0) {
    console.error(`  [${rowCount.toLocaleString()}] ts=${rowTs} tdrv=${rowTdrv} side=${side} pc=$${pc.toString(16).padStart(4,"0")}`);
  }

  if (rowCount >= maxRows) stopped = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary detection state
// ─────────────────────────────────────────────────────────────────────────────
// Both CPUs are Cpu65xxVice (microcoded) with isAtInstructionBoundary().
// We detect the RISING EDGE of isAtInstructionBoundary (false→true)
// to emit a row AFTER the instruction completes but before the next begins.

function c64AtBoundary() {
  return (c64Cpu.isAtInstructionBoundary?.() ?? true);
}

function drvAtBoundary() {
  return (driveCpu.isAtInstructionBoundary?.() ?? true);
}

let prevC64AtBoundary = true;   // start assuming at boundary (before first insn)
let prevDrvAtBoundary = true;

// Pending bus accesses for each side (those accumulated during the instruction
// that just completed — the boundary-triggering cycle may itself have accesses).
// We emit row AFTER detecting boundary, passing busAccum (which was flushed
// at the previous boundary, so it contains accesses from the instruction
// that just finished).
//
// CORRECTION: We flush busAccum INTO the row at emit time. The row's `bus`
// field = accesses from the COMPLETED instruction. We reset prev state to
// "boundary now" so the next instruction's accesses accumulate fresh.

// ─────────────────────────────────────────────────────────────────────────────
// Boot sequence (same as headless-swimlane-capture.mjs)
// ─────────────────────────────────────────────────────────────────────────────
session.resetCold();

// Phase A: autoboot BASIC ready
scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');

// Clear accumulator state after boot (boot accesses are uninteresting
// and we want clean per-instruction windows from the run phase).
c64BusAccum.length = 0;
drvBusAccum.length = 0;
prevC64AtBoundary = c64AtBoundary();
prevDrvAtBoundary = drvAtBoundary();

console.error(`Phase A complete (autoboot+type): c64 cyc=${ts()}`);
console.error(`Starting per-instruction trace loop...`);

// ─────────────────────────────────────────────────────────────────────────────
// Main per-cycle loop
// ─────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
let firstC64Pc4000 = false;

while (!stopped) {
  const nowTs = ts();
  if (nowTs >= endCycle) break;

  scheduler.executeCycle();

  // Check C64 boundary
  const nowC64Boundary = c64AtBoundary();
  if (!prevC64AtBoundary && nowC64Boundary) {
    // C64 just completed an instruction — emit row.
    // c64Cpu.pc is now the PC of the NEXT instruction. We want the PC
    // of the instruction that just completed. We capture the PC that was
    // set at the START of the completed instruction.
    // The microcoded CPU sets pc at instruction fetch; by the time
    // boundary is true, pc = start of this completed instruction's fetch.
    // Actually for Cpu65xxVice: at boundary, pc points to the NEXT insn
    // (fetch of next not yet started). We emit with current pc as the
    // "instruction about to start" which is the standard VICE binmon format.
    emitRow("c64", c64Cpu, c64BusAccum);

    // Stop condition: first c64.pc == stopAtC64Pc
    if (!firstC64Pc4000 && (c64Cpu.pc & 0xffff) === stopAtC64Pc) {
      firstC64Pc4000 = true;
      console.error(`Hit stop-at-c64-pc=$${stopAtC64Pc.toString(16).toUpperCase()} at ts=${ts()}`);
      stopped = true;
    }
  }
  prevC64AtBoundary = nowC64Boundary;

  // Check drive boundary
  const nowDrvBoundary = drvAtBoundary();
  if (!prevDrvAtBoundary && nowDrvBoundary) {
    emitRow("drive", driveCpu, drvBusAccum);
  }
  prevDrvAtBoundary = nowDrvBoundary;
}

const elapsed = Date.now() - t0;
const rowsPerSec = rowCount > 0 ? Math.round(rowCount / (elapsed / 1000)) : 0;

console.error(``);
console.error(`Trace complete in ${elapsed} ms`);
console.error(`Total rows: ${rowCount.toLocaleString()}  Rows/sec: ${rowsPerSec.toLocaleString()}`);
console.error(`Final ts: ${ts()}  tdrv: ${tdrv()}`);
console.error(`Output: ${outPath}`);

if (rowCount === 0) {
  console.error(`WARNING: No rows emitted. Check that boundary detection works and boot ran correctly.`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary statistics
// ─────────────────────────────────────────────────────────────────────────────
const lines = readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));
const sideDist = {};
for (const r of rows) sideDist[r.side] = (sideDist[r.side] ?? 0) + 1;
const first = rows[0];
const last  = rows[rows.length - 1];

console.error(`\nSide distribution:`);
for (const [side, count] of Object.entries(sideDist).sort()) {
  console.error(`  ${String(side).padEnd(8)} ${count.toLocaleString()}`);
}
console.error(`ts range: ${first?.ts} → ${last?.ts}`);
console.error(`tdrv range: ${first?.tdrv} → ${last?.tdrv}`);

// Schema spot-check
const required = ["ts","tdrv","side","pc","op","operand","a","x","y","sp","p",
                   "vic","cia1","cia2","iec","via1","via2","bus"];
const sample = rows[0] ?? {};
const missing = required.filter((k) => !(k in sample));
if (missing.length > 0) {
  console.error(`SCHEMA ERROR: missing keys in first row: ${missing.join(", ")}`);
  process.exit(1);
} else {
  console.error(`Schema OK: all ${required.length} required top-level keys present.`);
}

// Sample row
console.error(`\nSample row (first):`);
console.error(JSON.stringify(rows[0], null, 2).split("\n").slice(0, 30).join("\n"));
