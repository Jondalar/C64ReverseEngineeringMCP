#!/usr/bin/env node
// Walk dad sector chain in motm.g64 via HL static GCR decoder.
// Verify each next-T/S link byte is valid. If chain breaks with
// invalid link, GCR decode bug pinpointed.

import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = resolve(import.meta.dirname, "..");
const { G64Parser } = await import(`${repoRoot}/dist/disk/g64-parser.js`);

const g64 = new G64Parser(readFileSync(resolve(repoRoot, "samples/motm.g64")));

const SECTORS_PER_TRACK = [
  0,                                                       // 0 unused
  21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,    // 1..17
  19,19,19,19,19,19,19,                                    // 18..24
  18,18,18,18,18,18,                                       // 25..30
  17,17,17,17,17,                                          // 31..35
];

function maxSector(t) { return SECTORS_PER_TRACK[t] ?? 0; }

function readSector(t, s) {
  try { return g64.getSector(t, s); }
  catch (e) { return null; }
}

let track = 17, sector = 4;
const chain = [];
const seen = new Set();

for (let step = 0; step < 100; step++) {
  const key = `${track}/${sector}`;
  if (seen.has(key)) {
    console.log(`step ${step}: LOOP detected at T${track}/S${sector}`);
    break;
  }
  seen.add(key);

  const max = maxSector(track);
  const valid = sector >= 0 && sector < max && track >= 1 && track <= 35;
  const data = valid ? readSector(track, sector) : null;

  if (!data) {
    console.log(`step ${step}: T${track}/S${sector} — INVALID/UNREADABLE (max sector for T${track}=${max})`);
    chain.push({ step, track, sector, valid: false, nextT: null, nextS: null });
    break;
  }

  const nextT = data[0];
  const nextS = data[1];
  const isLast = nextT === 0;
  chain.push({ step, track, sector, nextT, nextS, isLast, bytesUsed: isLast ? nextS : 254 });
  console.log(`step ${step}: T${track}/S${sector} → next T${nextT}/S${nextS}${isLast ? " (LAST)" : ""}`);
  if (isLast) break;
  track = nextT;
  sector = nextS;
}

console.log(`\nChain length: ${chain.length} sectors`);
console.log(`Total bytes: ${chain.reduce((a, c) => a + (c.bytesUsed ?? 254), 0)}`);
