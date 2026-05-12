#!/usr/bin/env node
// Headless runtime-trace — emit VICE-compatible runtime-trace JSONL from our
// headless emulator.  Schema matches VICE vice-runtime-trace-motm output
// EXACTLY so the existing parser (src/runtime/vice/trace-runtime.ts) and
// diff tools work without modification.
//
// Schema (two event kinds, interleaved):
//
//   { "kind": "sample",
//     "sampleIndex": <N>,
//     "capturedAt": "<ISO8601>",
//     "currentPc": <int>,
//     "items": <int>,
//     "memspace": "c64" | "drive" }
//
//   { "kind": "instruction",
//     "sampleIndex": <N>,
//     "clock": "<string>",           // BigInt-style string
//     "pc": <int>,
//     "instructionBytes": [b0, b1, b2, b3],  // always 4 bytes, padded 0/255
//     "registers": { "PC": <int>, "A": <int>, "X": <int>, "Y": <int>,
//                    "SP": <int>, "FL": <int>,
//                    "LIN": 65535, "CYC": 65535 },
//     "memspace": "c64" | "drive" }
//
// Chunk pattern (mirrors VICE cpuhistory sampling):
//   For each sample boundary:
//     1. emit sample(memspace:"c64",  sampleIndex=N, items=c64RingLen,  currentPc=c64Pc)
//     2. emit N c64  instruction events (oldest → newest from ring buffer)
//     3. emit sample(memspace:"drive", sampleIndex=N, items=drvRingLen, currentPc=drvPc)
//     4. emit N drive instruction events
//
// Boot recipe (motm):
//   resetCold → runCycles(2_500_000) → typeText('LOAD"*",8,1\n') → loop
//   NO RUN — motm auto-starts after LOAD (JMP $4000).
//
// Usage:
//   node scripts/headless-runtime-trace.mjs \
//     --id motm \
//     [--end-cycle 100000000] \
//     [--cpu-history 200] \
//     [--interval-cycles 1000000] \
//     [--max-rows 1000000] \
//     [--out traces/<id>_headless_runtime_<ts>/runtime-trace.jsonl]
//
// NPM script: trace:motm-headless-runtime
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, appendFileSync, createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

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

const id              = args.id ?? "motm";
const endCycle        = Number(args["end-cycle"]        ?? 100_000_000);
const cpuHistory      = Number(args["cpu-history"]      ?? 200);
const intervalCycles  = Number(args["interval-cycles"]  ?? 1_000_000);
const maxRows         = Number(args["max-rows"]         ?? 1_000_000);
const projectDir      = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;

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
  const traceDir = join(projectDir, "traces", `${id}_headless_runtime_${tsTag}`);
  mkdirSync(traceDir, { recursive: true });
  outPath = join(traceDir, "runtime-trace.jsonl");
}
mkdirSync(dirname(outPath), { recursive: true });

console.error(`Headless runtime-trace (VICE-schema)`);
console.error(`Manifest: ${entry.id} (${entry.family})`);
console.error(`Disk: ${diskPath}`);
console.error(`Output: ${outPath}`);
console.error(`End cycle: ${endCycle.toLocaleString()}  Interval cycles: ${intervalCycles.toLocaleString()}`);
console.error(`CPU history per chunk: ${cpuHistory}  Max rows: ${maxRows.toLocaleString()}`);

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

const c64Cpu   = session.c64Cpu;     // Cpu65xxVice (microcoded)
const driveCpu = session.drive.cpu;  // Cpu65xxVice (microcoded)
const scheduler = session.scheduler;
const c64Bus   = session.c64Bus;
const driveBus = session.drive.bus;

