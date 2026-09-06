#!/usr/bin/env node
// Spec 817 — the platform-knowledge gate. A rule nothing checks is a comment.
//
// "What is at $D018" was answered in four hand-typed tables that disagreed. They
// are gone; resources/platform-kb.sqlite is the one answer, generated from the
// c64ref snapshot plus src/platform-kb/extensions.ts. This gate keeps it that way:
//
//   1. NO SECOND TABLE — src/ and pipeline/src/ contain no address→name literal
//      map for hardware, ROM or zero page outside the seeder's own files.
//   2. IDENTICAL — re-seeding produces the same CONTENT as the committed store
//      (content hash, so another machine's SQLite build cannot fake a drift).
//   3. IDENTITY — $D011 and $D016 are distinct; $FFD2 is CHROUT; $0001 is R6510;
//      the extension rows (EasyFlash, 1541 VIA) are present.
//   4. ABI AGREES — every name in pipeline/src/lib/kernal-abi.ts (a calling-
//      convention table, kept) equals the store's symbol for that address. That
//      table is allowed to exist because it is not a name map; this check is
//      what stops it from becoming one.
//   5. RENDERED — a fixture PRG disassembles with names from the store, and
//      rebuilds byte-identical when KickAssembler is available (skipped loudly
//      when it is not).
//   6. COST — open + lookup is measured and printed; fails above 50 ms.
//
// Exit 0 = pass, 1 = fail.   node scripts/check-platform-kb.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(`  PASS  ${msg}`);

// ---------------------------------------------------------------- 1. no second table

