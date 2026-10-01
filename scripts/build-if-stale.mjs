#!/usr/bin/env node
// Spec 885 D6 — `npm run build:mcp` only when src/ changed since the last build.
//
// The workspace launchers (ui.sh / ui.ps1 / `npm run workspace`) compiled the
// backend on every start: ~11 s of tsc before the server listens, for a checkout
// that had not changed. This compares the newest file under src/ (plus
// tsconfig.json and package.json) with a stamp written after the last successful
// build, and runs the build only when something is newer — or when dist/ is
// missing. `--force` always builds.
//
//   node scripts/build-if-stale.mjs [--force]

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = join(repo, "dist", ".build-mcp.stamp");
const server = join(repo, "dist", "workspace-ui", "server.js");

function newestUnder(dir) {
  let newest = 0;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestUnder(full));
    else if (e.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

const sourceNewest = Math.max(
  newestUnder(join(repo, "src")),
  ...["tsconfig.json", "package.json"].map((f) => (existsSync(join(repo, f)) ? statSync(join(repo, f)).mtimeMs : 0)),
);
const builtAt = existsSync(stamp) && existsSync(server) ? statSync(stamp).mtimeMs : 0;

if (!process.argv.includes("--force") && builtAt > 0 && sourceNewest <= builtAt) {
  console.log("[build-if-stale] dist/ is up to date with src/ - no rebuild");
  process.exit(0);
}

console.log(builtAt === 0 ? "[build-if-stale] no build stamp - building (npm run build:mcp)" : "[build-if-stale] src/ changed since the last build - building (npm run build:mcp)");
// one command string through the shell: npm is a .cmd on Windows, and passing
// args separately with shell:true is deprecated (DEP0190)
const r = spawnSync("npm run build:mcp", { cwd: repo, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(stamp, `${new Date().toISOString()}\n`);
