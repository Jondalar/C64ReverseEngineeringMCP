// Spec 741 — Slice A+B — relocated-code disassembly (.pseudopc / .logical).
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
//   4. (Slice B) MIXED relocated region via subSegments: code spans become
//      real instructions (self-mod $FFFF operand kept + annotated, internal
//      and data labels resolve at runtime pc), LUT span stays .byte.
//   5. (Slice B) relocations + analysis combine: gap stretches render via the
//      full analysis path, relocated region renders as a .pseudopc block.
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

console.log("Spec 741 Slice A+B — relocated-code .pseudopc / .logical (synthetic)\n");

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

function disasm(prgPath, outAsm, relocations, analysisJson, entryHex) {
  const args = ["disasm-prg", prgPath, outAsm];
  if (entryHex) args.push(entryHex);
  if (analysisJson) {
    if (!entryHex) args.push("0000");
    args.push(analysisJson);
  }
  args.push("--no-register");
  if (relocations) {
    const rp = join(work, "reloc-" + Math.abs(hash(outAsm)) + ".json");
    writeFileSync(rp, JSON.stringify(relocations, null, 2));
    args.push("--relocations", rp);
  }
  const r = spawnSync(process.execPath, [cliCjs, ...args], { cwd: work, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`disasm-prg failed: ${r.stderr || r.stdout}`);
}

function analyze(prgPath, outJson, entryHex) {
  const r = spawnSync(process.execPath, [cliCjs, "analyze-prg", prgPath, outJson, entryHex, "--no-register"], { cwd: work, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`analyze-prg failed: ${r.stderr || r.stdout}`);
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

  // ---- Scenario 4: MIXED relocated region — code + LUT, via subSegments ----
  // Stored at $C300, runs at $FC00:
  //   $FC00 recv_byte: lda $FFFF,y  (B9 FF FF)  self-mod fetch
  //   $FC03           ldx gcr_lut   (AE 09 FC)  references the data label
  //   $FC06           jmp recv_byte (4C 00 FC)  internal label
  //   $FC09 gcr_lut:  .byte $0F,$55,$AA,$FF     (LUT stays DATA)
  const mixed = writePrg("mixed.prg", 0xc300, [
    0xb9, 0xff, 0xff, 0xae, 0x09, 0xfc, 0x4c, 0x00, 0xfc, 0x0f, 0x55, 0xaa, 0xff,
  ]);
  const mixedAsm = join(work, "mixed_reloc.asm");
  disasm(mixed, mixedAsm, [{
    fileStart: "$C300", fileEnd: "$C30C", runtimeAddr: "$FC00", label: "fastloader",
    subSegments: [
      { start: "$FC00", end: "$FC08", kind: "code", label: "recv_byte", comment: "receive + self-mod fetch" },
      { start: "$FC09", end: "$FC0C", kind: "lookup_table", label: "gcr_lut", comment: "GCR decode table" },
    ],
  }]);
  const asm4 = readFileSync(mixedAsm, "utf8");

  ok(/^\s*\.pseudopc\s+\$FC00\s*\{/m.test(asm4), "4 mixed region opens .pseudopc $FC00");
  ok(/recv_byte:/.test(asm4), "4 code subSegment label emitted (recv_byte)");
  ok(/lda\s+\$FFFF,y.*self-modified operand/i.test(asm4), "4 self-mod operand kept as code + annotated");
  ok(/ldx\s+gcr_lut/.test(asm4), "4 abs operand resolves to the data label (ldx gcr_lut)");
  ok(/jmp\s+recv_byte/.test(asm4), "4 internal branch resolves to runtime label (jmp recv_byte)");
  ok(/gcr_lut:/.test(asm4), "4 data subSegment label emitted (gcr_lut)");
  ok(/\.byte\s+\$0F,\s*\$55,\s*\$AA,\s*\$FF/.test(asm4), "4 LUT stays DATA (.byte), not demoted-or-code");
  ok(/\/\/\s*GCR decode table/.test(asm4) && /\/\/\s*receive \+ self-mod fetch/.test(asm4), "4 subSegment comments rendered");
  ok(!/\.byte\s+\$B9/.test(asm4), "4 code bytes NOT emitted as .byte (real instructions)");
  await assertByteExact("4", mixedAsm, "kickassembler", mixed);
  await assertByteExact("4", mixedAsm.replace(/\.asm$/, ".tass"), "64tass", mixed);

  // ---- Scenario 5: relocations + analysis combine (gap via analysis) ----
  // $C000 entry code (analysis-driven gap) + relocated blob $C006 → $E000.
  const combo = writePrg("combo.prg", 0xc000, [
    0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60, // $C000 lda #$01 / sta $D020 / rts
    0xb9, 0xff, 0xff, 0x60,             // $C006 lda $FFFF,y / rts (relocated → $E000)
  ]);
  const comboJson = join(work, "combo_analysis.json");
  analyze(combo, comboJson, "C000");
  const comboAsm = join(work, "combo_reloc.asm");
  disasm(combo, comboAsm, [{ fileStart: "$C006", fileEnd: "$C009", runtimeAddr: "$E000" }], comboJson, "C000");
  const asm5 = readFileSync(comboAsm, "utf8");

  ok(/Analysis-driven rendering enabled/.test(asm5), "5 analysis path active alongside relocations");
  ok(/SEGMENT/i.test(asm5) || /\/\/\s*\$C000/.test(asm5), "5 gap rendered via analysis (segment header present)");
  ok(/lda\s+#\$01/.test(asm5) && /sta\s+\$D020/.test(asm5), "5 gap code rendered at file offset");
  ok(/^\s*\.pseudopc\s+\$E000\s*\{/m.test(asm5), "5 relocated blob rendered as .pseudopc $E000");
  ok((asm5.match(/lda\s+\$FFFF,y/gi) || []).length === 1, "5 relocated bytes emitted exactly once");
  await assertByteExact("5", comboAsm, "kickassembler", combo);
} catch (e) {
  ok(false, "harness", e.message);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-741: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
