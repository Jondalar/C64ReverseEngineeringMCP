#!/usr/bin/env node
// A label a human put on a zero-page address names the operand in every zero-page
// mode, the listing carries ONE equate for it before first use, and the rebuild stays
// byte-identical in both assemblers (the zero-page encoding is kept, an abs-encoded
// zero-page operand stays absolute).
//
// Hermetic: a synthetic 27-byte PRG, no ROMs, no media, no daemon. The rebuild half
// needs KickAssembler / 64tass and skips those checks loudly without them.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:zp-labels

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/pipeline/cli.cjs");
if (!existsSync(cli)) { console.error("dist/ is not built — run npm run build"); process.exit(2); }
const KICKASS = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
const HAVE_KICKASS = existsSync(KICKASS);
const HAVE_64TASS = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;

let pass = 0, failCount = 0, skipped = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const skip = (msg, why) => { skipped += 1; console.log(`  SKIP  ${msg}  (${why})`); };

console.log("A label on a zero-page address names the operand and gets an equate\n");

// $1001  lda ptrLo / lda ptrLo,x / ldx ptrLo,y / lda (ptrLo,x) / lda (ptrLo),y /
//        sta (ptrLo),y / sta gameVar / lda.abs ptrLo / lda.abs gameVar,x /
//        lda.abs gameVar,y / lda absVar / rts / absVar: 3 bytes
const code = [
  0xa5, 0xfb, 0xb5, 0xfb, 0xb6, 0xfb, 0xa1, 0xfb, 0xb1, 0xfb, 0x91, 0xfb, 0x85, 0x02,
  0xad, 0xfb, 0x00, 0xbd, 0x02, 0x00, 0xb9, 0x02, 0x00, 0xad, 0x1c, 0x10, 0x60,
  0x00, 0x00, 0x00,
];
const prgBytes = Buffer.from([0x01, 0x10, ...code]);
const annotations = { labels: [
  { address: "$FB", label: "ptrLo" },
  { address: "$02", label: "gameVar" },
  { address: "$101C", label: "absVar" },
] };

const dir = mkdtempSync(join(tmpdir(), "c64re-zp-labels-"));
const prg = join(dir, "t.prg");
writeFileSync(prg, prgBytes);
const annPath = join(dir, "ann.json");
writeFileSync(annPath, JSON.stringify(annotations));
const analysis = join(dir, "an.json");
const node = (...a) => execFileSync(process.execPath, [cli, ...a, "--no-register"], { stdio: "pipe", cwd: dir }).toString();
node("analyze-prg", prg, analysis, "1001");

const count = (text, re) => (text.match(re) ?? []).length;
const rebuild = (kind, src, label) => {
  const out = join(dir, `${label}.prg`);
  try {
    if (kind === "ka") execFileSync("java", ["-jar", KICKASS, src, "-o", out], { stdio: "pipe" });
    else execFileSync("64tass", ["--cbm-prg", "-o", out, src], { stdio: "pipe" });
  } catch (e) { return `assembler failed: ${(e.stderr ?? e.stdout ?? e.message).toString().split("\n").slice(0, 3).join(" | ")}`; }
  return Buffer.compare(readFileSync(out), prgBytes) === 0 ? true : "bytes differ";
};

try {
  for (const platform of ["none", "c64", "vic20"]) {
    for (const mode of ["analysis", "legacy"]) {
      const tag = `${platform}/${mode}`;
      const asmPath = join(dir, `${platform}_${mode}.asm`);
      node("disasm-prg", prg, asmPath, ...(mode === "analysis" ? ["--analysis", analysis] : ["--no-analysis", "1001"]),
        "--platform", platform, "--annotations", annPath);
      const asm = readFileSync(asmPath, "utf8");
      const tasPath = asmPath.replace(/\.asm$/, ".tas");
      const tas = readFileSync(tasPath, "utf8");
      console.log(`\n── ${tag}`);

      for (const [text, kind, eq] of [[asm, ".asm", /\.label\s+ptrLo\s*=\s*\$(00)?FB\b/gi], [tas, ".tas", /^\s*ptrLo\s*=\s*\$(00)?FB\b/gim]]) {
        check(/\blda\s+ptrLo\s*(\/\/|;|$)/m.test(text), `${kind} zp: lda ptrLo`);
        check(/\blda\s+ptrLo,x/.test(text), `${kind} zp,x: lda ptrLo,x`);
        check(/\bldx\s+ptrLo,y/.test(text), `${kind} zp,y: ldx ptrLo,y`);
        check(/\blda\s+\(ptrLo,x\)/.test(text), `${kind} (zp,x): lda (ptrLo,x)`);
        check(/\blda\s+\(ptrLo\),y/.test(text), `${kind} (zp),y: lda (ptrLo),y`);
        check(/\bsta\s+\(ptrLo\),y/.test(text), `${kind} (zp),y: sta (ptrLo),y`);
        check(/\bsta\s+gameVar\b/.test(text), `${kind} zp store: sta gameVar`);
        check(/\blda\s+absVar\b/.test(text), `${kind} abs label still used: lda absVar`);
        const absForm = kind === ".asm" ? /\blda\.abs\s+ptrLo\b/ : /\blda\s+@w\s+ptrLo\b/;
        check(absForm.test(text), `${kind} abs-encoded zp operand stays absolute with the name`);
        check(!/\$FB\b/.test(text.replace(/^.*\.label.*$|^\s*ptrLo\s*=.*$/gm, "").replace(/\/\/.*|;.*/g, "")),
          `${kind} no raw $FB operand left`);
        check(count(text, eq) === 1, `${kind} exactly one equate for ptrLo`, `${count(text, eq)}`);
        const eqPos = text.search(/ptrLo\s*=\s*\$/);
        const usePos = text.search(/\blda\s+ptrLo/);
        check(eqPos >= 0 && eqPos < usePos, `${kind} equate precedes first use`);
      }

      if (HAVE_KICKASS) { const r = rebuild("ka", asmPath, `ka_${platform}_${mode}`); check(r === true, `${tag}: .asm rebuilds byte-identical (KickAssembler)`, r === true ? "" : r); }
      else skip(`${tag}: KickAssembler rebuild`, `no jar at ${KICKASS}`);
      if (HAVE_64TASS) { const r = rebuild("tass", tasPath, `tt_${platform}_${mode}`); check(r === true, `${tag}: .tas rebuilds byte-identical (64tass)`, r === true ? "" : r); }
      else skip(`${tag}: 64tass rebuild`, "64tass not on PATH");

      if (platform === "c64" && mode === "analysis") {
        check(/lda\s+ptrLo\s+\/\/ A = FREKZP/.test(asm), "the platform name stays as a hint behind the user's name");
      }
      if (platform === "none") check(!/FREKZP|TXTPTR/.test(asm), "platform none: no platform name");
    }
  }

  console.log("\n── no zero-page label: listing keeps the raw operand, no equate");
  const plainAsm = join(dir, "plain.asm");
  node("disasm-prg", prg, plainAsm, "--analysis", analysis, "--platform", "none");
  const plain = readFileSync(plainAsm, "utf8");
  check(/\blda\s+\$FB\b/.test(plain) && !/ptrLo|gameVar/.test(plain) && !/\.label\s+\w+\s*=\s*\$(00)?FB/.test(plain), "unlabelled zp operands render as before");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  zp-labels: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
