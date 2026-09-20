#!/usr/bin/env node
// Spec 861 §3.1 — the cycle table exists twice, and may never differ.
//
// `src/` is ESM, `pipeline/src/` is CommonJS, and the two cannot import each
// other. The opcode table already lives twice for that reason
// (`src/monitor/disasm6502.ts` says so in its header) with nothing watching the
// copy. The cycle table is the same shape of problem and gets the gate the
// opcode table never had: the grid literal is read out of both files and
// compared cell by cell, and the parsed result is checked against the decoder's
// own opcode table — every JAM has no cycles, nothing else is missing a cell.
//
// Hermetic: it reads two source files. No build, no ROM, no runtime.
//
//   node scripts/check-cycle-table.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const fails = [];
const notes = [];

const PIPELINE = "pipeline/src/lib/mos6502.ts";
const ESM = "src/cost/cycles.ts";

function grid(relPath) {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const m = /export const CYCLE_GRID = `([^`]*)`/u.exec(src);
  if (!m) {
    fails.push(`${relPath} has no \`export const CYCLE_GRID = \`…\`\` literal`);
    return null;
  }
  return m[1];
}

const a = grid(PIPELINE);
const b = grid(ESM);

if (a !== null && b !== null) {
  if (a === b) {
    notes.push(`the grid is character-identical in ${PIPELINE} and ${ESM}`);
  } else {
    const rowsA = a.trim().split("\n").map((r) => r.trim());
    const rowsB = b.trim().split("\n").map((r) => r.trim());
    const n = Math.max(rowsA.length, rowsB.length);
    for (let i = 0; i < n; i += 1) {
      if (rowsA[i] !== rowsB[i]) {
        fails.push(`row ${i} differs:\n      ${PIPELINE}: ${rowsA[i] ?? "(missing)"}\n      ${ESM}: ${rowsB[i] ?? "(missing)"}`);
      }
    }
    if (fails.length === 0) fails.push(`the two grids differ in whitespace only — they must be character-identical`);
  }
}

// The parse, and the cross-check against the decoder's own opcode table.
if (a !== null) {
  const cells = a.trim().split(/\s+/u);
  if (cells.length !== 256) fails.push(`the grid has ${cells.length} cells, not 256`);

  const decoder = readFileSync(join(ROOT, PIPELINE), "utf8");
  const jams = new Set();
  for (const m of decoder.matchAll(/\[0x([0-9a-f]{2}), \{ mnemonic: "([a-z]+)"/gu)) {
    if (m[2] === "jam") jams.add(parseInt(m[1], 16));
  }
  if (jams.size !== 12) notes.push(`the decoder lists ${jams.size} JAM opcodes (expected 12)`);

  let branches = 0;
  let crossers = 0;
  for (let op = 0; op < cells.length; op += 1) {
    const cell = cells[op];
    const hex = `$${op.toString(16).padStart(2, "0").toUpperCase()}`;
    if (cell === "-") {
      if (!jams.has(op)) fails.push(`${hex} has no cycle count but the decoder does not call it a JAM`);
      continue;
    }
    if (jams.has(op)) fails.push(`${hex} is a JAM in the decoder but the grid gives it ${cell} cycles`);
    const m = /^(\d+)([*^]?)$/u.exec(cell);
    if (!m) { fails.push(`${hex}: "${cell}" is not a cycle cell (3, 4*, 2^ or -)`); continue; }
    const base = Number(m[1]);
    if (base < 2 || base > 8) fails.push(`${hex}: ${base} cycles is outside 2..8`);
    if (m[2] === "^") branches += 1;
    if (m[2] === "*") crossers += 1;
  }
  // Eight branches, and exactly the eight the decoder calls relative.
  const rel = new Set();
  for (const m of decoder.matchAll(/\[0x([0-9a-f]{2}), \{ mnemonic: "[a-z]+", mode: "rel"/gu)) rel.add(parseInt(m[1], 16));
  if (branches !== 8 || rel.size !== 8) fails.push(`${branches} branch cells against ${rel.size} relative opcodes in the decoder`);
  for (const op of rel) {
    if (cells[op]?.endsWith("^")) continue;
    fails.push(`$${op.toString(16).padStart(2, "0").toUpperCase()} is relative in the decoder but not marked \`^\` in the grid`);
  }
  notes.push(`256 cells: ${jams.size} JAM, ${branches} branch, ${crossers} paying the indexed-read page penalty`);
}

for (const n of notes) console.log(`  ${n}`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) {
  console.log(`\nRED  cycle-table: ${fails.length} fail.`);
  process.exit(1);
}
console.log(`\nGREEN  cycle-table: the two copies agree and every cell matches the decoder.`);
