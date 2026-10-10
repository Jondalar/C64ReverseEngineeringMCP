#!/usr/bin/env node
// A name a human gave a RUNTIME address inside a relocated block (`.pseudopc` / `.logical`)
// is defined at its instruction inside the block - also when nothing in the block
// references it, or nothing at all - and every absolute operand that targets that runtime
// address names it: from outside the block, from the same block (abs, abs,x, abs,y, (ind),
// jsr, jmp). An address in the middle of an instruction is an equate, not a label. The
// listing defines each name exactly once and rebuilds byte-identical in KickAssembler and
// 64tass.
//
// The collision rule: an operand resolves to the runtime name only when its address is in
// a block's runtime window AND NOT also an address of the loaded image. Which of the two
// is in memory when the operand executes depends on whether the copy has run - not
// knowable from the bytes - so an address the image holds keeps its image meaning.
//
// Hermetic: synthetic PRGs, no ROMs, no media, no daemon. The rebuild half needs
// KickAssembler / 64tass and skips those checks loudly without them.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:reloc-names

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("dist/ is not built - run npm run build"); process.exit(2); }
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_KICKASS = existsSync(KICKASS);
const HAVE_64TASS = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;

let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };

console.log("A name inside a relocated block is defined at its instruction and names every reference into it\n");

// ---------------------------------------------------------------- fixture 1: the issue
// load $0FFE. Image: outside code $0FFE.., block A file $1200-$13FF runs at $05F5,
// block B (the decruncher) file $1400-$148D runs at $00FD, in zero page.
const LOAD = 0x0ffe, LAST = 0x148d;
const img = new Array(LAST - LOAD + 1).fill(0xea);
const put = (addr, bytes) => { bytes.forEach((b, i) => { img[addr + i - LOAD] = b; }); };
put(LOAD, [
  0x20, 0x23, 0x07,       // jsr $0723      erase_player, outside only
  0x20, 0xbe, 0x07,       // jsr $07BE      sound_off, outside only
  0x20, 0x15, 0x07,       // jsr $0715      status_colour
  0xad, 0x51, 0x07,       // lda $0751      mid_op: INSIDE an instruction of the block
  0xb9, 0x23, 0x07,       // lda $0723,y
  0xbd, 0xbe, 0x07,       // lda $07BE,x
  0xa5, 0xfe,             // lda $FE        zp_flag, zero page inside block B's window
  0xa9, 0x00,
  0xf0, 0x03,             // beq +3 (over the jmp)
  0x4c, 0x88, 0x01,       // jmp $0188      decrunch_start, reached only from outside
  0x6c, 0x15, 0x07,       // jmp ($0715)
]);
const A = new Array(0x200).fill(0xea);
const putA = (rt, bytes) => { bytes.forEach((b, i) => { A[rt + i - 0x05f5] = b; }); };
putA(0x0715, [0xca, 0xd0, 0xfd, 0x60]);                                   // status_colour: dex / bne self / rts
putA(0x0723, [0xa9, 0x00, 0x9d, 0xbe, 0x07, 0x60]);                       // erase_player: lda #0 / sta $07BE,x / rts
putA(0x0730, [0x20, 0x23, 0x07, 0x6c, 0x15, 0x07, 0xb9, 0x23, 0x07, 0x60]); // jsr / jmp (ind) / lda abs,y - same block
putA(0x07be, [0xa9, 0x0f, 0x60]);                                         // sound_off
putA(0x0740, [0xe8, 0x60]);                                               // lonely: referenced by nothing
putA(0x0750, [0xad, 0x34, 0x12, 0x60]);                                   // lda $1234 - $0751 is its operand
A[0x1ff] = 0x60;
put(0x1200, A);
const B = new Array(0x8e).fill(0xea);
B[0x8b] = 0xa9; B[0x8c] = 0x01; B[0x8d] = 0x60;                          // decrunch_start at $0188: lda #1 / rts
put(0x1400, B);
const prg1 = Buffer.from([LOAD & 0xff, LOAD >> 8, ...img]);
const ann1 = {
  routines: [
    { address: "0715", name: "status_colour" },
    { address: "0723", name: "erase_player" },
    { address: "07BE", name: "sound_off" },
    { address: "0740", name: "lonely" },
    { address: "0751", name: "mid_op" },
    { address: "0188", name: "decrunch_start" },
  ],
  labels: [{ address: "00FE", label: "zp_flag" }],
};
const reloc1 = [
  { fileStart: "1200", fileEnd: "13FF", runtimeAddr: "05F5" },
  { fileStart: "1400", fileEnd: "148D", runtimeAddr: "00FD" },
];

