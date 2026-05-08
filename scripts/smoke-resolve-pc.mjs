#!/usr/bin/env node
// Spec 235 smoke — Runtime evidence ↔ disassembly link (resolve-pc).
//
// Cases:
//  1. routine match — PC inside a RoutineAnnotation range
//  2. nearest label — PC resolves to closest LabelAnnotation ≤ PC
//  3. segment fallback — no annotations → segment from analysis report
//  4. source line match — PC maps to a line in _disasm.asm
//  5. batch resolve — resolvePcs() returns correct count with cache reuse
//  6. enrich integration — enrichEventRows() appends _resolved to cpu_step rows
//
// All cases must PASS for smoke to exit 0.

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolvePath(fileURLToPath(import.meta.url), "../..");
const distMcp = `${repoRoot}/dist/runtime/headless/v2`;

// ---- Load the compiled resolve-pc module -----------------------------------

let resolvePcMod;
try {
  // ESM module under dist/
  resolvePcMod = await import(`${distMcp}/resolve-pc.js`);
} catch (err) {
  console.error("FAIL: could not load resolve-pc module:", err.message);
  console.error("Hint: run 'npm run build:mcp' first");
  process.exit(1);
}

const { resolvePc, resolvePcs, enrichEventRows, invalidateArtifactCache } = resolvePcMod;

// ---- Synthetic project dir setup -------------------------------------------

const tmpDir = "/tmp/c64re-resolve-pc-smoke";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// Set project dir so loader reads our synthetic files
process.env["C64RE_PROJECT_DIR"] = tmpDir;

const artifactId = "test_prg";

// --- Synthetic annotations.json ---------------------------------------------
const annotations = {
  version: 1,
  binary: "test_prg.prg",
  segments: [
    { start: "0810", end: "083F", kind: "code" },
  ],
  labels: [
    { address: "0812", label: "main_loop" },
    { address: "0830", label: "sub_routine" },
  ],
  routines: [
    { address: "0812", name: "main_loop_routine", comment: "Main game loop" },
    { address: "0900", name: "irq_handler",        comment: "IRQ handler"   },
  ],
};
writeFileSync(`${tmpDir}/${artifactId}_annotations.json`, JSON.stringify(annotations), "utf8");

// --- Synthetic analysis.json ------------------------------------------------
const analysis = {
  binaryName: "test_prg",
  mapping: { startAddress: 0x0800, endAddress: 0x09FF },
  segments: [
    { kind: "code",    start: 0x0800, end: 0x08FF, score: { confidence: 0.95 } },
    { kind: "unknown", start: 0x0900, end: 0x09FF, score: { confidence: 0.50 } },
  ],
  entryPoints: [],
  symbols: [],
  analyzerResults: [],
  stats: {},
};
writeFileSync(`${tmpDir}/${artifactId}_analysis.json`, JSON.stringify(analysis), "utf8");

// --- Synthetic _disasm.asm --------------------------------------------------
const disasmAsm = [
  `; Disassembly of test_prg`,
  ``,
  `main_loop:                         ; $0812  entry point`,
  `      LDA $D012                    ; $0812  read raster`,
  `      BNE $0812                    ; $0814`,
  `sub_routine:                       ; $0830`,
  `      LDA #$00                     ; $0830`,
  `      RTS                          ; $0832`,
  ``,
].join("\n");
writeFileSync(`${tmpDir}/${artifactId}_disasm.asm`, disasmAsm, "utf8");

// Flush any cache from previous run (module is re-imported fresh, but just in case)
invalidateArtifactCache(artifactId);

// ---- Test harness ----------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

// ---- Case 1: Routine match -------------------------------------------------

console.log("\nCase 1: routine match — PC $0820 inside main_loop_routine ($0812..$08FF)");

const r1 = resolvePc(artifactId, 0x0820);
assert(r1.pc === 0x0820, `pc is $0820 (got $${r1.pc?.toString(16)})`);
assert(r1.routine !== undefined, "routine field present");
assert(r1.routine?.name === "main_loop_routine", `routine name is 'main_loop_routine' (got '${r1.routine?.name}')`);
assert(r1.routine?.entry === 0x0812, `routine entry is $0812 (got $${r1.routine?.entry?.toString(16)})`);
assert(r1.routine?.description === "Main game loop", `routine description present`);

