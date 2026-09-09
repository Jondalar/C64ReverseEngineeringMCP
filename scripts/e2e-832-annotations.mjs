#!/usr/bin/env node
// Spec 832 D1 — a routine annotation CREATES its label, it does not only rename
// one that already existed.
//
// `buildAnnotationsIndex` puts a routine's name into `labelsByAddress` and
// `makeLabel` reads exactly that — but `makeLabel` is only consulted at
// addresses already in `context.labelSet`, which is built from segment starts
// and from what the analyser could REFERENCE. A routine the human named at an
// address nothing jumps to therefore had a name that nothing printed, while the
// header still said "Semantic annotations applied".
//
// Hermetic: builds its own PRG, runs the bundled analyzer and renderer on it,
// and reads the listing. No project, no ROMs, no runtime. The byte-identity
// half runs KickAssembler when it is on this machine and SKIPS LOUDLY when it
// is not — a gate that silently drops its strongest check is worse than one
// that says so.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:832-annotations

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

console.log("Spec 832 D1 — an annotated address is a labelled address\n");

// ---------------------------------------------------------------- the payload
//
//   0801  20 18 08   jsr entry_a        the trampolines make three of the names
//   0804  20 1B 08   jsr entry_b        REFERENCED, so the fixture also carries
//   0807  20 1E 08   jsr helper         the cases that already worked
//   080A  8D 02 08   sta $0802          a self-mod patch into the first jsr's
//                                       operand — NOT declared, must not split
//   080D  20 24 08   jsr $0824          reaches the jump-table row
//   0810  AD 30 08   lda $0830          reaches into the data segment
//   0813  A2 00      ldx #$00
//   0815  4C 15 08   jmp *
//   0818  A9 00      lda #$00     entry_a
//   081A  2C         BIT abs, swallowing entry_b's opcode
//   081B  A9 04      lda #$04     entry_b        <- INSIDE that operand (830)
//   081D  60         rts
//   081E  A9 07      lda #$07     helper
//   0820  EA         nop          lonely_routine <- named, referenced by NOTHING
//   0821  A2 09      ldx #$09     lonely_label   <- named, referenced by NOTHING
//   0823  60         rts
//   0824  4C 60 C1   jmp $C160    a jump-table row into another payload
//   0827..0836       the data segment, holding data_head ($0830, referenced)
//                    and table_mid ($0832, named and referenced by NOTHING)
const LOAD = 0x0801;
const CODE = [
  0x20, 0x18, 0x08, 0x20, 0x1b, 0x08, 0x20, 0x1e, 0x08,
  0x8d, 0x02, 0x08, 0x20, 0x24, 0x08, 0xad, 0x30, 0x08,
  0xa2, 0x00, 0x4c, 0x15, 0x08,
  0xa9, 0x00, 0x2c, 0xa9, 0x04, 0x60,
  0xa9, 0x07, 0xea, 0xa2, 0x09, 0x60,
  0x4c, 0x60, 0xc1,
];
const DATA = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10];

// Every name the human wrote down, and whether anything in the payload refers
// to it. The "no" rows are the defect: before D1 they never reached the listing.
const NAMES = {
  entry_a: { address: 0x0818, referenced: true },
  entry_b: { address: 0x081b, referenced: true },
  helper: { address: 0x081e, referenced: true },
  lonely_routine: { address: 0x0820, referenced: false },
  lonely_label: { address: 0x0821, referenced: false },
  data_head: { address: 0x0830, referenced: true },
  table_mid: { address: 0x0832, referenced: false },
  far_routine: { address: 0xc160, referenced: true },
};

const dir = mkdtempSync(join(tmpdir(), "c64re-832-"));
const prgPath = join(dir, "named.prg");
writeFileSync(prgPath, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE, ...DATA]));

writeFileSync(join(dir, "named_annotations.json"), JSON.stringify({
  segments: [{ start: "0827", end: "0836", kind: "data", label: "tbl" }],
  routines: [
    { address: "0818", name: "entry_a", comment: "first fall-through entry" },
    { address: "081b", name: "entry_b", comment: "second entry, inside the BIT operand" },
    { address: "081e", name: "helper", comment: "called normally" },
    { address: "0820", name: "lonely_routine", comment: "named by a human, referenced by nothing" },
  ],
  labels: [
    { address: "0821", label: "lonely_label" },
    { address: "0830", label: "data_head" },
    { address: "0832", label: "table_mid" },
    { address: "c160", label: "far_routine" },
  ],
  jumpTables: [{ start: "0824", end: "0826", comment: "dispatch into another payload" }],
  pointerTables: [],
}, null, 2));

const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("pipeline not built — run npm run build"); process.exit(2); }
const analysisPath = join(dir, "named_analysis.json");
// ONLY $0801 is declared as an entry point: the four unreferenced names must be
// carried into the listing by the annotations alone, which is the reported case.
execFileSync(process.execPath, [cli, "analyze-prg", prgPath, analysisPath, "0801", "--no-register"], { stdio: "pipe" });