// ---------------------------------------------------------------- fixture 2: the collision
// load $1000. The window of the block ($1002-$1011) lies INSIDE the image: $1008 is both a
// runtime address of the block and an image address. The image meaning wins.
const prg2 = Buffer.from([
  0x00, 0x10,
  0x20, 0x08, 0x10,       // $1000 jsr $1008
  0x4c, 0x0b, 0x10,       // $1003 jmp $100B
  0xea, 0xea,             // $1006
  0xea, 0xea,             // $1008 pad ...
  0xea,                   // $100A
  0xa9, 0x01, 0x60,       // $100B image routine
  ...new Array(0x10).fill(0xea),
  0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60,
]);
const ann2 = { routines: [{ address: "100B", name: "image_routine" }, { address: "1008", name: "image_pad" }] };
const reloc2 = [{ fileStart: "101E", fileEnd: "102D", runtimeAddr: "1002" }];

const dir = mkdtempSync(join(tmpdir(), "c64re-reloc-names-"));
const node = (...a) => execFileSync(process.execPath, [cli, ...a, "--no-register"], { stdio: "pipe", cwd: dir }).toString();
const count = (text, re) => (text.match(re) ?? []).length;
const defs = (text, name) =>
  count(text, new RegExp(`^\\s*${name}\\s*:`, "gm")) +
  count(text, new RegExp(`^\\s*\\.label\\s+${name}\\s*=`, "gm")) +
  count(text, new RegExp(`^\\s*${name}\\s*=\\s*\\$`, "gm"));
const rebuild = (kind, src, label, expected) => {
  const out = join(dir, `${label}.prg`);
  try {
    if (kind === "ka") execFileSync("java", ["-jar", KICKASS, src, "-o", out], { stdio: "pipe" });
    else execFileSync("64tass", ["--cbm-prg", "-o", out, src], { stdio: "pipe" });
  } catch (e) { return `assembler failed: ${(e.stderr ?? e.stdout ?? e.message).toString().split("\n").slice(0, 3).join(" | ")}`; }
  return Buffer.compare(readFileSync(out), expected) === 0 ? true : "bytes differ";
};
const rebuilds = (tag, asmPath, tasPath, expected) => {
  const safe = tag.replace(/\W/g, "_");
  if (HAVE_KICKASS) { const r = rebuild("ka", asmPath, `ka_${safe}`, expected); check(r === true, `${tag}: .asm rebuilds byte-identical (KickAssembler)`, r === true ? "" : r); }
  else skip(`${tag}: KickAssembler rebuild`, `no jar at ${KICKASS}`);
  if (HAVE_64TASS) { const r = rebuild("tass", tasPath, `tt_${safe}`, expected); check(r === true, `${tag}: .tas rebuilds byte-identical (64tass)`, r === true ? "" : r); }
  else skip(`${tag}: 64tass rebuild`, "64tass not on PATH");
};

