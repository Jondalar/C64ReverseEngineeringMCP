#!/usr/bin/env node
/**
 * check:ensure-built — scripts/ensure-built.mjs rebuilds exactly when the inputs' content changed.
 *
 * Runs against a throwaway project in a private temp directory whose "build" is a script that
 * counts its own runs, so it neither touches this tree's sources nor depends on tsc.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "c64re-ensure-built-"));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

try {
  mkdirSync(join(tmp, "scripts"));
  mkdirSync(join(tmp, "src"));
  mkdirSync(join(tmp, "pipeline/src"), { recursive: true });
  copyFileSync(join(here, "ensure-built.mjs"), join(tmp, "scripts/ensure-built.mjs"));
  writeFileSync(join(tmp, "scripts/fix-pipeline-ext.mjs"), "// stand-in\n");
  mkdirSync(join(tmp, "ui/src"), { recursive: true });
  writeFileSync(join(tmp, "ui/src/u.ts"), "export const u = 1;\n");
  writeFileSync(join(tmp, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(tmp, "pipeline/src/p.ts"), "export const p = 1;\n");
  writeFileSync(join(tmp, "tsconfig.json"), "{}\n");
  writeFileSync(join(tmp, "pipeline/tsconfig.json"), "{}\n");
  // The fake builds: each run appends a line to builds.log and produces the outputs ensure-built looks for.
  writeFileSync(
    join(tmp, "fake-build.mjs"),
    `import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const w = process.argv[2];
if (w === "ui") { mkdirSync("ui/dist", { recursive: true }); writeFileSync("ui/dist/index.html", ""); appendFileSync("builds.log", "ui\\n"); process.exit(0); }
if (w === "all") rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/pipeline", { recursive: true });
if (w !== "pipeline") { writeFileSync("dist/cli.js", ""); writeFileSync("dist/server.js", ""); }
if (w !== "mcp") writeFileSync("dist/pipeline/cli.cjs", "");
appendFileSync("builds.log", w + "\\n");
`,
  );
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "t",
      private: true,
      scripts: {
        build: "node fake-build.mjs all && node scripts/ensure-built.mjs --stamp",
        "build:mcp": "node fake-build.mjs mcp",
        "build:pipeline": "node fake-build.mjs pipeline",
        "ui:build": "node fake-build.mjs ui",
      },
    }),
  );

  const run = (kind) =>
    spawnSync(process.execPath, ["scripts/ensure-built.mjs", kind], { cwd: tmp, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
  const builds = () => (existsSync(join(tmp, "builds.log")) ? readFileSync(join(tmp, "builds.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  const edit = (file, text) => writeFileSync(join(tmp, file), text);

  check(run("mcp").status === 0 && builds().join() === "mcp", "first call builds (no stamp, no outputs)");
  run("mcp");
  check(builds().length === 1, "second call does not rebuild");
  edit("src/a.ts", "export const a = 2;\n");
  run("mcp");
  check(builds().length === 2, "an edited source rebuilds");
  run("mcp");
  check(builds().length === 2, "...and then settles");
  edit("src/a.ts", "export const a = 1;\n");
  run("mcp");
  check(builds().length === 3, "reverting the edit rebuilds (content changed back)");
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(tmp, "src/a.ts"), later, later);
  run("mcp");
  check(builds().length === 3, "a touched but unchanged file does not rebuild");
  rmSync(join(tmp, "dist/server.js"));
  run("mcp");
  check(builds().length === 4, "a missing output rebuilds");
  run("pipeline");
  check(builds().length === 5 && builds()[4] === "pipeline", "pipeline is a separate input set: first call builds it alone");
  edit("src/a.ts", "export const a = 3;\n");
  run("pipeline");
  check(builds().length === 5, "a src edit does not rebuild the pipeline");
  run("all");
  check(builds().length === 6 && builds()[5] === "mcp", "all builds only the stale half");
  edit("src/a.ts", "export const a = 4;\n");
  edit("pipeline/src/p.ts", "export const p = 2;\n");
  run("all");
  check(builds().slice(6).join() === "all", "all with both stale runs one full build");
  run("all");
  check(builds().length === 7, "...which stamps both");
  const before = builds().length;
  run("ui");
  run("ui");
  check(builds().length === before + 1 && builds()[before] === "ui", "ui builds once, then settles");
  edit("ui/src/u.ts", "export const u = 2;\n");
  run("ui");
  check(builds().length === before + 2, "an edited ui source rebuilds the bundle");
  edit("src/a.ts", "export const a = 5;\n");
  run("ui");
  check(builds().length === before + 3, "the bundle imports from src: a src edit rebuilds it too");
  edit("ui/src/u.ts", "export const u = 3;\n");
  spawnSync("npm", ["run", "ui:build"], { cwd: tmp, encoding: "utf8" });
  spawnSync(process.execPath, ["scripts/ensure-built.mjs", "--stamp", "ui"], { cwd: tmp });
  const n = builds().length;
  run("ui");
  check(builds().length === n, "--stamp ui records a bundle built by hand (prepack), so the next call does not rebuild");
  writeFileSync(join(tmp, "dist/stale.js"), "");
  mkdirSync(join(tmp, "dist/pipeline"), { recursive: true });
  edit("src/a.ts", "export const a = 6;\n");
  run("mcp");
  check(!existsSync(join(tmp, "dist/stale.js")) && existsSync(join(tmp, "dist/pipeline/cli.cjs")), "an mcp rebuild drops outputs of deleted sources and leaves the pipeline alone");
  check(run("bogus").status === 2, "an unknown kind is refused");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`check:ensure-built: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("check:ensure-built: ok");
