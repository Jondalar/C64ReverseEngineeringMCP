#!/usr/bin/env node
// A label a human put on an ABSOLUTE address outside the rendered image (game RAM, a
// KERNAL variable) names the operand in every absolute form (abs, abs,x, abs,y, (ind),
// jmp, jsr), the listing carries ONE equate for it before first use, and the rebuild
// stays byte-identical in both assemblers. A label on an address inside the image keeps
// its inline label. The same holds in the platform-name case (the human's name wins, the
// platform's stays a comment hint) and inside a relocated block.
//
// Hermetic: synthetic PRGs, no ROMs, no media, no daemon. The rebuild half needs
// KickAssembler / 64tass and skips those checks loudly without them.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:ext-labels

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

console.log("A label on an absolute address outside the image names the operand and gets an equate\n");

// $1001  lda $0333,x / lda $0543 / sta $0FE8,x / jsr $0333 / lda $D020 / lda.abs $33 /
//        lda inner / beq skip / jmp $0333 / skip: jmp ($0385) / inner: 2 bytes
const code = [
  0xbd, 0x33, 0x03,
  0xad, 0x43, 0x05,
  0x9d, 0xe8, 0x0f,
  0x20, 0x33, 0x03,
  0xad, 0x20, 0xd0,
  0xad, 0x33, 0x00,
  0xad, 0x1e, 0x10,
  0xf0, 0x03,
  0x4c, 0x33, 0x03,
  0x6c, 0x85, 0x03,
  0x00, 0x00,
];
const prgBytes = Buffer.from([0x01, 0x10, ...code]);
const annotations = { labels: [
  { address: "$0333", label: "under_chars" },
  { address: "$0543", label: "SHFLAG" },
  { address: "$0FE8", label: "switch_state" },
  { address: "$0385", label: "music_on" },
  { address: "$D020", label: "border_user" },
  { address: "$33", label: "zpv" },
  { address: "$101E", label: "inner" },
] };

const dir = mkdtempSync(join(tmpdir(), "c64re-ext-labels-"));
const prg = join(dir, "t.prg");
writeFileSync(prg, prgBytes);
const annPath = join(dir, "ann.json");
writeFileSync(annPath, JSON.stringify(annotations));
const analysis = join(dir, "an.json");
const node = (...a) => execFileSync(process.execPath, [cli, ...a, "--no-register"], { stdio: "pipe", cwd: dir }).toString();
node("analyze-prg", prg, analysis, "1001");

const count = (text, re) => (text.match(re) ?? []).length;
const rebuild = (kind, src, label, expected) => {
  const out = join(dir, `${label}.prg`);
  try {
    if (kind === "ka") execFileSync("java", ["-jar", KICKASS, src, "-o", out], { stdio: "pipe" });
    else execFileSync("64tass", ["--cbm-prg", "-o", out, src], { stdio: "pipe" });
  } catch (e) { return `assembler failed: ${(e.stderr ?? e.stdout ?? e.message).toString().split("\n").slice(0, 3).join(" | ")}`; }
  return Buffer.compare(readFileSync(out), expected) === 0 ? true : "bytes differ";
};
const rebuilds = (tag, asmPath, tasPath, expected) => {
  if (HAVE_KICKASS) { const r = rebuild("ka", asmPath, `ka_${tag.replace(/\W/g, "_")}`, expected); check(r === true, `${tag}: .asm rebuilds byte-identical (KickAssembler)`, r === true ? "" : r); }
  else skip(`${tag}: KickAssembler rebuild`, `no jar at ${KICKASS}`);
  if (HAVE_64TASS) { const r = rebuild("tass", tasPath, `tt_${tag.replace(/\W/g, "_")}`, expected); check(r === true, `${tag}: .tas rebuilds byte-identical (64tass)`, r === true ? "" : r); }
  else skip(`${tag}: 64tass rebuild`, "64tass not on PATH");
};
const equateRe = (name, value, kind) => kind === ".asm"
  ? new RegExp(`\\.label\\s+${name}\\s*=\\s*\\$(00)?${value}\\b`, "gi")
  : new RegExp(`^\\s*${name}\\s*=\\s*\\$(00)?${value}\\b`, "gim");

