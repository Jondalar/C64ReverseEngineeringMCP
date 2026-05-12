#!/usr/bin/env node
// Spec 244 smoke — Taint analysis / dataflow tracking.
//
// Builds a synthetic trace in DuckDB, then exercises traceTaint() across
// 6+ scenarios covering all contribution kinds, IRQ-boundary toggles,
// cross-domain bridge, depth-bound truncation.

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const { allocateInstructionChunk, allocateBusEventChunk, allocateChipEventChunk,
  appendInstruction, appendBusEvent, appendChipEvent } =
  await import(`${repoRoot}/dist/runtime/trace-store/chunk-buffer.js`);
const { openStore, closeStore, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { queryEvents } =
  await import(`${repoRoot}/dist/runtime/headless/v2/query-events.js`);
const { DuckDbQueryBackend } =
  await import(`${repoRoot}/dist/runtime/headless/v2/duckdb-backend.js`);
const { traceTaint } =
  await import(`${repoRoot}/dist/runtime/headless/v2/taint.js`);

const tmpDir = "/tmp/c64re-taint-smoke";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const dbPath = `${tmpDir}/trace.duckdb`;
const meta = {
  runId: "spec244-smoke",
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: "spec244",
  c64ClockHz: 985_248,
  driveClockHz: 1_000_000,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};

const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

// ---------------------------------------------------------------------------
// Build synthetic trace
// ---------------------------------------------------------------------------
//
// Scenario layout:
//
//   cycles 100-300: LDA #$42  (imm, A=0x42)        pc=$0800, opcode=$a9
//   cycle  350:     STA $0763  (A → $0763)           pc=$0802, opcode=$8d
//   cycle  500:     LDA $0763  (read back)           pc=$0900, opcode=$ad
//   cycle  600:     TAX        (A → X)               pc=$0902, opcode=$aa
//   cycle  700:     STX $1000  (X → $1000)           pc=$0904, opcode=$8e
//   cycle  900:     INC $0763  (RMW: old+1)         pc=$0a00, opcode=$ee
//   cycle 1100:     LDA $dc0d  (CIA1 ICR read)      pc=$0b00, opcode=$ad
//   cycle 1200:     STA $0400  (A → $0400, IO src)  pc=$0b03, opcode=$8d
//   cycle 1400:     PHA        (push A onto stack)   pc=$0c00, opcode=$48
//   cycle 1500:     IRQ assert
//   cycle 1600:     STA $0200  (inside IRQ handler)  pc=$ff48, opcode=$8d
//   cycle 1800:     LDA $dd0d  (CIA2 ICR — IEC reg)  pc=$0d00, opcode=$ad
//   cycle 1900:     STA $0600  (IEC-sourced write)   pc=$0d03, opcode=$8d
//
// Deep chain (for depth-bound test):
//   cycles 5000-5404: 101 sequential INC $8000 ← each RMW, creates recursive chain

let seq = 0n;

// --- Instructions ---
const instr = allocateInstructionChunk("headless", "c64", 512);

function addInstr(clock, pc, opcode, a = 0, x = 0, y = 0, sp = 0xff) {
  appendInstruction(instr, {
    seq: seq++, clock: BigInt(clock), masterClock: BigInt(clock),
    pc, opcode, b1: undefined, b2: undefined,
    a, x, y, sp, p: 0x20,
  });
}

// LDA #$42 at pc=$0800
addInstr(100, 0x0800, 0xa9, 0x42);
// STA $0763 at pc=$0802  (opcode $8d = STA abs)
addInstr(350, 0x0802, 0x8d, 0x42);
// LDA $0763 at pc=$0900  (opcode $ad = LDA abs)
addInstr(500, 0x0900, 0xad, 0x42);
// TAX at pc=$0902  (opcode $aa)
addInstr(600, 0x0902, 0xaa, 0x42, 0x42);
// STX $1000 at pc=$0904  (opcode $8e = STX abs)
addInstr(700, 0x0904, 0x8e, 0x42, 0x42);
// INC $0763 at pc=$0a00  (opcode $ee = INC abs)
addInstr(900, 0x0a00, 0xee);
// LDA $dc0d at pc=$0b00  (opcode $ad = LDA abs)
addInstr(1100, 0x0b00, 0xad, 0x80);
// STA $0400 at pc=$0b03  (opcode $8d = STA abs)
addInstr(1200, 0x0b03, 0x8d, 0x80);
// PHA at pc=$0c00  (opcode $48)
addInstr(1400, 0x0c00, 0x48, 0x99, 0, 0, 0xfe);
// STA $0200 (IRQ handler) at pc=$ff48
addInstr(1600, 0xff48, 0x8d, 0x55);
// LDA $dd0d at pc=$0d00
addInstr(1800, 0x0d00, 0xad, 0x04);
// STA $0600 at pc=$0d03
addInstr(1900, 0x0d03, 0x8d, 0x04);

// Deep chain: 101 INC $8000 (each is RMW, recursion depth grows with chain)
// opcode $ee = INC abs
for (let i = 0; i < 101; i++) {
  addInstr(5000 + i * 4, 0xe000 + i * 3, 0xee); // INC $8000
}

await sink.writeInstructionChunk(instr);

// --- Bus events ---
const busChunk = allocateBusEventChunk("headless", "c64", 512);

function addWrite(clock, pc, addr, value) {
  appendBusEvent(busChunk, {
    seq: seq++, clock: BigInt(clock), masterClock: BigInt(clock),
    pc, kind: "write", addr, value,
  });
}
function addRead(clock, pc, addr, value) {
  appendBusEvent(busChunk, {
    seq: seq++, clock: BigInt(clock), masterClock: BigInt(clock),
    pc, kind: "read", addr, value,
  });
}

// STA $0763 = $42
addWrite(350, 0x0802, 0x0763, 0x42);
// LDA $0763 reads $42
addRead(500, 0x0900, 0x0763, 0x42);
// STX $1000 = $42
addWrite(700, 0x0904, 0x1000, 0x42);
// INC $0763: first reads old ($42), writes $43
addRead(900, 0x0a00, 0x0763, 0x42);
addWrite(901, 0x0a00, 0x0763, 0x43);
// LDA $dc0d reads CIA ICR = $80
addRead(1100, 0x0b00, 0xdc0d, 0x80);
// STA $0400 = $80 (IO-sourced)
addWrite(1200, 0x0b03, 0x0400, 0x80);
// PHA: push A=$99 onto stack at $01fe
addWrite(1400, 0x0c00, 0x01fe, 0x99);
// IRQ handler STA $0200 = $55
addWrite(1600, 0xff48, 0x0200, 0x55);
// LDA $dd0d reads CIA2 ICR = $04 (IEC-related)
addRead(1800, 0x0d00, 0xdd0d, 0x04);
// STA $0600 = $04 (IEC-sourced)
addWrite(1900, 0x0d03, 0x0600, 0x04);

// IEC line change near cycle 1800
appendBusEvent(busChunk, {
  seq: seq++, clock: 1750n, masterClock: 1750n,
  pc: 0, kind: "line_change",
  addr: 0, value: 0,
  // drive_data_change carries line_data; use predicate to filter in queries
});

// Deep chain: 101 INC $8000 — each reads old value then writes new (RMW)
for (let i = 0; i < 101; i++) {
  const clk = 5000 + i * 4;
  addRead(clk,     0xe000 + i * 3, 0x8000, i);       // INC reads old
  addWrite(clk + 2, 0xe000 + i * 3, 0x8000, i + 1);  // INC writes new
}

await sink.writeBusEventChunk(busChunk);

// --- Chip events ---
const chipChunk = allocateChipEventChunk("headless", "c64", 32);
// IRQ assert at cycle 1500
appendChipEvent(chipChunk, {
  seq: seq++, clock: 1500n, masterClock: 1500n,
  pc: 0xfe72, chip: "cia1", kind: "irq_assert",
  unit: 0, value: undefined, oldValue: undefined,
});
await sink.writeChipEventChunk(chipChunk);

await sink.close();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const backend = new DuckDbQueryBackend(store.conn);

const results = [];
function pass(name) {
  results.push({ name, pass: true });
  console.log(`  PASS  ${name}`);
}
function fail(name, msg) {
  results.push({ name, pass: false });
  console.log(`  FAIL  ${name}: ${msg}`);
}

console.log("=== Spec 244 — Taint analysis / dataflow tracking ===\n");

// Scenario 1: STA target traces back to LDA source.
// STA $0763 at cycle 350 (A=$42). Taint from cycle 351, addr $0763.
// Should find the write node at cycle 350.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 400,
    startAddr: 0x0763,
  });
  if (!g.root) throw new Error("no root");
  const nodeIds = Object.keys(g.nodes);
  if (nodeIds.length === 0) throw new Error("empty graph");
  // Root should be the STA at cycle 350 to $0763
  if (g.root.cycle !== 350) throw new Error(`root cycle ${g.root.cycle}, expected 350`);
  if (g.root.contribution !== "direct_write") throw new Error(`contribution ${g.root.contribution}`);
  pass("S1: STA target traces back to direct_write at STA cycle");
} catch (e) {
  fail("S1: STA target traces back to direct_write", e.message);
}