// ---- Case 2: Nearest label -------------------------------------------------

console.log("\nCase 2: nearest label — PC $0835, nearest label ≤ PC is sub_routine at $0830");

const r2 = resolvePc(artifactId, 0x0835);
assert(r2.label !== undefined, "label field present");
assert(r2.label?.name === "sub_routine", `label name is 'sub_routine' (got '${r2.label?.name}')`);
assert(r2.label?.isExact === false, `isExact = false (got ${r2.label?.isExact})`);

// Also verify exact match case
const r2b = resolvePc(artifactId, 0x0830);
assert(r2b.label?.isExact === true, `isExact = true for exact address match`);

// ---- Case 3: Segment fallback (no annotation match) -------------------------

console.log("\nCase 3: segment fallback — PC $0808 in analysis code segment");

const r3 = resolvePc(artifactId, 0x0808);
assert(r3.segment !== undefined, "segment field present");
assert(r3.segment?.kind === "code", `segment kind is 'code' (got '${r3.segment?.kind}')`);
assert(r3.segment?.confidence >= 0.9, `confidence ≥ 0.9 (got ${r3.segment?.confidence})`);

// ---- Case 4: Source line match ---------------------------------------------

console.log("\nCase 4: source line match — PC $0812 → line in _disasm.asm");

const r4 = resolvePc(artifactId, 0x0812);
assert(r4.source !== undefined, "source field present");
assert(r4.source?.line > 0, `source line > 0 (got ${r4.source?.line})`);
assert(r4.source?.file?.endsWith("_disasm.asm"), `source file ends with _disasm.asm`);

// ---- Case 5: Batch resolve -------------------------------------------------

console.log("\nCase 5: batch resolve — resolvePcs() with 4 unique PCs");

invalidateArtifactCache(artifactId);
const pcs = [0x0812, 0x0820, 0x0830, 0x0835];
const batch = resolvePcs(artifactId, pcs);
assert(batch.length === 4, `batch length is 4 (got ${batch.length})`);
assert(batch[0]?.pc === 0x0812, `batch[0].pc === $0812`);
assert(batch[0]?.routine?.name === "main_loop_routine", `batch[0] routine resolved`);
assert(batch[2]?.label?.isExact === true, `batch[2] ($0830) isExact = true`);
assert(batch[3]?.label?.name === "sub_routine", `batch[3] ($0835) nearest label = sub_routine`);

// ---- Case 6: Enrich integration with event rows ----------------------------

console.log("\nCase 6: enrichEventRows — cpu_step rows get _resolved field");

const fakeRows = [
  { runId: "run1", family: "cpu_step", cycle: 100, pc: 0x0812, opcode: 0xAD, a: 0, x: 0, y: 0, sp: 0xFF, flags: 0 },
  { runId: "run1", family: "cpu_step", cycle: 110, pc: 0x0830, opcode: 0xA9, a: 0, x: 0, y: 0, sp: 0xFF, flags: 0 },
  { runId: "run1", family: "irq_assert", cycle: 200, source: "cia1" }, // no pc → no _resolved
];

invalidateArtifactCache(artifactId);
const enriched = enrichEventRows(fakeRows, artifactId);
assert(enriched.length === 3, `enriched length is 3 (got ${enriched.length})`);
assert(enriched[0]?._resolved !== undefined, "enriched[0] cpu_step has _resolved");
assert(enriched[0]?._resolved?.pc === 0x0812, `enriched[0]._resolved.pc === $0812`);
assert(enriched[0]?._resolved?.routine?.name === "main_loop_routine", "enriched[0] routine resolved");
assert(enriched[1]?._resolved?.label?.isExact === true, "enriched[1] ($0830) isExact = true");
assert(enriched[2]?._resolved === undefined, "irq_assert row has no _resolved");

// ---- Summary ---------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Spec 235 smoke: ${passed} PASS  ${failed} FAIL`);
if (failed > 0) {
  process.exit(1);
}