if (!scheduler) {
  console.error("ERROR: scheduler not available — need useCycleLockstep=true");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock helpers
// ─────────────────────────────────────────────────────────────────────────────
function c64Clock() { return scheduler.c64Cycle(); }
function drvClock() { return scheduler.driveCycle(); }

// ─────────────────────────────────────────────────────────────────────────────
// Opcode size table — trim instructionBytes to actual instruction length
// Matches VICE: always emits 4 bytes (using 0/255 as padding).
// We read the full 4 bytes regardless and let the consumer decide.
// ─────────────────────────────────────────────────────────────────────────────
// (We always emit 4 bytes to match VICE — no trimming needed.)

// ─────────────────────────────────────────────────────────────────────────────
// Raw memory peek (non-side-effecting)
// ─────────────────────────────────────────────────────────────────────────────
// Save originals before any patching (not needed here since we don't patch,
// but keep symmetry with headless-full-trace.mjs style).
const origC64Read = c64Bus.read.bind(c64Bus);
const origDrvRead = driveBus.read.bind(driveBus);

function peekC64(addr) {
  const a = addr & 0xffff;
  // RAM regions: direct read to avoid side effects.
  if (a <= 0x9fff || (a >= 0xc000 && a <= 0xcfff)) return (c64Bus.ram?.[a] ?? origC64Read(a)) & 0xff;
  return origC64Read(a) & 0xff;
}

function peekDrv(addr) {
  const a = addr & 0xffff;
  if (a < 0x0800) return (driveBus.ram?.[a] ?? origDrvRead(a)) & 0xff;
  return origDrvRead(a) & 0xff;
}

// Read 4 instruction bytes (VICE always emits 4, padded with 0/255).
function readInstructionBytes(side, pc) {
  const peek = side === "c64" ? peekC64 : peekDrv;
  return [
    peek(pc),
    peek((pc + 1) & 0xffff),
    peek((pc + 2) & 0xffff),
    peek((pc + 3) & 0xffff),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring buffers — fixed-size circular arrays
// ─────────────────────────────────────────────────────────────────────────────
// Each slot: { clock, pc, instructionBytes, registers }
class RingBuffer {
  constructor(size) {
    this.size = size;
    this.buf  = new Array(size);
    this.head = 0;   // next write index
    this.count = 0;  // number of valid entries (capped at size)
  }

  push(item) {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  // Return entries in order oldest→newest (VICE cpuhistory order).
  toArray() {
    if (this.count === 0) return [];
    const result = new Array(this.count);
    const start = this.count < this.size ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buf[(start + i) % this.size];
    }
    return result;
  }

  clear() {
    this.head  = 0;
    this.count = 0;
  }
}

const c64Ring  = new RingBuffer(cpuHistory);
const drvRing  = new RingBuffer(cpuHistory);

// ─────────────────────────────────────────────────────────────────────────────
// Boundary detection state
// ─────────────────────────────────────────────────────────────────────────────
function c64AtBoundary() { return (c64Cpu.isAtInstructionBoundary?.() ?? true); }
function drvAtBoundary() { return (driveCpu.isAtInstructionBoundary?.() ?? true); }

let prevC64Boundary = true;
let prevDrvBoundary = true;

// ─────────────────────────────────────────────────────────────────────────────
// Emit helpers
// ─────────────────────────────────────────────────────────────────────────────
let totalRows  = 0;
let sampleIndex = 0;

function emitLine(obj) {
  appendFileSync(outPath, JSON.stringify(obj) + "\n");
  totalRows++;
}

function flushChunk() {
  const now = new Date().toISOString();

  // --- C64 chunk ---
  const c64Items = c64Ring.toArray();
  const c64Pc    = c64Cpu.pc & 0xffff;
  emitLine({
    kind:        "sample",
    sampleIndex,
    capturedAt:  now,
    currentPc:   c64Pc,
    items:        c64Items.length,
    memspace:    "c64",
  });
  for (const item of c64Items) {
    emitLine({
      kind:             "instruction",
      sampleIndex,
      clock:            String(item.clock),
      pc:               item.pc,
      instructionBytes: item.instructionBytes,
      registers:        item.registers,
      memspace:         "c64",
    });
  }

  // --- Drive chunk ---
  const drvItems = drvRing.toArray();
  const drvPc    = driveCpu.pc & 0xffff;
  emitLine({
    kind:        "sample",
    sampleIndex,
    capturedAt:  now,
    currentPc:   drvPc,
    items:        drvItems.length,
    memspace:    "drive",
  });
  for (const item of drvItems) {
    emitLine({
      kind:             "instruction",
      sampleIndex,
      clock:            String(item.clock),
      pc:               item.pc,
      instructionBytes: item.instructionBytes,
      registers:        item.registers,
      memspace:         "drive",
    });
  }

  sampleIndex++;

  // Keep rolling — ring buffer already overwrites oldest entries naturally.
  // We do NOT clear so each chunk retains the last N instructions.
  // (VICE keeps rolling chistory; this mirrors that behavior.)
}

function captureInstruction(side, cpu, clock) {
  const pc = cpu.pc & 0xffff;
  const bytes = readInstructionBytes(side, pc);
  const fl = (cpu.flags ?? cpu.p ?? 0) & 0xff;
  const record = {
    clock,
    pc,
    instructionBytes: bytes,
    registers: {
      PC:  pc,
      A:   cpu.a  & 0xff,
      X:   cpu.x  & 0xff,
      Y:   cpu.y  & 0xff,
      SP:  cpu.sp & 0xff,
      FL:  fl,
      LIN: 65535,   // VIC raster — not available headless, emit VICE sentinel
      CYC: 65535,   // VIC dot cycle — same
    },
  };
  if (side === "c64") {
    c64Ring.push(record);
  } else {
    drvRing.push(record);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot sequence (motm)
// ─────────────────────────────────────────────────────────────────────────────
session.resetCold();
scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');

// Initialise boundary state after boot (boot phase not traced).
prevC64Boundary = c64AtBoundary();
prevDrvBoundary = drvAtBoundary();

console.error(`Boot complete (2.5M cycles + LOAD typed). c64 cyc=${c64Clock()}`);
console.error(`Starting chunked trace loop (interval=${intervalCycles.toLocaleString()} cycles)...`);

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
let nextFlushAt = c64Clock() + intervalCycles;
let stopped = false;

while (!stopped) {
  const nowCyc = c64Clock();
  if (nowCyc >= endCycle) break;
  if (totalRows >= maxRows) break;

  scheduler.executeCycle();

  // C64 boundary detection
  const nowC64 = c64AtBoundary();
  if (!prevC64Boundary && nowC64) {
    captureInstruction("c64", c64Cpu, c64Clock());
  }
  prevC64Boundary = nowC64;

  // Drive boundary detection
  const nowDrv = drvAtBoundary();
  if (!prevDrvBoundary && nowDrv) {
    captureInstruction("drive", driveCpu, drvClock());
  }
  prevDrvBoundary = nowDrv;

  // Chunk flush at interval boundary
  const afterCyc = c64Clock();
  if (afterCyc >= nextFlushAt) {
    flushChunk();
    nextFlushAt = afterCyc + intervalCycles;

    if (sampleIndex % 10 === 0) {
      console.error(`  [chunk=${sampleIndex}] c64cyc=${afterCyc.toLocaleString()} rows=${totalRows.toLocaleString()} c64ring=${c64Ring.count} drvring=${drvRing.count}`);
    }
  }
}

// Flush final partial chunk
if (c64Ring.count > 0 || drvRing.count > 0) {
  flushChunk();
}

const elapsed = Date.now() - t0;
const rowsPerSec = totalRows > 0 ? Math.round(totalRows / (elapsed / 1000)) : 0;

console.error(``);
console.error(`Trace complete in ${elapsed} ms`);
console.error(`Total rows: ${totalRows.toLocaleString()}  Rows/sec: ${rowsPerSec.toLocaleString()}`);
console.error(`Chunks emitted: ${sampleIndex}`);
console.error(`Final c64 cyc: ${c64Clock()}  drv cyc: ${drvClock()}`);
console.error(`Output: ${outPath}`);

if (totalRows === 0) {
  console.error(`WARNING: No rows emitted. Check boundary detection + boot.`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary statistics — stream-based (avoids OOM on large outputs)
// ─────────────────────────────────────────────────────────────────────────────
const kindDist     = {};
const memspaceDist = {};
let firstEvent = null, lastEvent = null, lineCount = 0;

{
  const rl = createInterface({ input: createReadStream(outPath) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (lineCount === 1) firstEvent = obj;
    lastEvent = obj;
    kindDist[obj.kind]         = (kindDist[obj.kind]         ?? 0) + 1;
    if (obj.memspace) memspaceDist[obj.memspace] = (memspaceDist[obj.memspace] ?? 0) + 1;
  }
}

console.error(`\nEvent kind distribution:`);
for (const [k, n] of Object.entries(kindDist).sort()) {
  console.error(`  ${String(k).padEnd(12)} ${n.toLocaleString()}`);
}
console.error(`\nMemspace distribution:`);
for (const [k, n] of Object.entries(memspaceDist).sort()) {
  console.error(`  ${String(k).padEnd(8)} ${n.toLocaleString()}`);
}

// Clock range from instruction events
const clocks = [];
{
  const rl2 = createInterface({ input: createReadStream(outPath) });
  let i = 0;
  for await (const line of rl2) {
    if (!line.trim()) continue;
    i++;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.kind === "instruction") {
      if (clocks.length === 0) clocks.push(Number(obj.clock));
      clocks[1] = Number(obj.clock);
    }
    if (i > lineCount) break; // safety
  }
}
if (clocks.length >= 2) {
  console.error(`\nClock range (instruction events): ${clocks[0]} → ${clocks[1]}`);
}
if (firstEvent) {
  const firstTs = firstEvent.capturedAt ?? "(no capturedAt)";
  const lastTs  = lastEvent?.capturedAt  ?? "(no capturedAt)";
  console.error(`capturedAt range: ${firstTs} → ${lastTs}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation — check first instruction event matches VICE schema
// ─────────────────────────────────────────────────────────────────────────────
const requiredSampleKeys      = ["kind","sampleIndex","capturedAt","currentPc","items","memspace"];
const requiredInstructionKeys = ["kind","sampleIndex","clock","pc","instructionBytes","registers","memspace"];
const requiredRegisterKeys    = ["PC","A","X","Y","SP","FL","LIN","CYC"];

let firstSample = null, firstInstruction = null;
{
  const rl3 = createInterface({ input: createReadStream(outPath) });
  for await (const line of rl3) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!firstSample && obj.kind === "sample")       firstSample = obj;
    if (!firstInstruction && obj.kind === "instruction") firstInstruction = obj;
    if (firstSample && firstInstruction) break;
  }
}

let schemaOk = true;

if (!firstSample) {
  console.error(`SCHEMA ERROR: no 'sample' event found`);
  schemaOk = false;
} else {
  const miss = requiredSampleKeys.filter((k) => !(k in firstSample));
  if (miss.length > 0) { console.error(`SCHEMA ERROR sample missing keys: ${miss.join(", ")}`); schemaOk = false; }
}

if (!firstInstruction) {
  console.error(`SCHEMA ERROR: no 'instruction' event found`);
  schemaOk = false;
} else {
  const miss = requiredInstructionKeys.filter((k) => !(k in firstInstruction));
  if (miss.length > 0) { console.error(`SCHEMA ERROR instruction missing keys: ${miss.join(", ")}`); schemaOk = false; }
  if (!Array.isArray(firstInstruction.instructionBytes) || firstInstruction.instructionBytes.length !== 4) {
    console.error(`SCHEMA ERROR: instructionBytes must be array[4], got: ${JSON.stringify(firstInstruction.instructionBytes)}`);
    schemaOk = false;
  }
  if (typeof firstInstruction.clock !== "string") {
    console.error(`SCHEMA ERROR: clock must be string, got: ${typeof firstInstruction.clock}`);
    schemaOk = false;
  }
  if (firstInstruction.registers) {
    const missR = requiredRegisterKeys.filter((k) => !(k in firstInstruction.registers));
    if (missR.length > 0) { console.error(`SCHEMA ERROR registers missing keys: ${missR.join(", ")}`); schemaOk = false; }
  }
}

if (schemaOk) {
  console.error(`\nSchema OK — matches VICE runtime-trace schema exactly.`);
  console.error(`\nSample instruction event:`);
  console.error(JSON.stringify(firstInstruction, null, 2));
} else {
  process.exit(1);
}