// Scenario 2: RMW INC traces self as rmw_modify + prior write at same addr.
// INC $0763 at cycle 901 writes $43. Taint from cycle 950, addr $0763.
// Root = rmw_modify at cycle 901; edges to prior write at cycle 350.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 950,
    startAddr: 0x0763,
  });
  if (!g.root) throw new Error("no root");
  // Root should be the INC write at cycle 901
  if (g.root.cycle !== 901) throw new Error(`root cycle ${g.root.cycle}, expected 901`);
  if (g.root.contribution !== "rmw_modify") throw new Error(`contribution ${g.root.contribution}`);
  // Should have an edge to the prior write (STA at cycle 350)
  const priorNode = Object.values(g.nodes).find((n) => n.cycle === 350 && n.addr === 0x0763);
  if (!priorNode) throw new Error("prior write node at cycle 350 not found");
  pass("S2: RMW INC traces rmw_modify + prior write");
} catch (e) {
  fail("S2: RMW INC traces rmw_modify + prior write", e.message);
}

// Scenario 3: transfer TAX traces across registers.
// STX $1000 at cycle 700 (X=$42). Taint from cycle 750, addr $1000.
// Root = direct_write at cycle 700, contribution direct_write.
// Should have attempted to trace X's source (TAX at cycle 600).
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 750,
    startAddr: 0x1000,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 700) throw new Error(`root cycle ${g.root.cycle}, expected 700`);
  if (g.root.contribution !== "direct_write") throw new Error(`contribution ${g.root.contribution}`);
  // The STX node should record that X was the source register
  const sourceInfo = g.root.inputs.find((i) => i.reg === "X");
  if (!sourceInfo) throw new Error("STX should list X as source reg input");
  pass("S3: transfer TAX — STX lists X as source register input");
} catch (e) {
  fail("S3: transfer TAX — STX lists X as source register input", e.message);
}

