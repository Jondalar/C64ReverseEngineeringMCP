// How C64RE runs npm, on every platform, with no shell.
//
// `execFile("npm", …)` works on macOS and Linux and fails on Windows: there npm is `npm.cmd`,
// a batch file, and Node refuses to spawn a batch file without a shell (the BatBadBut fix,
// EINVAL). Starting it through a shell would trade that for quoting, and a path with a space breaks
// silently. So npm is run as what it is underneath: npm-cli.js, run by this Node.
//
// Where npm-cli.js is:
//   - `npm_execpath`, when an npm script started us (it points at npm-cli.js);
//   - next to this Node: `<dir of node>/node_modules/npm/bin/npm-cli.js` on Windows,
//     `<dir of node>/../lib/node_modules/npm/bin/npm-cli.js` on macOS and Linux
//     (nvm, the official installers, Homebrew);
//   - otherwise plain `npm` on macOS and Linux, where it is a real executable on PATH.
// On Windows with none of those found, the result says so instead of failing with EINVAL.

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface NpmCommand {
  /** The program to start: this Node, or `npm` itself on POSIX. */
  readonly cmd: string;
  /** The arguments in front of the npm arguments (npm-cli.js when run by Node). */
  readonly prefix: readonly string[];
}

export function findNpmCli(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): NpmCommand | undefined {
  // The platform's own path rules, so a Windows path is read as one wherever this runs.
  const { basename, dirname, join } = platform === "win32" ? win32 : posix;
  const fromEnv = env.npm_execpath;
  // npm_execpath can name yarn or pnpm when one of them started us; only npm-cli.js is npm.
  if (fromEnv && /npm-cli\.c?js$/.test(basename(fromEnv)) && exists(fromEnv)) {
    return { cmd: execPath, prefix: [fromEnv] };
  }
  const nodeDir = dirname(execPath);
  const candidates = platform === "win32"
    ? [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
    : [join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
       join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")];
  for (const c of candidates) if (exists(c)) return { cmd: execPath, prefix: [c] };
  if (platform !== "win32") return { cmd: "npm", prefix: [] };
  return undefined;
}

export const NPM_NOT_FOUND =
  "npm was not found next to this Node (no node_modules/npm/bin/npm-cli.js beside node.exe, and no npm_execpath). " +
  "Run `npm run build` in that directory yourself, or start C64RE from an npm script.";
