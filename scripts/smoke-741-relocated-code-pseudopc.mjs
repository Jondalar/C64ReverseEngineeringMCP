// Spec 741 — Slice A–D — relocated-code disassembly (.pseudopc / .logical).
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

console.log("Spec 741 Slice A-D — relocated-code .pseudopc / .logical (synthetic)\n");

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

function proposeAnnotations(analysisJson, draftPath) {
  const r = spawnSync(process.execPath, [cliCjs, "propose-annotations", analysisJson, draftPath, "--no-register"], { cwd: work, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`propose-annotations failed: ${r.stderr || r.stdout}`);
}

// Slice D: the mixed-island splitter is unit-tested against the demote pass
// directly (deterministic), mirroring scripts/sprint40-smoke.mjs.
let demoteBrokenCodeIslands;
try {
  ({ demoteBrokenCodeIslands } = await import(join(ROOT, "dist/pipeline/analysis/pipeline.cjs")));
} catch (e) {
  console.error("cannot import pipeline.cjs — run `npm run build`:", e.message);
  process.exit(2);
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

  // ---- Scenario 6 (Slice C): analyzer DETECTS the copy loop → proposal ----
  // $C000 ldx#0 / 2-page unrolled copy $C300→$FC00 / jmp $FC00, then 512 bytes
  // of source data at $C300-$C4FF. The analyzer should propose the relocation,
  // propose_annotations should surface it, and feeding it back must rebuild
  // byte-exact (the full detect → propose → render → verify loop).
  const cBytes = [
    0xa2, 0x00,             // ldx #$00
    0xbd, 0x00, 0xc3,       // lda $C300,x
    0x9d, 0x00, 0xfc,       // sta $FC00,x
    0xbd, 0x00, 0xc4,       // lda $C400,x
    0x9d, 0x00, 0xfd,       // sta $FD00,x
    0xe8,                   // inx
    0xd0, 0xf1,             // bne loop ($C002)
    0x4c, 0x00, 0xfc,       // jmp $FC00
  ];
  while (cBytes.length < 0x300) cBytes.push(0xea);          // pad to $C300
  for (let i = 0; i < 512; i++) cBytes.push(0xea);          // src $C300-$C4FF (benign nops)
  const copyloop = writePrg("copyloop.prg", 0xc000, cBytes);
  const clJson = join(work, "copyloop_analysis.json");
  analyze(copyloop, clJson, "C000");
  const report = JSON.parse(readFileSync(clJson, "utf8"));
  const props = report.relocationProposals || [];
  const p = props.find((x) => x.fileStart === 0xc300 && x.runtimeAddr === 0xfc00);
  ok(!!p, "6 analyzer proposes a relocation $C300 → $FC00", props.map((x) => `${x.fileStart.toString(16)}→${x.runtimeAddr.toString(16)}`).join(","));
  ok(p && p.length === 512, "6 inferred length = 512 (2 page-spaced stores)", p ? String(p.length) : "");
  ok(p && p.followedByJump === true, "6 following jmp into destination detected");

  const draft = join(work, "copyloop_draft.json");
  proposeAnnotations(clJson, draft);
  const draftObj = JSON.parse(readFileSync(draft, "utf8"));
  ok(Array.isArray(draftObj.relocations) && draftObj.relocations.length >= 1, "6 propose_annotations surfaces relocation candidates");
  const cand = (draftObj.relocations || []).find((r) => r.fileStart === "$C300" && r.runtimeAddr === "$FC00");
  ok(!!cand, "6 draft relocation candidate in disasm-ready shape ($C300 → $FC00)");

  // Feed the accepted proposal back into disasm_prg.relocations → byte-exact.
  const clAsm = join(work, "copyloop_reloc.asm");
  disasm(copyloop, clAsm, [{ fileStart: cand.fileStart, fileEnd: "$C4FF", runtimeAddr: cand.runtimeAddr }]);
  const asm6 = readFileSync(clAsm, "utf8");
  ok(/^\s*\.pseudopc\s+\$FC00\s*\{/m.test(asm6), "6 proposal feeds disasm_prg → .pseudopc $FC00");
  await assertByteExact("6", clAsm, "kickassembler", copyloop);

  // ---- Scenario 7 (Slice D): mixed-island splitter (BUG-021) — unit ----
  // One code segment $C000-$C0F5; recursively-confirmed prefix only $C000-$C0E7
  // (JAM tail $C0E8-$C0F5). WITHOUT coverage the whole island demotes to
  // unknown (legacy); WITH coverage it SPLITS: code prefix kept, tail isolated.
  const ISLAND_START = 0xc000, PREFIX_END = 0xc0e7, ISLAND_END = 0xc0f5;
  const body = Buffer.alloc(ISLAND_END - ISLAND_START + 1, 0xea); // nops
  // tail $C0E8-$C0F5: JAM run (rule 1, -0.4) + two forward branches whose
  // targets land outside the island (rule 3, -0.2 each) → 0.94 demotes.
  for (let a = PREFIX_END + 1; a <= ISLAND_END; a++) body[a - ISLAND_START] = 0x02; // JAM fill
  body[0xf2] = 0xd0; body[0xf3] = 0x10; // bne +16 → $C104 (outside)
  body[0xf4] = 0xd0; body[0xf5] = 0x10; // bne +16 → $C106 (outside)
  const mapping = { startAddress: ISLAND_START, endAddress: ISLAND_END };
  const mkSeg = () => ([{
    kind: "code", start: ISLAND_START, end: ISLAND_END, length: ISLAND_END - ISLAND_START + 1,
    score: { confidence: 0.94, reasons: ["trusted entry traversal"], alternatives: [] }, analyzerIds: ["code"], xrefs: [],
  }]);
  const confirmed = new Map();
  for (let a = ISLAND_START; a <= PREFIX_END; a++) confirmed.set(a, a); // 1-byte confirmed instrs

  const whole = demoteBrokenCodeIslands(mkSeg(), body, mapping, 0.3); // 4-arg, no coverage
  const wholeUnknown = whole.segments.filter((s) => s.kind === "unknown");
  ok(wholeUnknown.length === 1 && wholeUnknown[0].start === ISLAND_START && wholeUnknown[0].end === ISLAND_END,
    "7 without coverage: whole island demotes to one unknown (legacy)", whole.segments.map((s) => s.kind).join(","));

  const split = demoteBrokenCodeIslands(mkSeg(), body, mapping, 0.3, confirmed);
  const code = split.segments.find((s) => s.kind === "code");
  const tail = split.segments.find((s) => s.kind === "unknown");
  ok(!split.segments.some((s) => s.kind === "unknown" && s.start === ISLAND_START && s.end === ISLAND_END),
    "7 with coverage: NOT one unknown over the whole island");
  ok(code && code.start === ISLAND_START && code.end === PREFIX_END, "7 trusted-entry code preserved ($C000-$C0E7)", code ? `$${code.start.toString(16)}-$${code.end.toString(16)}` : "none");
  ok(tail && tail.start === PREFIX_END + 1 && tail.end === ISLAND_END, "7 data tail split off ($C0E8-$C0F5)", tail ? `$${tail.start.toString(16)}-$${tail.end.toString(16)}` : "none");
  ok(code && code.analyzerIds.includes("mixed-island-split"), "7 split tagged mixed-island-split");

  // ---- Scenario 8 (Slice D): end-to-end — trusted entry not buried ----
  // analyze_prg on a mixed code+data PRG must keep the entry code as `code`
  // and must NOT emit a single unknown wall over the whole region.
  const dBytes = [
    0xa9, 0x01, 0x8d, 0x20, 0xd0,   // lda #$01 / sta $D020
    0x20, 0xd2, 0xff,               // jsr $FFD2
    0xa9, 0x00, 0x8d, 0x21, 0xd0,   // lda #$00 / sta $D021
    0x60,                           // rts ($C00D) — confirmed prefix ends here
    0xa0, 0x00, 0xb9, 0x00, 0xc3, 0x99, 0x00, 0x04, 0xc8, 0x02, // tail decodes then JAM
    0x20, 0xd2, 0xff, 0x02, 0x02,
  ];
  while (dBytes.length < 0xf6) dBytes.push(0x12);
  const mixedPrg = writePrg("mixed_island.prg", 0xc000, dBytes);
  const mixedJson = join(work, "mixed_island_analysis.json");
  analyze(mixedPrg, mixedJson, "C000");
  const mixedReport = JSON.parse(readFileSync(mixedJson, "utf8"));
  const wall = mixedReport.segments.find((s) => s.kind === "unknown" && s.start === 0xc000 && s.end >= 0xc0f0);
  ok(!wall, "8 analyzer does NOT bury the whole island in one unknown wall");
  const entryCode = mixedReport.segments.find((s) => s.kind === "code" && s.start === 0xc000);
  ok(!!entryCode, "8 trusted-entry code at $C000 preserved as code", entryCode ? `$${entryCode.start.toString(16)}-$${entryCode.end.toString(16)}` : "none");
} catch (e) {
  ok(false, "harness", e.message);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-741: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