// Scenario 4a: IRQ-bounded with followIrq=true — recursion crosses IRQ.
// STA $0200 at cycle 1600 (inside IRQ handler). Taint from cycle 1700, addr $0200.
// With followIrq=true, the IRQ boundary should NOT stop the walk.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 1700,
    startAddr: 0x0200,
    followIrq: true,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 1600) throw new Error(`root cycle ${g.root.cycle}, expected 1600`);
  // Should NOT have an irq_boundary node in the graph
  const irqNode = Object.values(g.nodes).find((n) => n.contribution === "irq_boundary");
  if (irqNode) throw new Error("irq_boundary node should not appear when followIrq=true");
  pass("S4a: followIrq=true — IRQ boundary not inserted");
} catch (e) {
  fail("S4a: followIrq=true — IRQ boundary not inserted", e.message);
}

// Scenario 4b: IRQ-bounded with followIrq=false — walk stops at IRQ.
// STA $0200 at cycle 1600; IRQ asserted at cycle 1500.
// With followIrq=false, should stop at irq_boundary node.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 1700,
    startAddr: 0x0200,
    followIrq: false,
    cycleWindow: 2000,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 1600) throw new Error(`root cycle ${g.root.cycle}, expected 1600`);
  // Should have an irq_boundary node
  const irqNode = Object.values(g.nodes).find((n) => n.contribution === "irq_boundary");
  if (!irqNode) throw new Error("irq_boundary node not found when followIrq=false");
  pass("S4b: followIrq=false — irq_boundary node inserted");
} catch (e) {
  fail("S4b: followIrq=false — irq_boundary node inserted", e.message);
}

// Scenario 5: Cross-domain IEC bridge — io_register_read for $DD0D.
// STA $0600 at cycle 1900 (value from $DD0D read).  Taint from 1950, addr $0600.
// With crossDomain=true, should see iec_bridge contribution.
// Note: the write at $0600 came from LDA $dd0d → STA $0600.
// The graph root = direct_write at $0600; then io_register_read or iec_bridge
// for the $DD0D address.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 1950,
    startAddr: 0x0600,
    crossDomain: true,
    driveRunId: "spec244-smoke",  // reuse same DB for drive sim
    cycleWindow: 2000,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 1900) throw new Error(`root cycle ${g.root.cycle}, expected 1900`);
  pass("S5: cross-domain bridge — taint from $DD0D-sourced write");
} catch (e) {
  fail("S5: cross-domain bridge — taint from $DD0D-sourced write", e.message);
}