try {
  for (const platform of ["none", "c64", "vic20", "plus4"]) {
    for (const mode of ["analysis", "legacy"]) {
      const tag = `${platform}/${mode}`;
      const asmPath = join(dir, `${platform}_${mode}.asm`);
      node("disasm-prg", prg, asmPath, ...(mode === "analysis" ? ["--analysis", analysis] : ["--no-analysis", "1001"]),
        "--platform", platform, "--annotations", annPath);
      const asm = readFileSync(asmPath, "utf8");
      const tasPath = asmPath.replace(/\.asm$/, ".tas");
      const tas = readFileSync(tasPath, "utf8");
      console.log(`\n── ${tag}`);

      for (const [text, kind] of [[asm, ".asm"], [tas, ".tas"]]) {
        check(/\blda\s+under_chars,x\b/.test(text), `${kind} abs,x: lda under_chars,x`);
        check(/\blda\s+SHFLAG\b/.test(text), `${kind} abs: lda SHFLAG`);
        check(/\bsta\s+switch_state,x\b/.test(text), `${kind} abs,x store: sta switch_state,x`);
        check(/\bjsr\s+under_chars\b/.test(text), `${kind} jsr under_chars`);
        check(/\bjmp\s+under_chars\b/.test(text), `${kind} jmp under_chars`);
        check(/\bjmp\s+\(music_on\)/.test(text), `${kind} (ind): jmp (music_on)`);
        check(/\blda\s+border_user\b/.test(text), `${kind} the human's name wins over the platform's for $D020`);
        const absForm = kind === ".asm" ? /\blda\.abs\s+zpv\b/ : /\blda\s+@w\s+zpv\b/;
        check(absForm.test(text), `${kind} abs-encoded zero-page operand stays absolute with the name`);
        check(/\blda\s+inner\b/.test(text), `${kind} label inside the image still names the operand`);
        check(!/\$(0333|0543|0FE8|0385)\b/i.test(text.replace(/^.*\.label.*$|^\s*\w+\s*=\s*\$.*$/gm, "").replace(/\/\/.*|;.*/g, "")),
          `${kind} no raw outside-image operand left`);
        for (const [name, value] of [["under_chars", "0333"], ["SHFLAG", "0543"], ["switch_state", "0FE8"], ["music_on", "0385"], ["border_user", "D020"]]) {
          const n = count(text, equateRe(name, value, kind));
          check(n === 1, `${kind} exactly one equate for ${name}`, `${n}`);
        }
        const eqPos = text.search(/under_chars\s*=\s*\$/);
        const usePos = text.search(/\blda\s+under_chars/);
        check(eqPos >= 0 && eqPos < usePos, `${kind} equate precedes first use`);
        check(count(text, /^\s*inner\s*:|^inner\b/gm) >= 1 && !equateRe("inner", "101E", kind).test(text), `${kind} inside-image label stays an inline label, no equate`);
      }
      rebuilds(tag, asmPath, tasPath, prgBytes);
      if (platform === "c64" && mode === "analysis") {
        check(/lda\s+border_user\s+\/\/.*D020|lda\s+border_user\s+\/\/.*[Bb]order/.test(asm), "the platform name stays as a hint behind the user's name");
      }
    }
  }

  console.log("\n── no outside-image label: listing keeps the raw operand, no equate");
  const plainAsm = join(dir, "plain.asm");
  node("disasm-prg", prg, plainAsm, "--analysis", analysis, "--platform", "none");
  const plain = readFileSync(plainAsm, "utf8");
  check(/\blda\s+\$0333,x\b/i.test(plain) && !/under_chars|SHFLAG/.test(plain), "unlabelled absolute operands render as before");

  console.log("\n── relocated block: an address outside the whole image gets the same treatment");
  // $1001  lda $0333 / rts / [relocated to $C000]  lda $0333,x / lda $C008 / jsr $0543 / rts / $C008: 1 byte
  const rcode = [0xad, 0x33, 0x03, 0x60, 0xbd, 0x33, 0x03, 0xad, 0x0e, 0xc0, 0x20, 0x43, 0x05, 0x60, 0x00];
  const rprgBytes = Buffer.from([0x01, 0x10, ...rcode]);
  const rprg = join(dir, "r.prg");
  writeFileSync(rprg, rprgBytes);
  const rann = join(dir, "rann.json");
  writeFileSync(rann, JSON.stringify({ labels: [{ address: "$0333", label: "under_chars" }, { address: "$0543", label: "SHFLAG" }] }));
  const rmap = join(dir, "reloc.json");
  writeFileSync(rmap, JSON.stringify([{ fileStart: "1005", fileEnd: "100F", runtimeAddr: "C000" }]));
  const ranalysis = join(dir, "ran.json");
  node("analyze-prg", rprg, ranalysis, "1001");
  const rasmPath = join(dir, "reloc.asm");
  node("disasm-prg", rprg, rasmPath, "--analysis", ranalysis, "--platform", "none", "--relocations", rmap, "--annotations", rann);
  const rasm = readFileSync(rasmPath, "utf8");
  const rtas = readFileSync(rasmPath.replace(/\.asm$/, ".tas"), "utf8");
  for (const [text, kind] of [[rasm, ".asm"], [rtas, ".tas"]]) {
    check(/\blda\s+under_chars\b/.test(text) && /\blda\s+under_chars,x\b/.test(text), `${kind} reloc: gap and relocated block both name $0333`);
    check(/\bjsr\s+SHFLAG\b/.test(text), `${kind} reloc: jsr SHFLAG inside the relocated block`);
    check(count(text, equateRe("under_chars", "0333", kind)) === 1, `${kind} reloc: exactly one equate for under_chars`);
    check(count(text, equateRe("SHFLAG", "0543", kind)) === 1, `${kind} reloc: exactly one equate for SHFLAG`);
  }
  rebuilds("reloc", rasmPath, rasmPath.replace(/\.asm$/, ".tas"), rprgBytes);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failCount === 0 ? "GREEN" : "RED"}  ext-labels: ${pass} pass, ${failCount} fail, ${skipped} skipped.`);
process.exit(failCount === 0 ? 0 : 1);
