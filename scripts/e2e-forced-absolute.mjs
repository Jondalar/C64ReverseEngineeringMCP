// Forced-absolute rendering: an abs instruction with a zeropage operand (STA $0074 =
// 8D 74 00) must render as readable `sta.abs $0074` (KickAss) / `sta @w $0074` (64tass)
// and rebuild BYTE-IDENTICAL — not shrink to the 2-byte ZP form (85 74) that shifted
// every following label (the segment-override bug). Run after `npm run build`.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "./lib/neutral-tmp.mjs";
const require = createRequire(import.meta.url);
const { disassemblePrg } = require("../dist/pipeline/lib/prg-disasm.cjs");
const { L, emitListing } = require("../dist/pipeline/lib/listing.cjs");

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

console.log("forced-absolute — abs-with-zeropage-operand stays 3-byte + readable\n");

const dir = testTmpDir("fabs-");
try {
  // PRG @ $C000: STA $0074 (abs, 8D 74 00) + RTS (60). Header = load addr little-endian.
  const prg = Uint8Array.from([0x00, 0xc0, 0x8d, 0x74, 0x00, 0x60]);
  const prgPath = join(dir, "t.prg");
  const asmPath = join(dir, "t.asm");
  const tassPath = join(dir, "t.tas");
  writeFileSync(prgPath, prg);

  // Real pipeline disasm, no analysis → renderLegacy (the path the segment override hit).
  // One render writes one listing (Spec 914): the same bytes are rendered once per dialect.
  disassemblePrg(prgPath, asmPath, { entryPoints: ["c000"], dialect: "kickass" });
  disassemblePrg(prgPath, tassPath, { entryPoints: ["c000"], dialect: "64tass" });
  const asm = readFileSync(asmPath, "utf8");

  ok(/\bsta\.abs\s+\$0074\b/.test(asm), "KickAss: renders `sta.abs $0074` (forced absolute)", (asm.match(/.*sta.*/i) ?? [""])[0].trim());
  ok(!/\bsta\s+\$0074\b/.test(asm.replace(/sta\.abs/g, "")), "KickAss: does NOT emit the shrinkable plain `sta $0074`");
  ok(!/\.byte\s+\$8[dD],\s*\$74/.test(asm), "KickAss: no `.byte $8D,$74,..` blob (readable, not raw)");

  const tass = readFileSync(tassPath, "utf8");
  ok(/\bsta\s+@w\s+\$0074\b/.test(tass), "64tass: the forced-absolute line is written `sta @w $0074`", (tass.match(/.*sta.*/i) ?? [""])[0].trim());
  ok(!/\.abs\b/.test(tass.replace(/;.*$/gm, "")), "64tass: no KickAssembler `.abs` suffix survives in the code");
  // A comment mentioning .abs is a comment, never rewritten: it is data of a line, not text to pattern-match.
  ok(emitListing([L.comment("note about sta.abs trick")], "64tass").includes("sta.abs"), "an emitted comment keeps `.abs` as written");

  // Real 64tass round-trip: assemble the tass, the STA must rebuild to 8D 74 00.
  if (existsSync("/opt/homebrew/bin/64tass")) {
    const binPath = join(dir, "t.bin");
    execFileSync("/opt/homebrew/bin/64tass", ["--nostart", "-o", binPath, tassPath], { stdio: "pipe" });
    const rebuilt = readFileSync(binPath);
    // Original payload (after the 2-byte load header) = 8D 74 00 60.
    ok(rebuilt[0] === 0x8d && rebuilt[1] === 0x74 && rebuilt[2] === 0x00 && rebuilt[3] === 0x60,
      "64tass rebuild BYTE-IDENTICAL (8D 74 00 60, not 85 74 ..)", [...rebuilt].map((b) => b.toString(16).padStart(2, "0")).join(" "));
  } else {
    console.log("  SKIP  64tass round-trip (binary absent)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  forced-absolute: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
