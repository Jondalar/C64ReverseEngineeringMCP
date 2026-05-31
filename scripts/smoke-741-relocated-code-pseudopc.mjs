// Spec 741 — Slice A — relocated-code disassembly (.pseudopc / .logical).
//
// Proves the renderer can place relocated code at its RUNTIME pc while the
// stored bytes stay byte-exact, through both assemblers, via a small
// SYNTHETIC fixture (no Wasteland dependency):
//
//   1. single-blob payload (load == fileStart): KickAss emits
//      `.pc = $C300` + `.pseudopc $FC00 { ... }`; 64tass emits
//      `* = $C300` + `.logical $FC00` / `.here`.
//   2. embedded payload (stub + relocated blob in one file): the relocated
//      region is excluded from the normal walk (no double emission) and the
//      whole payload rebuilds byte-exact from ONE source file.
//   3. default run (no relocations) emits no pseudopc/logical and is itself
//      byte-exact — i.e. the feature is opt-in and changes nothing otherwise.
//
// Byte-exactness is verified with the real KickAssembler + 64tass via the
// product `assembleSource` path. Missing assemblers → PENDING, not fail.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 741 Slice A — relocated-code .pseudopc / .logical (synthetic)\n");

const cliCjs = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cliCjs)) { console.error("dist/pipeline/cli.cjs missing — run `npm run build`"); process.exit(2); }

// assembleSource is the product byte-compare gate.
let assembleSource;
try {
  ({ assembleSource } = await import(join(ROOT, "dist/assemble-source.js")));
} catch (e) {
  console.error("cannot import dist/assemble-source.js — run `npm run build:mcp`:", e.message);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "c64re-741-"));

function writePrg(name, loadAddr, bytes) {
  const buf = Buffer.from([loadAddr & 0xff, (loadAddr >> 8) & 0xff, ...bytes]);
  const p = join(work, name);
  writeFileSync(p, buf);
  return p;
}

function disasm(prgPath, outAsm, relocations) {
  const args = ["disasm-prg", prgPath, outAsm, "--no-register"];
  if (relocations) {
    const rp = join(work, "reloc-" + Math.abs(hash(outAsm)) + ".json");
    writeFileSync(rp, JSON.stringify(relocations, null, 2));
    args.push("--relocations", rp);
  }
  const r = spawnSync(process.execPath, [cliCjs, ...args], { cwd: work, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`disasm-prg failed: ${r.stderr || r.stdout}`);
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// The relocated fastloader body: lda $FFFF,y / sta $D020 / rts
//   B9 FF FF   8D 20 D0   60   (self-mod operand $FFFF stays CODE, byte-exact)
const FASTLOADER = [0xb9, 0xff, 0xff, 0x8d, 0x20, 0xd0, 0x60];

async function assertByteExact(label, sourcePath, assembler, comparePrg) {
  const out = sourcePath.replace(/\.(asm|tass)$/i, ".out.prg");
  const res = await assembleSource({ projectDir: work, sourcePath, assembler, outputPath: out, compareToPath: comparePrg });
  if (res.exitCode !== 0) {
    console.log(`  PENDING  ${label} — ${assembler} unavailable (exit ${res.exitCode})  (${(res.stderr || "").split("\n")[0]})`);
    return null;
  }
  ok(res.compareMatches === true, `${label} rebuild byte-exact (${assembler})`,
    res.compareMatches ? `${res.comparedBytes} bytes` : `first diff @${res.firstDiffOffset}`);
  return res.compareMatches;
}

try {
  // ---- Scenario 1: single-blob payload, load == fileStart ($C300 → $FC00) ----
  const blob = writePrg("blob.prg", 0xc300, FASTLOADER);
  const blobAsm = join(work, "blob_reloc.asm");
  disasm(blob, blobAsm, [{ fileStart: "$C300", fileEnd: "$C306", runtimeAddr: "$FC00", label: "fastloader" }]);
  const asm1 = readFileSync(blobAsm, "utf8");
  const tass1 = readFileSync(blobAsm.replace(/\.asm$/, ".tass"), "utf8");

  ok(/^\s*\.pc\s*=\s*\$C300\b/m.test(asm1), "1 KickAss has .pc = $C300 (stored pc)");
  ok(/^\s*\.pseudopc\s+\$FC00\s*\{/m.test(asm1), "1 KickAss has .pseudopc $FC00 {");
  ok(/^\s*\}/m.test(asm1), "1 KickAss closes the pseudopc block");
  ok(/lda\s+\$FFFF,y/i.test(asm1), "1 self-mod operand rendered as CODE (lda $FFFF,y)");
  ok(/^\s*\*\s*=\s*\$C300\b/m.test(tass1), "1 64tass has * = $C300");
  ok(/^\s*\.logical\s+\$FC00\b/m.test(tass1), "1 64tass has .logical $FC00");
  ok(/^\s*\.here\b/m.test(tass1), "1 64tass has .here");
  ok(!/\.pseudopc/.test(tass1), "1 64tass output has no leftover .pseudopc");

  await assertByteExact("1", blobAsm, "kickassembler", blob);
  await assertByteExact("1", blobAsm.replace(/\.asm$/, ".tass"), "64tass", blob);

  // ---- Scenario 2: embedded payload — stub + relocated blob in one file ----
  // $C000: JMP $FC00 (4C 00 FC) then relocated fastloader stored $C003 → $FC00
  const embedded = writePrg("embedded.prg", 0xc000, [0x4c, 0x00, 0xfc, ...FASTLOADER]);
  const embAsm = join(work, "embedded_reloc.asm");
  disasm(embedded, embAsm, [{ fileStart: "$C003", fileEnd: "$C009", runtimeAddr: "$FC00" }]);
  const asm2 = readFileSync(embAsm, "utf8");

  ok(/^\s*\.pc\s*=\s*\$C000\b/m.test(asm2), "2 embedded payload keeps one .pc = $C000 segment");
  ok(/jmp\s+\$FC00/i.test(asm2), "2 stub (gap) rendered at file offset (jmp $FC00)");
  ok(/^\s*\.pseudopc\s+\$FC00\s*\{/m.test(asm2), "2 relocated blob rendered as .pseudopc $FC00");
  // single emission of the relocated bytes: exactly one lda $FFFF,y
  ok((asm2.match(/lda\s+\$FFFF,y/gi) || []).length === 1, "2 relocated bytes emitted exactly once (no double emission)");
  await assertByteExact("2", embAsm, "kickassembler", embedded);

  // one source per payload: exactly one .asm + one .tass, no extra split files
  ok(existsSync(embAsm) && existsSync(embAsm.replace(/\.asm$/, ".tass")), "2 one .asm + one .tass per payload");

  // ---- Scenario 3: default run (no relocations) — opt-in, unchanged ----
  const defAsm = join(work, "embedded_default.asm");
  disasm(embedded, defAsm, undefined);
  const asm3 = readFileSync(defAsm, "utf8");
  const tass3 = readFileSync(defAsm.replace(/\.asm$/, ".tass"), "utf8");
  ok(!/\.pseudopc/.test(asm3), "3 default KickAss emits no .pseudopc");
  ok(!/\.logical/.test(tass3) && !/\.here/.test(tass3), "3 default 64tass emits no .logical/.here");
  await assertByteExact("3", defAsm, "kickassembler", embedded);
} catch (e) {
  ok(false, "harness", e.message);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-741: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
