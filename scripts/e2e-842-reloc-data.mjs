#!/usr/bin/env node
// Spec 842 — two addresses for one byte (issue #20).
//
// A self-relocating loader is STORED at one address and RUNS at another, and an
// annotated data island inside it has to render as `.byte` INSIDE the relocated
// block, in runtime space, with the code around it staying aligned.
//
// Before this spec it did not compose: the island took the file path,
// `subtractRelocations` clipped it away, an empty directive was emitted outside the
// block, and the same bytes were decoded a second time as code inside it.
//
// Synthetic on purpose — the reporter's shape, not his file. A gate that needs
// someone's project is a gate that runs once.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:842-reloc-data
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliCjs = join(here, "..", "dist", "pipeline", "cli.cjs");
const work = mkdtempSync(join(tmpdir(), "c64re-842-"));

let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 842 — a data island inside a relocated block\n");

// ── The fixture ───────────────────────────────────────────────────────────────
// Stored at $F300, runs at $CA00. Layout in RUNTIME space:
//
//   $CA00  LDA #$01 / STA $D020          code
//   $CA05  "HI" + padding                DATA island  (credit_text)
//   $CA0B  LDA #$02 / STA $D021 / RTS    code — the reporter's alignment case
//   $CA10  24 bytes                      DATA island  (offsetExtraBits, a LUT)
//
const TEXT = [0x48, 0x49, 0x20, 0x20, 0x20, 0x20];            // "HI    "
const LUT = Array.from({ length: 24 }, (_, i) => 0x80 + i);
const BYTES = [
  0xa9, 0x01, 0x8d, 0x20, 0xd0,        // $CA00 LDA #$01 / STA $D020
  ...TEXT,                              // $CA05..$CA0A
  0xa9, 0x02, 0x8d, 0x21, 0xd0, 0x60,  // $CA0B LDA #$02 / STA $D021 / RTS
  ...LUT,                               // $CA11..$CA28
];
const FILE_START = 0xf300;
const RUNTIME = 0xca00;
const textRt = [RUNTIME + 5, RUNTIME + 5 + TEXT.length - 1];
const lutRt = [RUNTIME + 11 + 6, RUNTIME + 11 + 6 + LUT.length - 1];

function writePrg(name, loadAddr, bytes) {
  const p = join(work, name);
  writeFileSync(p, Buffer.from([loadAddr & 0xff, (loadAddr >> 8) & 0xff, ...bytes]));
  return p;
}
const hex = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;

