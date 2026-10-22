#!/usr/bin/env node
// Issue #118 — 64tass is handed paths of 260+ characters it can open. On Windows a path of
// 260 characters or more (MAX_PATH) fails in 64tass unless it carries the \\?\ prefix:
// "fatal error: can't open file '<...>.tas': No such file or directory", and the rebuild
// proof then calls every such listing "diverged". The source (input), -o (output) and
// -l (VICE labels) paths all need it. Off Windows the paths go through unchanged.
//   1  a source, output and label file of 260+ characters assemble byte-identical
//   2  a short path still assembles byte-identical (the prefix is only added when needed)
// Skips loudly when no 64tass is found (set C64RE_64TASS_BIN).
//   npm run build && node scripts/e2e-issue118-64tass-long-path.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { find64tassBinary, assembleSource } = await import(pathToFileURL(join(ROOT, "dist/assemble-source.js")).href);

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

if (!find64tassBinary()) {
  console.log("SKIP  all: 64tass not found (set C64RE_64TASS_BIN) — NOT counted as a pass");
  process.exit(0);
}

const SOURCE = "* = $1000\nstart   lda #$01\n        rts\n";
const BYTES = Buffer.from([0x00, 0x10, 0xa9, 0x01, 0x60]);
const base = testTmpDir("c64re-longpath-");
try {
  const assemble = async (label, dir) => {
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "bank_01_8000.bin_disasm.tas");
    const out = join(dir, "bank_01_8000.bin_disasm_rebuild_check.prg");
    const want = join(base, "want.prg");
    writeFileSync(src, SOURCE);
    writeFileSync(want, BYTES);
    const r = await assembleSource({ projectDir: base, sourcePath: src, assembler: "64tass", outputPath: out, compareToPath: want, symbols: true });
    const lens = `source ${src.length}, output ${out.length}, labels ${r.symbolsPath?.length ?? "-"} chars`;
    check(`${label}: assembles byte-identical`, r.exitCode === 0 && r.compareMatches === true,
      r.exitCode === 0 ? `${lens}; ${r.comparedBytes} bytes` : `${lens}; ${(r.stderr || "").trim().split("\n")[0]}`);
    check(`${label}: the label file is written`, r.exitCode === 0 && r.symbolsPath !== undefined && existsSync(r.symbolsPath), lens);
  };

  console.log("[1] paths of 260+ characters");
  let deep = base;
  while (deep.length < 230) deep = join(deep, "payload_griffinsoft_crt_chip_8000");
  await assemble("long", deep);

  console.log("\n[2] a short path");
  await assemble("short", join(base, "s"));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${failures ? "RED" : "GREEN"}: ${failures} failed`);
process.exit(failures ? 1 : 0);