try {
  const prgPath = join(dir, "t.prg"); writeFileSync(prgPath, prg1);
  const annPath = join(dir, "ann.json"); writeFileSync(annPath, JSON.stringify(ann1));
  const relocPath = join(dir, "reloc.json"); writeFileSync(relocPath, JSON.stringify(reloc1));
  const analysis = join(dir, "an.json");
  node("analyze-prg", prgPath, analysis, "0FFE");

  for (const platform of ["c64", "plus4"]) {
    console.log(`\n== ${platform}, with analysis`);
    const asmPath = join(dir, `${platform}.asm`);
    node("disasm-prg", prgPath, asmPath, "--analysis", analysis, "--platform", platform, "--relocations", relocPath, "--annotations", annPath);
    const asm = readFileSync(asmPath, "utf8");
    const tasPath = asmPath.replace(/\.asm$/, ".tas");
    const tas = readFileSync(tasPath, "utf8");
    for (const [text, kind] of [[asm, ".asm"], [tas, ".tas"]]) {
      for (const name of ["status_colour", "erase_player", "sound_off", "lonely", "decrunch_start", "mid_op", "zp_flag"]) {
        check(defs(text, name) === 1, `${kind} ${name} is defined exactly once`, `${defs(text, name)}`);
      }
      const block = (re) => { const m = re.exec(text); return m ? m[0] : ""; };
      const blockA = block(/\.(pseudopc|logical) \$05F5[\s\S]*?(?=\n\s*(\}|\.here)\s*\n)/);
      const blockB = block(/\.(pseudopc|logical) \$00FD[\s\S]*?(?=\n\s*(\}|\.here)\s*\n)/);
      check(/^\s*erase_player\s*:/m.test(blockA) && /^\s*sound_off\s*:/m.test(blockA) && /^\s*lonely\s*:/m.test(blockA),
        `${kind} names with no reference inside the block are labels inside it`);
      check(/^\s*decrunch_start\s*:/m.test(blockB), `${kind} the zero-page decruncher entry is a label inside its block`);
      check(!/^\s*mid_op\s*:/m.test(text) && /(\.label\s+mid_op\s*=|^\s*mid_op\s*=)\s*\$0751/im.test(text),
        `${kind} a name in the middle of an instruction is an equate, not a label`);
      check(/\bjsr\s+erase_player\b/.test(text) && /\bjsr\s+sound_off\b/.test(text) && /\bjsr\s+status_colour\b/.test(text),
        `${kind} jsr from outside names the block's routines`);
      check(/\blda\s+erase_player,y\b/.test(text) && /\blda\s+sound_off,x\b/.test(text), `${kind} abs,x / abs,y from outside use the name`);
      check(/\bjmp\s+\(status_colour\)/.test(text), `${kind} (ind) from outside uses the name`);
      check(/\bjmp\s+decrunch_start\b/.test(text), `${kind} jmp into the zero-page block uses the name`);
      check(/\blda\s+mid_op\b/.test(text), `${kind} an operand into the middle of an instruction uses the equate`);
      check(/\bsta\s+sound_off,x\b/.test(blockA) && /\bjsr\s+erase_player\b/.test(blockA) && /\blda\s+erase_player,y\b/.test(blockA),
        `${kind} operands inside the same block use the names`);
      check(!/\$07(15|23|BE|51)\b/i.test(text.replace(/\/\/.*|;.*/g, "").replace(/^.*(\.label|\.pseudopc|\.logical|= ).*$/gm, "")),
        `${kind} no raw runtime address is left as an operand`);
    }
    rebuilds(`${platform}/analysis`, asmPath, tasPath, prg1);

    console.log(`\n== ${platform}, without analysis (annotations are not applied on the relocation path - and it says so)`);
    const plainPath = join(dir, `${platform}_plain.asm`);
    node("disasm-prg", prgPath, plainPath, "0FFE", "--no-analysis", "--platform", platform, "--relocations", relocPath, "--annotations", annPath);
    const plain = readFileSync(plainPath, "utf8");
    check(/NOT applied: relocation rendering without an analysis JSON/.test(plain), "the header says the names were not applied");
    check(!/erase_player|decrunch_start/.test(plain), "no name is half-applied");
    rebuilds(`${platform}/no-analysis`, plainPath, plainPath.replace(/\.asm$/, ".tas"), prg1);
  }

  console.log("\n== no annotations: a relocated listing is unchanged by naming (no equates, no names)");
  const barePath = join(dir, "bare.asm");
  node("disasm-prg", prgPath, barePath, "--analysis", analysis, "--platform", "c64", "--relocations", relocPath);
  const bare = readFileSync(barePath, "utf8");
  check(!/erase_player|status_colour|mid_op|\.label\s+\w+\s*=\s*\$0751/.test(bare), "nothing is named that the human did not name");
  rebuilds("bare", barePath, barePath.replace(/\.asm$/, ".tas"), prg1);

  console.log("\n== collision: a runtime window that lies inside the image keeps the image meaning");
  const p2 = join(dir, "c.prg"); writeFileSync(p2, prg2);
  const a2 = join(dir, "c_ann.json"); writeFileSync(a2, JSON.stringify(ann2));
  const r2 = join(dir, "c_reloc.json"); writeFileSync(r2, JSON.stringify(reloc2));
  const an2 = join(dir, "c_an.json");
  node("analyze-prg", p2, an2, "1000");
  const asm2Path = join(dir, "c.asm");
  node("disasm-prg", p2, asm2Path, "--analysis", an2, "--platform", "c64", "--relocations", r2, "--annotations", a2);
  const asm2 = readFileSync(asm2Path, "utf8");
  const tas2 = readFileSync(asm2Path.replace(/\.asm$/, ".tas"), "utf8");
  for (const [text, kind] of [[asm2, ".asm"], [tas2, ".tas"]]) {
    check(defs(text, "image_routine") === 1, `${kind} image_routine is defined exactly once`, `${defs(text, "image_routine")}`);
    check(defs(text, "image_pad") <= 1, `${kind} image_pad is not defined a second time inside the block`, `${defs(text, "image_pad")}`);
    check(/\bjmp\s+image_routine\b/.test(text), `${kind} the image address keeps its image name`);
  }
  rebuilds("collision", asm2Path, asm2Path.replace(/\.asm$/, ".tas"), prg2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  reloc-names: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