// Scenario 6: 100-depth bound respected — truncated flag set when exceeded.
// Deep chain: 101 sequential INC $8000 at cycles 5000..5402 (RMW, each recurses into prior).
// With maxDepth=5, recursion stops at depth 5; truncated=true.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 5410,
    startAddr: 0x8000,
    maxDepth: 5,
    cycleWindow: 10000,
  });
  if (!g.root) throw new Error("no root");
  if (!g.truncated) throw new Error("truncated should be true when maxDepth=5 with 101-deep RMW chain");
  const nodeCount = Object.keys(g.nodes).length;
  // At depth 5, we should have at most 6 RMW nodes (depth 0..5) before truncation.
  if (nodeCount > 20) throw new Error(`too many nodes for maxDepth=5: ${nodeCount}`);
  pass("S6: depth bound — truncated flag set, node count bounded");
} catch (e) {
  fail("S6: depth bound — truncated flag set, node count bounded", e.message);
}

// Scenario 7: IO register read — $DC0D sourced write terminates with io_register_read.
// STA $0400 at cycle 1200; value came from LDA $dc0d (CIA ICR = $80).
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 1250,
    startAddr: 0x0400,
    cycleWindow: 1500,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 1200) throw new Error(`root cycle ${g.root.cycle}, expected 1200`);
  // The $0400 write itself is direct_write; the addr $0400 is not IO.
  // The root node should have A as a source reg input (STA uses A).
  const hasRegInput = g.root.inputs.some((i) => i.reg === "A");
  if (!hasRegInput) throw new Error("STA should list A as source reg input");
  pass("S7: IO register sourced — STA lists A as source reg");
} catch (e) {
  fail("S7: IO register sourced — STA lists A as source reg", e.message);
}

// Scenario 8: stack_push — PHA at cycle 1400 pushes A=$99 to $01fe.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 1450,
    startAddr: 0x01fe,
    cycleWindow: 1500,
  });
  if (!g.root) throw new Error("no root");
  if (g.root.cycle !== 1400) throw new Error(`root cycle ${g.root.cycle}, expected 1400`);
  if (g.root.contribution !== "stack_push") throw new Error(`contribution ${g.root.contribution}, expected stack_push`);
  pass("S8: stack_push — PHA writes classified as stack_push");
} catch (e) {
  fail("S8: stack_push — PHA writes classified as stack_push", e.message);
}

// Scenario 9: TaintGraph structure — nodes keyed by ID, edges reference valid IDs.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 950,
    startAddr: 0x0763,
  });
  for (const edge of g.edges) {
    if (!g.nodes[edge.from] && !Object.keys(g.nodes).includes(edge.from)) {
      throw new Error(`edge.from ${edge.from} not in nodes`);
    }
    if (!g.nodes[edge.to] && !Object.keys(g.nodes).includes(edge.to)) {
      throw new Error(`edge.to ${edge.to} not in nodes`);
    }
  }
  if (!("truncated" in g)) throw new Error("graph missing truncated field");
  if (!g.root) throw new Error("graph missing root");
  pass("S9: TaintGraph structure — all edge refs valid, required fields present");
} catch (e) {
  fail("S9: TaintGraph structure — all edge refs valid", e.message);
}

// Scenario 10: cycleWindow limits how far back the walk goes.
// Deep chain from 5000-5402. With cycleWindow=50, only 25ish cycles lookback.
try {
  const g = await traceTaint(backend, {
    runId: "spec244-smoke",
    startCycle: 5410,
    startAddr: 0x8000,
    maxDepth: 100,
    cycleWindow: 50,
  });
  // With only 50-cycle window, the walk will stop very quickly.
  const nodeCount = Object.keys(g.nodes).length;
  if (nodeCount > 30) throw new Error(`too many nodes for cycleWindow=50: ${nodeCount}`);
  pass("S10: cycleWindow limits backward reach");
} catch (e) {
  fail("S10: cycleWindow limits backward reach", e.message);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

await closeStore(store);

const totalPass = results.filter((r) => r.pass).length;
const totalFail = results.filter((r) => !r.pass).length;

console.log(`\nSpec 244 taint: ${totalPass}/${results.length} PASS${totalFail > 0 ? `, ${totalFail} FAIL` : ""}`);
if (totalFail > 0) {
  process.exit(1);
}
process.exit(0);