const asmPath = join(dir, "named.asm");
execFileSync(process.execPath, [cli, "disasm-prg", prgPath, asmPath, "", analysisPath, "--no-register"], { stdio: "pipe" });
const asm = readFileSync(asmPath, "utf8");
const lines = asm.split("\n");
const codeOf = (line) => line.split("//")[0];
const hasLine = (re) => lines.some((l) => re.test(codeOf(l)));

// ------------------------------------------------- D1: every name is defined
const definedAt = (name) => hasLine(new RegExp(`^${name}:`)) || hasLine(new RegExp(`^\\s*\\.label\\s+${name}\\s*=`));
const reached = Object.keys(NAMES).filter((name) => definedAt(name));
const missing = Object.keys(NAMES).filter((name) => !definedAt(name));
check(
  missing.length === 0,
  `every annotation name reaches the listing — ${reached.length} of ${Object.keys(NAMES).length}` +
  `${missing.length ? `, MISSING ${missing.join(", ")}` : ""} (was 5 of 8 before D1)`,
);

for (const name of ["lonely_routine", "lonely_label"]) {
  check(hasLine(new RegExp(`^${name}:`)), `${name} is DEFINED at its own address, in code nothing references — the human naming it IS the declaration`);
}
check(hasLine(/^table_mid:/), "an annotated label inside a data segment is defined by emitByteRange's interior label, unreferenced though it is");

// the label must sit at the address the human wrote, not somewhere convenient
const lineIndexOf = (re) => lines.findIndex((l) => re.test(codeOf(l)));
check(codeOf(lines[lineIndexOf(/^lonely_routine:/) + 1] ?? "").includes("nop"), "lonely_routine's label sits at $0820 — the `nop` is the next line, so the name names what the human named");
check(codeOf(lines[lineIndexOf(/^lonely_label:/) + 1] ?? "").includes("ldx  #$09"), "lonely_label's label sits at $0821");
check(/^table_mid:\s*$/.test(lines[lineIndexOf(/^table_mid:/)] ?? "") &&
  /^\s*\.byte \$0C,/.test(codeOf(lines[lineIndexOf(/^table_mid:/) + 1] ?? "")), "table_mid's label sits at $0832 — the byte run breaks there and resumes with $0C");

// --------------------------------------- the three Spec 830 shapes still hold
check(hasLine(/^\s*\.byte \$2C\b/) && hasLine(/^entry_b:/), "830: a declared entry inside a BIT operand still splits the instruction into `.byte $2C` and defines the entry");
check(/sta\s+W0801\+1/.test(asm), "830 D2: a `sta` into an operand still renders `<owner>+<offset>` — self-mod is untouched by the wider label set");
check(!hasLine(/^W0802:/) && !/\.byte \$20\b/.test(asm), "…and the jsr it patches is still one instruction, not shredded into bytes");
check(hasLine(/\.label far_routine = \$C160/) && !hasLine(/^far_routine:/), "830 D3: a name outside the mapping stays an equate — an annotated label must not look as if it were defined in this file");
check(hasLine(/^data_head:/), "an annotated label at a referenced data address is still a real label inside the byte run");

// ------------------------------------- every symbol the listing uses is defined
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
check(new Set([...defined]).size === [...lines].filter((l) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(codeOf(l))).length + (asm.match(/^\s*\.label\s+/gm) ?? []).length,
  "no symbol is defined twice — a name that now gets a real label line must not also get an equate");

// The 830 backstop covers a name the listing USES without DEFINING. Giving the
// named addresses real definitions must shrink that section, never grow it.
const backstop = lines.filter((l) => /Equates for named addresses this listing references but does not define/.test(l)).length;
check(backstop === 0, `the undefined-symbol backstop emits nothing — every name has a real home (${backstop} backstop section(s))`);

// ------------------------------------------------------------- byte identity
const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
if (!existsSync(jar)) {
  skip(`byte-identical rebuild: KickAssembler not found at ${jar} (set C64RE_KICKASS_JAR) — the check is skipped, not passed`);
} else {
  const outPrg = `${prgPath}.rebuilt`;
  let assembled = true;
  let assemblerOutput = "";
  try {
    assemblerOutput = execFileSync("java", ["-jar", jar, asmPath, "-o", outPrg], { stdio: "pipe" }).toString();
  } catch (e) {
    assembled = false;
    assemblerOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  check(assembled, `KickAssembler accepts the annotated listing${assembled ? "" : `:\n${assemblerOutput.split("\n").filter((l) => /Error/.test(l)).slice(0, 4).join("\n")}`}`);
  if (assembled) {
    const before = readFileSync(prgPath);
    const after = readFileSync(outPrg);
    check(before.equals(after), `it rebuilds byte-identical — a label is symbolic and emits no bytes (${before.length} bytes${before.length === after.length ? "" : `, got ${after.length}`})`);
  }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 832 annotations: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
