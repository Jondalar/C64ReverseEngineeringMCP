#!/usr/bin/env node
// Spec 830 — a declared entry inside an operand, and the symbols a listing owes.
//
// Hermetic: builds its own 6502 PRG carrying the multi-entry idiom, runs the
// bundled analyzer and renderer on it, and reads the listing. No project, no
// ROMs, no runtime. The byte-identity half runs KickAssembler when it is on
// this machine and SKIPS LOUDLY when it is not — a gate that silently drops
// its strongest check is worse than one that says so.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:830

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const skip = (m) => console.log(`  SKIP  ${m}`);

console.log("Spec 830 — an entry point inside an operand\n");

// ---------------------------------------------------------------- the payload
//
//   0801  20 16 08   jsr entry_a          the trampolines exist so the five
//   0804  20 19 08   jsr entry_b          entries are REFERENCED — an undefined
//   0807  20 1C 08   jsr entry_c          symbol needs a use as well as a name
//   080A  20 1F 08   jsr entry_d
//   080D  20 21 08   jsr entry_e
//   0810  20 23 08   jsr self_mod
//   0813  4C 13 08   jmp *
//   0816  A9 00      lda #$00     entry_a
//   0818  2C         BIT abs, swallowing entry_b's opcode
//   0819  A9 04      lda #$04     entry_b   <- INSIDE the operand
//   081B  2C
//   081C  A9 01      lda #$01     entry_c   <- INSIDE the operand
//   081E  60         rts
//   081F  18         clc          entry_d
//   0820  24         BIT zp, swallowing entry_e's opcode
//   0821  38         sec          entry_e   <- INSIDE the operand
//   0822  60         rts
//   0823  8D 02 08   sta $0802    a self-mod patch into the FIRST jsr's operand
//   0826  60         rts                    — NOT declared, must not split (D2)
//   0827  4C A9 C0   jmp $C0A9    a jump-table entry into another payload
const LOAD = 0x0801;
const CODE = [
  0x20, 0x16, 0x08, 0x20, 0x19, 0x08, 0x20, 0x1c, 0x08,
  0x20, 0x1f, 0x08, 0x20, 0x21, 0x08, 0x20, 0x23, 0x08,
  0x4c, 0x13, 0x08,
  0xa9, 0x00, 0x2c, 0xa9, 0x04, 0x2c, 0xa9, 0x01, 0x60,
  0x18, 0x24, 0x38, 0x60,
  0x8d, 0x02, 0x08, 0x60,
  0x4c, 0xa9, 0xc0,
];
const ENTRIES = { entry_a: 0x0816, entry_b: 0x0819, entry_c: 0x081c, entry_d: 0x081f, entry_e: 0x0821 };

const dir = mkdtempSync(join(tmpdir(), "c64re-830-"));
const prgPath = join(dir, "idiom.prg");
writeFileSync(prgPath, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE]));

writeFileSync(join(dir, "idiom_annotations.json"), JSON.stringify({
  routines: Object.entries(ENTRIES).map(([name, address]) => ({ address: address.toString(16), name, comment: `${name} — one of the fall-through entries` })),
  labels: [{ address: "c0a9", label: "window_clear" }],
  jumpTables: [{ start: "0827", end: "0829", comment: "dispatch into another payload" }],
  segments: [],
  pointerTables: [],
}, null, 2));

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const analysisPath = join(dir, "idiom_analysis.json");
const entryList = [LOAD, ...Object.values(ENTRIES)].map((a) => a.toString(16)).join(",");
execFileSync(process.execPath, [cli, "analyze-prg", prgPath, analysisPath, entryList, "--no-register"], { stdio: "pipe" });

const asmPath = join(dir, "idiom.asm");
execFileSync(process.execPath, [cli, "disasm-prg", prgPath, asmPath, "", analysisPath, "--no-register"], { stdio: "pipe" });
const asm = readFileSync(asmPath, "utf8");
const lines = asm.split("\n");

// ---------------------------------------------------------------- D1 the split
const codeOf = (line) => line.split("//")[0];
const hasLine = (re) => lines.some((l) => re.test(codeOf(l)));

check(hasLine(/^\s*\.byte \$2C\b/), "the BIT-abs skip is emitted as `.byte $2C` — the same byte, so the rebuild is byte-identical by construction");
check(hasLine(/^\s*\.byte \$24\b/), "the BIT-zp skip is emitted as `.byte $24`");
for (const name of ["entry_b", "entry_c", "entry_e"]) {
  check(hasLine(new RegExp(`^${name}:`)), `${name} is DEFINED at its own address — it sits inside the preceding BIT's operand`);
}
check(hasLine(/^entry_a:/) && hasLine(/^entry_d:/), "the two entries that were already instruction starts are unchanged");

