#!/usr/bin/env node
// Issue #113 — a list of paths in an environment variable is split on the platform's own
// separator (path.delimiter: ";" on Windows, ":" elsewhere), and a bare command on PATH is
// found with its Windows extension (PATHEXT). Before the fix both splits used ":", so on
// Windows 64tass on PATH was never found and C64RE_FINGERPRINT_LIBS could not name a file.
//   1  find64tassBinary() finds a 64tass placed only on PATH (C64RE_64TASS_BIN unset)
//   2  assemble_source with the real 64tass from PATH (skips loudly when none is on PATH)
//   3  C64RE_FINGERPRINT_LIBS with two absolute library files loads both
//   npm run build && node scripts/e2e-issue113-path-list-delimiter.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testTmpDir } from "./lib/neutral-tmp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { find64tassBinary, assembleSource } = await import(pathToFileURL(join(ROOT, "dist/assemble-source.js")).href);
const { loadLibraries } = await import(pathToFileURL(join(ROOT, "dist/analysis/fingerprint.js")).href);

let failures = 0;
let skips = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const skip = (name, why) => { skips++; console.log(`SKIP  ${name}: ${why} — NOT counted as a pass`); };

const savedEnv = { PATH: process.env.PATH, bin: process.env.C64RE_64TASS_BIN, libs: process.env.C64RE_FINGERPRINT_LIBS };
delete process.env.C64RE_64TASS_BIN;
const dir = testTmpDir("c64re-path-list-");
try {
  console.log("[1] 64tass only on PATH");
  // The fixed install paths come before PATH in the lookup; when one exists the PATH entry
  // cannot win, so the strict check needs a machine without them.
  const fixed = ["/opt/homebrew/bin/64tass", "/usr/local/bin/64tass"].filter((p) => existsSync(p));
  const stubDir = join(dir, "bin");
  mkdirSync(stubDir);
  const stub = join(stubDir, process.platform === "win32" ? "64tass.exe" : "64tass");
  writeFileSync(stub, "");
  process.env.PATH = [join(dir, "empty"), stubDir, savedEnv.PATH ?? ""].join(delimiter);
  const found = find64tassBinary();
  if (fixed.length) skip("the PATH entry is the one found", `a fixed install path exists (${fixed.join(", ")})`);
  else check("the 64tass on PATH is found", found !== undefined && resolve(found) === resolve(stub), `found=${found ?? "undefined"}`);
  process.env.PATH = savedEnv.PATH;

  console.log("\n[2] assemble_source with the real 64tass from PATH");
  const onPath = spawnSync("64tass", ["--version"], { stdio: "ignore" }).status === 0;
  if (!onPath) skip("assemble_source (64tass from PATH)", "no 64tass on PATH");
  else {
    const src = join(dir, "tiny.tas");
    const want = join(dir, "want.prg");
    writeFileSync(src, "* = $1000\n        lda #$01\n        rts\n");
    writeFileSync(want, Buffer.from([0x00, 0x10, 0xa9, 0x01, 0x60]));
    let r;
    try { r = await assembleSource({ projectDir: dir, sourcePath: src, assembler: "64tass", outputPath: join(dir, "out", "tiny.prg"), compareToPath: want }); }
    catch (e) { r = { exitCode: 1, stderr: String(e.message) }; }
    check("the rebuild runs and is byte-identical", r.exitCode === 0 && r.compareMatches === true, r.exitCode === 0 ? `${r.comparedBytes} bytes` : (r.stderr || "").split("\n")[0]);
  }

  console.log("\n[3] C64RE_FINGERPRINT_LIBS with two absolute files");
  const libA = join(dir, "lib-a.json");
  const libB = join(dir, "lib-b.json");
  writeFileSync(libA, JSON.stringify({ name: "routine_a" }));
  writeFileSync(libB, JSON.stringify({ name: "routine_b" }));
  process.env.C64RE_FINGERPRINT_LIBS = [libA, libB].join(delimiter);
  const libs = loadLibraries();
  check("both libraries load", libs.length === 2 && resolve(libs[0].path) === resolve(libA) && resolve(libs[1].path) === resolve(libB),
    `loaded ${libs.length}: ${libs.map((l) => l.path).join(" | ")}`);
} finally {
  if (savedEnv.bin !== undefined) process.env.C64RE_64TASS_BIN = savedEnv.bin;
  if (savedEnv.libs !== undefined) process.env.C64RE_FINGERPRINT_LIBS = savedEnv.libs; else delete process.env.C64RE_FINGERPRINT_LIBS;
  process.env.PATH = savedEnv.PATH;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures ? "RED" : "GREEN"}: ${failures} failed, ${skips} skipped`);
process.exit(failures ? 1 : 0);
