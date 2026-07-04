// Substrate fix — the disk read layer is DUMB + medium-agnostic: GCR → raw blocks
// by (track,sector), CRC is a don't-care (a 1541-DOS integrity artifact, irrelevant
// to extraction). DOS (BAM/directory) is ONE fail-soft resolver, not the base.
// THE point: a standard-DOS disk still extracts (no regression) AND a non-DOS /
// custom-GCR disk no longer crashes at the read — its plaintext blocks come through.
// Run after build:mcp. Skips gracefully when a sample is absent (CI has neither).
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { G64Parser } from "../dist/disk/index.js";
import { SECTORS_PER_TRACK } from "../dist/disk/base.js";

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${m}${d ? `  (${d})` : ""}`); };

console.log("dumb-read — CRC-agnostic block read + fail-soft DOS resolver\n");

// REGRESSION: a standard DOS disk still parses + extracts (must NOT break).
const STD = resolve("samples/motm.g64");
if (existsSync(STD)) {
  const p = new G64Parser(new Uint8Array(readFileSync(STD)));
  ok(p.getDirectory().files.length > 0, "standard motm.g64: DOS directory still reads files", `${p.getDirectory().files.length}`);
  ok(p.getSector(18, 0) != null, "standard motm.g64: BAM sector 18/0 reads");
} else console.log(`  (skip standard: ${STD} absent)`);

// FIX: a non-DOS / custom-GCR disk does not crash + yields its plaintext blocks.
const PAWN = "/Users/alex/Development/C64/Cracking/The Pawn/inputs/disk/the_pawn_s1.g64";
if (existsSync(PAWN)) {
  const p = new G64Parser(new Uint8Array(readFileSync(PAWN)));
  let threw = false;
  try { p.getDirectory(); } catch { threw = true; }
  ok(!threw, "non-DOS Pawn s1: getDirectory() does NOT throw (fail-soft DOS resolver)");
  let readable = 0, total = 0;
  for (let t = 1; t <= 35; t++) for (let s = 0; s < SECTORS_PER_TRACK[t]; s++) { total++; if (p.getSector(t, s) != null) readable++; }
  ok(readable > 0, "non-DOS Pawn s1: getSector returns bytes despite custom data-CRC (dumb read)", `${readable}/${total}`);
} else console.log(`  (skip non-DOS Pawn: absent)`);

console.log(`\n${fail === 0 ? "GREEN" : "RED"} dumb-read: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
