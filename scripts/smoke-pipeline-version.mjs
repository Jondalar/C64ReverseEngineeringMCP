#!/usr/bin/env node
// Issue #71 (side finding) — a checkout pulled but not rebuilt must say so.
//
// The server (src/ via tsx) can be newer than dist/pipeline/*.cjs; rendering then runs through
// the old pipeline and nothing tells the reader. The build stamps dist/pipeline/.pipeline-version
// with the package version; the server compares it before it spawns the pipeline and puts a
// WARNING in the tool answer on a mismatch or a missing stamp.
//
// Hermetic: the real run-cli.js + pipeline-build.js are copied into a throwaway package root next
// to a stub pipeline, so "match" and "mismatch" are staged without touching this checkout's dist.
//   npm run smoke:pipeline-version
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

if (!existsSync(join(ROOT, "dist", "run-cli.js"))) {
  console.log("FAIL  dist/run-cli.js is built (npm run build:mcp)");
  process.exit(1);
}

// The real build carries a stamp equal to package.json's version (only when the pipeline is built).
const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const realStamp = join(ROOT, "dist", "pipeline", ".pipeline-version");
if (existsSync(join(ROOT, "dist", "pipeline", "cli.cjs"))) {
  check("this checkout's dist/pipeline is stamped with the package version",
    existsSync(realStamp) && readFileSync(realStamp, "utf8").trim() === pkgVersion,
    existsSync(realStamp) ? `stamp ${readFileSync(realStamp, "utf8").trim()} vs package ${pkgVersion}` : "no stamp — run npm run build:pipeline");
} else {
  console.log("SKIP  real dist/pipeline not built; the staged cases below still run");
}

const tmp = mkdtempSync(join(tmpdir(), "c64re-pipever-"));
try {
  const pkgRoot = join(tmp, "pkg");
  mkdirSync(join(pkgRoot, "dist", "pipeline"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "x", version: "9.9.9", type: "module" }));
  cpSync(join(ROOT, "dist", "run-cli.js"), join(pkgRoot, "dist", "run-cli.js"));
  cpSync(join(ROOT, "dist", "pipeline-build.js"), join(pkgRoot, "dist", "pipeline-build.js"));
  // A stub pipeline: prints one line, exits 0.
  writeFileSync(join(pkgRoot, "dist", "pipeline", "cli.cjs"), "process.stdout.write('pipeline ran\\n');\n");
  const stamp = join(pkgRoot, "dist", "pipeline", ".pipeline-version");

  const { runCli } = await import(pathToFileURL(join(pkgRoot, "dist", "run-cli.js")).href);
  const { pipelineBuildWarning } = await import(pathToFileURL(join(pkgRoot, "dist", "pipeline-build.js")).href);
  const cli = join(pkgRoot, "dist", "pipeline", "cli.cjs");

  // match: no warning, the run is untouched
  writeFileSync(stamp, "9.9.9\n");
  check("match: no warning from the checker", pipelineBuildWarning(cli, pkgRoot) === undefined);
  const ok = await runCli("x", [], { projectDir: tmp });
  check("match: the run answers cleanly", ok.exitCode === 0 && /pipeline ran/.test(ok.stdout) && ok.stderr === "", JSON.stringify(ok));

  // mismatch: loud, names both versions and the remedy, run still happens
  writeFileSync(stamp, "0.8.0\n");
  const w = pipelineBuildWarning(cli, pkgRoot);
  check("mismatch: the checker names both versions and npm run build",
    !!w && /pipeline build is 0\.8\.0, server is 9\.9\.9/.test(w) && /npm run build/.test(w), w);
  const bad = await runCli("x", [], { projectDir: tmp });
  check("mismatch: the tool answer carries the WARNING and the run still happened",
    bad.exitCode === 0 && /pipeline ran/.test(bad.stdout) && /WARNING: pipeline build is 0\.8\.0, server is 9\.9\.9/.test(bad.stderr), JSON.stringify(bad));

  // missing stamp: also loud
  rmSync(stamp);
  const none = await runCli("x", [], { projectDir: tmp });
  check("missing stamp: the tool answer warns that the build carries no version stamp",
    /WARNING: pipeline build carries no version stamp.*server is 9\.9\.9/.test(none.stderr) && /npm run build/.test(none.stderr), none.stderr);

  // a pipeline that is not this package's own dist/pipeline is not judged
  const ext = join(tmp, "external", "cli.cjs");
  mkdirSync(join(tmp, "external"), { recursive: true });
  writeFileSync(ext, "");
  check("an external pipeline (C64RE_TOOLS_DIR) is not judged against this package", pipelineBuildWarning(ext, pkgRoot) === undefined);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nthe stamp speaks" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