function run(stem, segments) {
  const prg = writePrg(`${stem}.prg`, FILE_START, BYTES);
  writeFileSync(join(work, `${stem}_annotations.json`), JSON.stringify({ segments }, null, 2));
  const relocPath = join(work, `${stem}-reloc.json`);
  writeFileSync(relocPath, JSON.stringify([{
    fileStart: hex(FILE_START),
    fileEnd: hex(FILE_START + BYTES.length - 1),
    runtimeAddr: hex(RUNTIME),
  }], null, 2));
  // Annotations are only applied on the ANALYSIS path — the legacy path says so in
  // the header ("relocation rendering without an analysis JSON"), and that is the
  // reporter's own flow: analyze_prg, then disasm_prg with analysis_json AND
  // relocations.
  const analysisJson = join(work, `${stem}_analysis.json`);
  const a = spawnSync(process.execPath,
    [cliCjs, "analyze-prg", prg, analysisJson, hex(FILE_START).slice(1), "--no-register"],
    { cwd: work, encoding: "utf8" });
  if (a.status !== 0) throw new Error(`analyze-prg failed: ${a.stderr || a.stdout}`);

  const out = join(work, `${stem}.asm`);
  const r = spawnSync(process.execPath,
    [cliCjs, "disasm-prg", prg, out, hex(FILE_START).slice(1), analysisJson,
     "--no-register", "--relocations", relocPath],
    { cwd: work, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`disasm-prg failed: ${r.stderr || r.stdout}`);
  return { asm: readFileSync(out, "utf8"), stdout: r.stdout };
}

const runtimeSegs = [
  { start: hex(textRt[0]), end: hex(textRt[1]), kind: "text", label: "credit_text" },
  { start: hex(lutRt[0]), end: hex(lutRt[1]), kind: "data", label: "offsetExtraBits" },
];
const { asm } = run("runtime_space", runtimeSegs);

// ── Where is the block, and what is inside it? ────────────────────────────────
const blockStart = asm.search(/\.(pseudopc|logical)\s/);
check(blockStart >= 0, "the relocated block is emitted at all");
const inBlock = (needle) => {
  const i = asm.indexOf(needle);
  return i >= 0 && i > blockStart;
};

// The island itself. Its first byte is $48 ("H") and it must be a .byte directive
// carrying operands — the reported symptom was an EMPTY one, outside the block.
const byteLines = asm.split("\n").filter((l) => /^\s*\S*\s*\.byte\s/.test(l));
check(byteLines.length > 0, `data is emitted as .byte at all (${byteLines.length} lines)`);
check(!byteLines.some((l) => /\.byte\s*$/.test(l.trimEnd())),
  "no EMPTY .byte directive — the exact symptom of issue #20");

const lutFirst = LUT.slice(0, 4).map((b) => `$${b.toString(16)}`).join(", ");
check(asm.toLowerCase().includes(lutFirst), "the LUT's stored bytes appear as data");
check(inBlock(lutFirst), "…INSIDE the relocated block, not before it");

// ── Emitted ONCE ─────────────────────────────────────────────────────────────
// The other half of the bug doubled the listing: the island rendered outside AND
// was decoded again as code inside.
const occurrences = (s, sub) => s.split(sub).length - 1;
check(occurrences(asm.toLowerCase(), lutFirst) === 1,
  `the island's bytes are emitted exactly once (${occurrences(asm.toLowerCase(), lutFirst)})`);

// ── Alignment after the island — the reporter's own example ──────────────────
check(/lda\s+#\$02/i.test(asm), "the instruction after the text island decodes as LDA #$02");
check(!/\.byte\s+\$c[ab],\s*\$a9/i.test(asm),
  "…and not as the misaligned `.byte $CB,$A9` the report shows");
check(/sta\s+\$d021/i.test(asm), "…and the instruction after THAT is still aligned");

// The labels the author gave must survive into the block.
check(asm.includes("credit_text") && asm.includes("offsetExtraBits"),
  "both annotation labels appear in the listing");
// The DEFINITION (`label:`), not the `.label x = $…` equate that precedes the block.
check(inBlock("offsetExtraBits:"), "…and the label DEFINITION sits inside the block with its data");

// ── D1: file space and runtime space denote the same bytes ───────────────────
const fileSegs = [
  { start: hex(FILE_START + 5), end: hex(FILE_START + 5 + TEXT.length - 1), kind: "text", label: "credit_text", space: "file" },
  { start: hex(FILE_START + 17), end: hex(FILE_START + 17 + LUT.length - 1), kind: "data", label: "offsetExtraBits", space: "file" },
];
const fileRun = run("file_space", fileSegs);
const strip = (s) => s.split("\n").filter((l) => !/^\s*\/\/ \[relocation\]/.test(l)).join("\n")
  .replace(/runtime_space/g, "X").replace(/file_space/g, "X");
check(strip(fileRun.asm) === strip(asm),
  "a `space:\\\"file\\\"` segment and the runtime segment for the same bytes render identically");

// …and the report says which space it read, so the two cases are distinguishable.
check(/\[relocation\].*runtime address/.test(asm), "the header says an address was read as runtime");
check(/\[relocation\].*file address/.test(fileRun.asm), "…and as file, when declared so");

// ── Clipping at the block boundary is done AND reported ──────────────────────
const crossing = run("crossing", [
  { start: hex(RUNTIME + BYTES.length - 4), end: hex(RUNTIME + BYTES.length + 20), kind: "data", label: "runs_off_the_end" },
]);
check(/clipped to/.test(crossing.asm), "a segment crossing the block end is reported as clipped");
check(crossing.asm.includes("runs_off_the_end"), "…and still rendered, up to the boundary");

// ── Nothing changes without relocations ──────────────────────────────────────
// The feature is opt-in; a PRG with the same annotations and no relocations must be
// untouched by any of this.
const plainPrg = writePrg("plain.prg", RUNTIME, BYTES);
writeFileSync(join(work, "plain_annotations.json"), JSON.stringify({ segments: runtimeSegs }, null, 2));
const plainOut = join(work, "plain.asm");
const pr = spawnSync(process.execPath, [cliCjs, "disasm-prg", plainPrg, plainOut, "--no-register"],
  { cwd: work, encoding: "utf8" });
check(pr.status === 0, "a non-relocated PRG with the same annotations still renders");
const plain = readFileSync(plainOut, "utf8");
check(!/\.(pseudopc|logical)\s/.test(plain), "…with no relocated block");
check(!/\[relocation\]/.test(plain), "…and no relocation notes");
check(/lda\s+#\$02/i.test(plain), "…and the same alignment as the relocated case");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 842 reloc-data: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
