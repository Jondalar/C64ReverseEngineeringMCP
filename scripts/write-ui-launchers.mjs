#!/usr/bin/env node
// Drop the workspace launchers into a project that already exists — `ui.sh` for
// macOS/Linux, `ui.ps1` + the ui-start/stop/restart `.cmd` shims for Windows.
//
// `project_init` writes them for a NEW project; this is the same call for a
// project that predates them (or one that is being handed to a Windows box).
// Nothing is overwritten: a file that is already there is reported and left
// alone, so a hand-edited ui.sh survives.
//
//   npm run launchers -- --project /path/to/project
//   npm run launchers -- --project . --repo /path/to/C64ReverseEngineeringMCP

import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const projectDir = resolve(flag("project") ?? process.env.C64RE_PROJECT_DIR ?? ".");
const repoDir = resolve(flag("repo") ?? ROOT);

if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
  console.error(`No such project directory: ${projectDir}`);
  console.error(`Usage: npm run launchers -- --project <dir> [--repo <c64re repo>]`);
  process.exit(2);
}
if (!existsSync(resolve(repoDir, "scripts", "workspace.mjs"))) {
  console.error(`Not a C64RE repo (no scripts/workspace.mjs): ${repoDir}`);
  process.exit(2);
}

const { ensureUiLauncher } = await import(resolve(ROOT, "dist/project-knowledge/ui-launcher.js"));
const result = ensureUiLauncher(projectDir, repoDir);

console.log(`project: ${projectDir}`);
console.log(`repo:    ${repoDir}`);
for (const file of result.files) {
  console.log(`  ${file.created ? "created" : "kept   "}  ${basename(file.path)}`);
}
console.log(``);
console.log(`macOS / Linux:  ./ui.sh start | restart | stop | status | logs`);
console.log(`Windows:        double-click ui-start.cmd / ui-stop.cmd / ui-restart.cmd`);
console.log(`                (on another machine set C64RE_REPO once: setx C64RE_REPO "C:\\path\\to\\C64ReverseEngineeringMCP")`);