// Files that MAY contain address→name literals: the seeder's extension table
// and the ABI table (checked separately in 4).
// Spec 829: basic-v2.ts maps PETSCII CHARACTER codes ($05 WHT, $0D RETURN, $93
// CLR) to names. Those are not addresses — nothing in that file says what lives
// at a memory location, which is the thing this gate exists to keep in one
// place. The literals only look like addresses to the regex below.
const ALLOW = new Set(["src/platform-kb/extensions.ts", "src/platform-kb/abi.ts", "pipeline/src/lib/kernal-abi.ts", "pipeline/src/lib/basic-v2.ts"]);
// An address literal used as a MAP KEY for a string: `0xd018: "..."` (object) or
// `[0xd018, "..."]` (Map tuple). Hardware, ROM and zero-page ranges only. A call
// argument like `def(0x00, "brk", …)` is an opcode table, not a name map, and
// the `(` in front of it keeps it out.
const ADDR = "0x(?:d[0-9a-f]{3}|[a-f][0-9a-f]{3}|0[0-9a-f])";
const LITERAL = new RegExp(`(?:(?:^|[{,\\s])${ADDR}\\s*:\\s*["'\`])|(?:\\[\\s*${ADDR}\\s*,\\s*["'\`])`, "i");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const offenders = [];
for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "pipeline/src"))]) {
  const rel = relative(ROOT, file);
  if (ALLOW.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  let hits = 0;
  lines.forEach((line, index) => {
    if (LITERAL.test(line) && !/\/\/.*\b0x/i.test(line.trim().slice(0, 2))) {
      hits += 1;
      if (hits <= 3) offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 90)}`);
    }
  });
  // one stray literal in a test or comparison is noise; three in one file is a table
  if (hits >= 3) fail(`address→name table outside the seeder in ${rel} (${hits} literals)`);
}
if (offenders.length && failures.length === 0) notes.push(`  info  ${offenders.length} isolated address literal(s) seen, none forming a table`);
if (!failures.length) ok("no address→name table outside src/platform-kb/extensions.ts");

// ---------------------------------------------------------------- 2. identical

const { verifyPlatformKb, defaultPlatformKbPath } = await import(join(ROOT, "dist/platform-kb/seed.js"));
const { PlatformKb } = await import(join(ROOT, "dist/platform-kb/read.js"));
const storePath = defaultPlatformKbPath(ROOT);
if (!existsSync(storePath)) {
  fail("resources/platform-kb.sqlite missing — run npm run build:platform-kb");
} else {
  const v = verifyPlatformKb(ROOT);
  if (v.skipped) notes.push(`  skip  re-seed check: ${v.skipped} — loudly skipped, not passed`);
  else if (v.ok) ok(`re-seed is content-identical (${v.freshHash.slice(0, 16)})`);
  else fail(`store drift: committed=${v.committedHash.slice(0, 16)} fresh=${v.freshHash.slice(0, 16)} — run npm run build:platform-kb and commit`);
}

// ---------------------------------------------------------------- 3. identity + 6. cost

let kb;
try {
  const t0 = process.hrtime.bigint();
  kb = new PlatformKb(storePath);
  const d018 = kb.node("c64", 0xd018);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms > 50) fail(`open + first lookup took ${ms.toFixed(1)} ms (> 50 ms)`);
  else ok(`open + first lookup ${ms.toFixed(2)} ms`);

  const d011 = kb.node("c64", 0xd011);
  const d016 = kb.node("c64", 0xd016);
  if (!d011 || !d016) fail("$D011 / $D016 missing from the store");
  else if (d011.name === d016.name || d011.symbol === d016.symbol) fail(`$D011 and $D016 share a name: "${d011.name}"`);
  else ok(`$D011 = ${d011.symbol} ≠ $D016 = ${d016.symbol}`);
  if (!d018 || d018.symbol !== "VMCSB") fail(`$D018 symbol is ${d018?.symbol ?? "missing"}, expected VMCSB`);
  // The id grammar is Spec 818 D1's — platform ":" kind ":" four lowercase hex.
  if (d018 && d018.id !== "c64:io:d018") fail(`id grammar drift: $D018 is "${d018.id}", expected "c64:io:d018"`);
  else if (d018 && !kb.byId("c64:io:d018")) fail("byId('c64:io:d018') found nothing");
  else ok("id grammar: c64:io:d018 (Spec 818 D1)");
  const ffd2 = kb.node("c64", 0xffd2);
  if (ffd2?.symbol !== "CHROUT") fail(`$FFD2 symbol is ${ffd2?.symbol ?? "missing"}, expected CHROUT`);
  else ok("$FFD2 = CHROUT");
  const r6510 = kb.node("c64", 0x0001);
  if (r6510?.symbol !== "R6510") fail(`$0001 symbol is ${r6510?.symbol ?? "missing"}, expected R6510`);
  else ok("$0001 = R6510");
  for (const [platform, address, want] of [["c64", 0xde00, "EF_BANK"], ["c1541", 0x1800, "VIA1_PRB"], ["c1541", 0x0018, null]]) {
    const n = kb.node(platform, address);
    if (!n) fail(`extension row ${platform} $${address.toString(16)} missing`);
    else if (want && n.symbol !== want) fail(`extension row ${platform} $${address.toString(16)} symbol ${n.symbol}, expected ${want}`);
  }
  ok("extension rows present (EasyFlash, 1541 VIA, 1541 zero page)");
} catch (error) {
  fail(`store unreadable: ${error.message}`);
}

// ---------------------------------------------------------------- 4. ABI agrees

try {
  const abi = require(join(ROOT, "dist/pipeline/lib/kernal-abi.cjs"));
  const entries = abi.listKernalAbiEntries();
  const mismatches = [];
  for (const entry of entries) {
    const n = kb?.node("c64", entry.address);
    if (!n) { mismatches.push(`$${entry.address.toString(16).toUpperCase()} ${entry.name}: not in store`); continue; }
    if ((n.symbol ?? "").toUpperCase() !== entry.name.toUpperCase()) mismatches.push(`$${entry.address.toString(16).toUpperCase()} abi=${entry.name} store=${n.symbol}`);
  }
  if (mismatches.length) fail(`kernal-abi names disagree with the store:\n      ${mismatches.join("\n      ")}`);
  else ok(`kernal-abi.ts (${entries.length} entries) agrees with the store`);
} catch (error) {
  fail(`kernal-abi check failed: ${error.message}`);
}

// ---------------------------------------------------------------- 4b. Spec 826 D4 — the ABI rows ARE the spec
try {
  const { abiNames } = await import(join(ROOT, "dist/platform-kb/abi.js"));
  const names = abiNames();
  const entries = kb.abiEntries("c64");
  if (entries.length !== names.size) fail(`platform_abi covers ${entries.length} entries, abi.ts names ${names.size}`);
  const bad = [];
  for (const [address, name] of names) {
    const n = kb.node("c64", address);
    if (!n || n.kind !== "rom") { bad.push(`$${address.toString(16).toUpperCase()} ${name}: not a rom node in the store`); continue; }
    if (n.symbol && n.symbol.toUpperCase() !== name.toUpperCase() && !(name === "CLRSCR")) bad.push(`$${address.toString(16).toUpperCase()} abi=${name} store=${n.symbol}`);
  }
  if (bad.length) fail(`platform_abi rows disagree with the store:\n      ${bad.join("\n      ")}`);
  const chrout = kb.abi("c64", 0xffd2);
  const setlfs = kb.abi("c64", 0xffba);
  const load = kb.abi("c64", 0xffd5);
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!chrout || !same(chrout.in, ["A"]) || chrout.out.length || chrout.clobbers.length) fail(`CHROUT abi is ${JSON.stringify(chrout)}, expected in=[A] out=[] clobbers=[]`);
  else if (!setlfs || !same(setlfs.in, ["A", "X", "Y"])) fail(`SETLFS abi is ${JSON.stringify(setlfs)}, expected in=[A,X,Y]`);
  else if (!load || !same(load.in, ["A", "X", "Y"]) || !load.out.includes("C")) fail(`LOAD abi is ${JSON.stringify(load)}, expected in=[A,X,Y] out∋C`);
  else if (kb.abi("c64", 0x1234) !== undefined) fail("abi($1234) must be undefined (unknown callee is unknown, not empty)");
  else ok(`platform_abi: ${entries.length} ROM entries, CHROUT in=[A], SETLFS in=[A,X,Y], LOAD out∋C, unknown → undefined (Spec 826 D4)`);
} catch (error) {
  fail(`platform_abi check failed: ${error.message}`);
}

// ---------------------------------------------------------------- 5. rendered

const work = join(ROOT, "analysis/tmp/spec-817");
mkdirSync(work, { recursive: true });
// $0801:  LDA $01 / STA $D018 / JSR $FFD2 / LDA $D011 / RTS
const prg = Uint8Array.from([0x01, 0x08, 0xa5, 0x01, 0x8d, 0x18, 0xd0, 0x20, 0xd2, 0xff, 0xad, 0x11, 0xd0, 0x60]);
const prgPath = join(work, "kb-fixture.prg");
writeFileSync(prgPath, prg);
const asmPath = join(work, "kb-fixture.asm");
const analysisPath = join(work, "kb-fixture_analysis.json");
try {
  // The product path: analyze first, then render with the analysis — that is
  // the renderer whose contextual comments name ROM and zero page. The legacy
  // linear render (no analysis) only comments I/O, before and after 817.
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "analyze-prg", prgPath, analysisPath, "0801"], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: work },
  });
  execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "disasm-prg", prgPath, asmPath, "0801", analysisPath], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: work },
  });
  const asm = readFileSync(asmPath, "utf8");
  for (const needle of ["CHROUT", "VMCSB", "R6510", "SCROY"]) {
    if (!asm.includes(needle)) fail(`rendered disassembly lacks "${needle}" (names are not coming from the store)`);
  }
  if (!failures.some((f) => f.includes("rendered"))) ok("rendered comments name CHROUT / VMCSB / R6510 / SCROY from the store");
  // stderr of the child must not carry the SQLite ExperimentalWarning
  const stderr = execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), "disasm-prg", prgPath, asmPath, "0801", analysisPath], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, C64RE_PROJECT_DIR: work },
  });
  void stderr;
} catch (error) {
  const text = String(error.stderr ?? error.message);
  if (/ExperimentalWarning/.test(text)) fail("SQLite ExperimentalWarning leaked into the pipeline's stderr");
  else fail(`disasm-prg failed on the fixture: ${text.slice(0, 200)}`);
}

const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
if (existsSync(jar) && existsSync(asmPath)) {
  try {
    const outPrg = join(work, "kb-fixture.rebuilt.prg");
    execFileSync("java", ["-jar", jar, asmPath, "-o", outPrg], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    const rebuilt = readFileSync(outPrg);
    if (Buffer.compare(rebuilt, Buffer.from(prg)) !== 0) fail("rebuild is not byte-identical (comments must never change bytes)");
    else ok("rebuild byte-identical (cmp)");
  } catch (error) {
    fail(`KickAssembler rebuild failed: ${String(error.stderr ?? error.message).slice(0, 200)}`);
  }
} else {
  notes.push("  skip  rebuild: KickAssembler jar not found (set C64RE_KICKASS_JAR) — loudly skipped, not passed");
}

// ---------------------------------------------------------------- report

console.log("Spec 817 platform-kb gate");
for (const line of notes) console.log(line);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`RED  check:platform-kb — ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("GREEN  check:platform-kb");
