// build_tools runs npm without a shell on every platform: npm-cli.js by this Node where it can be
// found, plain `npm` only on macOS/Linux, and on Windows a clear refusal instead of EINVAL.
import { execFileSync } from "node:child_process";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { findNpmCli } = await import(pathToFileURL(join(ROOT, "dist/lib/npm-cli.js")).href);

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); }
};
const has = (set) => (p) => set.has(p);

console.log("npm without a shell\n");
const win = findNpmCli({}, "C:\\node\\node.exe", "win32", has(new Set([win32.join("C:\\node", "node_modules", "npm", "bin", "npm-cli.js")])));
check(win?.cmd === "C:\\node\\node.exe" && /npm-cli\.js$/.test(win.prefix[0] ?? ""), "Windows: npm-cli.js beside node.exe, run by node.exe", JSON.stringify(win));
check(findNpmCli({}, "C:\\node\\node.exe", "win32", () => false) === undefined, "Windows: nothing found → undefined, never bare npm");
const viaEnv = findNpmCli({ npm_execpath: "/x/npm/bin/npm-cli.js" }, "/usr/bin/node", "linux", (p) => p === "/x/npm/bin/npm-cli.js");
check(viaEnv?.prefix[0] === "/x/npm/bin/npm-cli.js", "npm_execpath wins when it is npm-cli.js");
const yarn = findNpmCli({ npm_execpath: "/x/yarn.js" }, "/usr/bin/node", "linux", (p) => p === "/x/yarn.js");
check(yarn?.cmd === "npm", "npm_execpath naming yarn is not taken for npm");
check(findNpmCli({}, "/usr/bin/node", "darwin", () => false)?.cmd === "npm", "macOS/Linux: plain npm as the last resort");

// The real thing, on whatever platform this runs: the command found here answers `--version`.
const real = findNpmCli();
check(real !== undefined, "this machine: npm found");
if (real) {
  let out = "";
  try { out = execFileSync(real.cmd, [...real.prefix, "--version"], { encoding: "utf8", windowsHide: true }).trim(); } catch (e) { out = String(e); }
  check(/^\d+\.\d+\.\d+/.test(out), "this machine: it runs, with no shell", out);
}

console.log(`\n${fail ? "RED" : "GREEN"} npm-cli: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