// ---------------------------------------------------- every symbol has a home
const defined = new Set();
const used = new Set();
let inBlock = false;
for (const line of lines) {
  let code = line;
  if (inBlock) { const c = code.indexOf("*/"); if (c < 0) continue; code = code.slice(c + 2); inBlock = false; }
  const lc = code.indexOf("//");
  const bc = code.indexOf("/*");
  if (lc >= 0 && (bc < 0 || lc < bc)) code = code.slice(0, lc);
  else if (bc >= 0) { const c = code.indexOf("*/", bc + 2); if (c < 0) { inBlock = true; code = code.slice(0, bc); } else code = code.slice(0, bc) + code.slice(c + 2); }
  code = code.replace(/"(?:[^"\\]|\\.)*"/g, "");
  if (!code.trim()) continue;
  const lab = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(code);
  if (lab) { defined.add(lab[1]); code = code.slice(lab[0].length); }
  const eq = /^\s*\.label\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(code);
  if (eq) { defined.add(eq[1]); continue; }
  const head = /^\s*(\.?[A-Za-z_][A-Za-z0-9_]*)/.exec(code);
  if (head && head[1].startsWith(".cpu")) continue;
  // strip hex literals first: `$2C` would otherwise read as a symbol named "C"
  const operand = code.replace(/^\s*(\.?[A-Za-z_][A-Za-z0-9_]*)/, "").replace(/\$[0-9A-Fa-f]+/g, "");
  for (const m of operand.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!["x", "y", "a"].includes(m[0])) used.add(m[0]);
  }
}
const undefinedSymbols = [...used].filter((s) => !defined.has(s)).sort();
check(undefinedSymbols.length === 0, `every symbol the listing uses is defined (${used.size} used, ${defined.size} defined${undefinedSymbols.length ? `, MISSING ${undefinedSymbols.join(", ")}` : ""})`);

// ------------------------------------------------------------ D3 the equates
check(hasLine(/\.label window_clear = \$C0A9/), "a jump-table target in another payload becomes an equate, not a dangling name (D3)");
check(!hasLine(/^window_clear:/), "…and NOT a code label: the address is not in this file");

// ------------------------------------------- D2 self-mod is deliberately NOT split
check(/sta\s+W0801\+1/.test(asm), "a `sta` into an operand still renders `<owner>+<offset>` — self-mod is untouched (D2)");
check(!hasLine(/^W0802:/), "…and the patched byte gets no label of its own, so the jsr stays one instruction");
check(!/\.byte \$20\b/.test(asm), "the jsr the patch targets was not split into bytes");

// ------------------------------- 830.1 an instruction may not cross a segment end
//
// Two live cases in one real payload, one of them introduced by D1 itself:
// `cpy W6AD2` decodes three bytes at $6AA2 in a segment that ends at $6AA3
// (older than 830, invisible because the file did not assemble at all), and
// `jmp $FFFF` at $6E9B has a declared label at $6E9C, so D1 resumes the decode
// there — three bytes in a segment ending at $6E9D. Either way the NEXT segment
// then re-emits a byte that was already written: +1, and every address after it
// shifts.
//
//   0801  20 07 08   jsr body
//   0804  4C 04 08   jmp *
//   0807  A9 01      lda #$01          body
//   0809  4C FF FF   jmp $FFFF         3 bytes, but the segment ends at $080A
//   080C  A4 6E 1D   data
const OVERRUN = [0x20, 0x07, 0x08, 0x4c, 0x04, 0x08, 0xa9, 0x01, 0x4c, 0xff, 0xff, 0xa4, 0x6e, 0x1d];
const odir = mkdtempSync(join(tmpdir(), "c64re-830-overrun-"));
const oPrg = join(odir, "overrun.prg");
writeFileSync(oPrg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...OVERRUN]));
writeFileSync(join(odir, "overrun_annotations.json"), JSON.stringify({
  // the boundary lands INSIDE the jmp's operand
  segments: [{ start: "080b", end: "080e", kind: "data", label: "tail_data" }],
  routines: [], labels: [], jumpTables: [], pointerTables: [],
}, null, 2));
const oAnalysis = join(odir, "overrun_analysis.json");
execFileSync(process.execPath, [cli, "analyze-prg", oPrg, oAnalysis, "0801", "--no-register"], { stdio: "pipe" });
const oAsm = join(odir, "overrun.asm");
execFileSync(process.execPath, [cli, "disasm-prg", oPrg, oAsm, "", oAnalysis, "--no-register"], { stdio: "pipe" });
const overrunAsm = readFileSync(oAsm, "utf8");
const overrunCode = overrunAsm.split("\n").map((l) => l.split("//")[0]).join("\n");

check(/\.byte \$4C, \$FF\b/.test(overrunCode), "an instruction that would cross the segment end is emitted as bytes, clamped AT the end");
check(!/\bjmp \$FFFF/.test(overrunCode), "…so it is not emitted whole, which would hand the next segment a byte that was already written");
check((overrunCode.match(/\$A4/g) ?? []).length === 1, "the first byte of the next segment appears exactly once (+1 byte and every later address shifting is the failure this guards)");

// ------------------------------------------------------------- byte identity
const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
if (!existsSync(jar)) {
  skip(`byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
} else {
  for (const [what, srcAsm, srcPrg] of [["the idiom", asmPath, prgPath], ["the segment overrun", oAsm, oPrg]]) {
    const outPrg = `${srcPrg}.rebuilt`;
    let assembled = true;
    let assemblerOutput = "";
    try {
      assemblerOutput = execFileSync("java", ["-jar", jar, srcAsm, "-o", outPrg], { stdio: "pipe" }).toString();
    } catch (e) {
      assembled = false;
      assemblerOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check(assembled, `KickAssembler accepts ${what}${assembled ? "" : `:\n${assemblerOutput.split("\n").filter((l) => /Error/.test(l)).slice(0, 4).join("\n")}`}`);
    if (!assembled) continue;
    const before = readFileSync(srcPrg);
    const after = readFileSync(outPrg);
    check(before.equals(after), `${what} rebuilds byte-identical (${before.length} bytes${before.length === after.length ? "" : `, got ${after.length}`})`);
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 830 entry-in-operand: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
