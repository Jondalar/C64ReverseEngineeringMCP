#!/usr/bin/env node
// Write the double-click UI starters into a project folder, for one platform:
//   linux   ui.sh + ui-start|stop|restart.desktop
//   macos   ui.sh + ui-start|stop|restart.command
//   windows ui.ps1 + ui-start|stop|restart.cmd
// Same call as the project_launchers MCP tool. Without --refresh a file that is
// already there is reported and left alone, so a hand-edited ui.sh survives.
//
//   npm run launchers -- --project /path/to/project [--platform linux|macos|windows] [--refresh]
//   npm run launchers -- --project . --repo /path/to/C64ReverseEngineeringMCP

import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const hasFlag = (name) => argv.includes(`--${name}`);
const platform = flag("platform");
if (platform !== undefined && !["linux", "macos", "windows"].includes(platform)) {
  console.error(`Unknown --platform ${platform} (linux | macos | windows)`);
  process.exit(2);
}

const projectDir = resolve(flag("project") ?? process.env.C64RE_PROJECT_DIR ?? ".");
const repoDir = resolve(flag("repo") ?? ROOT);

if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
  console.error(`No such project directory: ${projectDir}`);
  console.error(`Usage: npm run launchers -- --project <dir> [--repo <c64re repo>] [--platform linux|macos|windows] [--refresh]`);
  process.exit(2);
}
if (!existsSync(resolve(repoDir, "scripts", "workspace.mjs"))) {
  console.error(`Not a C64RE repo (no scripts/workspace.mjs): ${repoDir}`);
  process.exit(2);
}

const { ensureUiLaunchers } = await import(pathToFileURL(resolve(ROOT, "dist/project-knowledge/ui-launcher.js")));
const result = ensureUiLaunchers(projectDir, repoDir, { platform, refresh: hasFlag("refresh") });

console.log(`project: ${projectDir}`);
console.log(`repo:    ${repoDir}`);
for (const file of result.files) {
  console.log(`  ${file.created ? "created" : "kept   "}  ${basename(file.path)}`);
}
console.log(``);
console.log(`platform: ${result.platform}`);
console.log(``);
if (result.platform === "windows") {
  console.log(`Double-click ui-start.cmd / ui-stop.cmd / ui-restart.cmd`);
  console.log(`(on another machine set C64RE_REPO once: setx C64RE_REPO "C:\\path\\to\\C64ReverseEngineeringMCP")`);
} else if (result.platform === "macos") {
  console.log(`Double-click ui-start.command / ui-stop.command / ui-restart.command, or ./ui.sh start|restart|stop|status|logs [--open]`);
} else {
  console.log(`Double-click ui-start.desktop / ui-stop.desktop / ui-restart.desktop, or ./ui.sh start|restart|stop|status|logs [--open]`);
  console.log(`The .desktop files hold this absolute path: do not commit them; after moving the project run again with --refresh.`);
}
