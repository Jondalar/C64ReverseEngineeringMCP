#!/usr/bin/env node
// Issue #88 — an operand whose zero-page address carries a HUMAN label gets no KERNAL/BASIC
// meaning as a trailing comment; zero page without a human label keeps its platform comment.
// Fixture ($0801): lda #0 / sta $F7 / sta $FB / lda $F7 / lda $FB / rts, with `ptr_a` at $F7
// ($F7 is RIBUF, $FB is FREKZP on the platform). Both dialects, rebuilt byte-identical.
// KickAssembler and 64tass rebuilds skip LOUDLY when the tool is missing (a skip is not a pass).
//   npm run e2e:issue88-zp-human-label
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let skips = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n        ${detail}` : ""}`);
};

const code = [0xa9, 0x00, 0x85, 0xf7, 0x85, 0xfb, 0xa5, 0xf7, 0xa5, 0xfb, 0x60];
const prg = Buffer.from([0x01, 0x08, ...code]);
const dir = mkdtempSync(join(tmpdir(), "c64re-88-"));
try {
  const prgPath = join(dir, "zp.prg");
  const ann = join(dir, "zp_annotations.json");
  const analysis = join(dir, "zp_analysis.json");
  const asm = join(dir, "zp.asm");
  writeFileSync(prgPath, prg);
  writeFileSync(ann, JSON.stringify({ labels: [{ address: "00F7", label: "ptr_a", comment: "engine pointer" }] }));
  const env = { ...process.env, C64RE_PROJECT_DIR: dir };
  const cli = (args) => execFileSync(process.execPath, [join(ROOT, "dist/pipeline/cli.cjs"), ...args], { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  cli(["analyze-prg", prgPath, analysis, "0801"]);
  const tas = asm.replace(/\.asm$/, ".tas");
  // Spec 914 — one render, one listing: the two dialects are two renders of the same bytes.
  cli(["disasm-prg", prgPath, asm, "0801", "--analysis", analysis, "--annotations", ann, "--platform", "c64", "--dialect", "kickass"]);
  cli(["disasm-prg", prgPath, tas, "0801", "--analysis", analysis, "--annotations", ann, "--platform", "c64", "--dialect", "64tass"]);
  if (process.env.E2E_DUMP) console.log(readFileSync(asm, "utf8"));
  const dialects = [["KickAssembler", asm, "//"], ["64tass", tas, ";"]];

  for (const [name, path, cm] of dialects) {
    console.log(`\n[${name}]`);
    if (!existsSync(path)) { check(`${name} listing written`, false, path); continue; }
    const lines = readFileSync(path, "utf8").split("\n");
    const labelled = lines.filter((l) => /\bptr_a\b/.test(l) && /\b(sta|lda)\b/.test(l));
    const unlabelled = lines.filter((l) => /\b(sta|lda)\b.*\$fb\b/i.test(l));
    check("both operands of the human-labelled byte are present", labelled.length === 2, labelled.join("\n        "));
    check("no platform description on a human-labelled operand",
      labelled.every((l) => !/RIBUF|Pointer|RS-232|Input Buffer/i.test(l)), labelled.join("\n        "));
    check("no comment at all on them (nothing else to say)", labelled.every((l) => !l.includes(cm)), labelled.join("\n        "));
    check("unlabelled zero page keeps its platform comment (FREKZP)",
      unlabelled.length === 2 && unlabelled.every((l) => /FREKZP/.test(l)), unlabelled.join("\n        "));
  }

  console.log("\n[rebuild]");
  const jar = process.env.C64RE_KICKASS_JAR ?? "/Applications/KickAssembler/KickAss.jar";
  if (existsSync(jar)) {
    const out = join(dir, "kick.prg");
    const r = spawnSync("java", ["-jar", jar, asm, "-o", out], { cwd: dir, encoding: "utf8" });
    check("KickAssembler rebuild byte-identical", r.status === 0 && existsSync(out) && Buffer.compare(readFileSync(out), prg) === 0, (r.stdout + r.stderr).slice(-300));
  } else { skips++; console.log(`SKIP  KickAssembler rebuild: ${jar} not found (set C64RE_KICKASS_JAR) — NOT counted as a pass`); }
  const tass = spawnSync("64tass", ["--version"], { encoding: "utf8" });
  if (!tass.error) {
    const out = join(dir, "tass.prg");
    const r = spawnSync("64tass", ["-C", "-a", "-o", out, tas], { cwd: dir, encoding: "utf8" });
    check("64tass rebuild byte-identical", r.status === 0 && existsSync(out) && Buffer.compare(readFileSync(out), prg) === 0, (r.stdout + r.stderr).slice(-300));
  } else { skips++; console.log("SKIP  64tass rebuild: 64tass not on PATH — NOT counted as a pass"); }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.log(`\nRED  e2e:issue88-zp-human-label — ${failures} failure(s)`); process.exit(1); }
console.log(`\nGREEN  e2e:issue88-zp-human-label${skips ? ` (${skips} rebuild(s) SKIPPED)` : ""}`);
