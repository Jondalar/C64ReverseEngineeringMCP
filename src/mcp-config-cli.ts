// `c64re mcp-config [--project <dir>] [--print]` — the same writer project_init uses, for a
// project that already exists. No MCP server is running here, so there is no "running
// server" to copy: this CLI process describes ITS OWN launch (how it was started) and
// takes the carried C64RE_* variables from its own environment.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildServerEntry, checkMcpConfig, describeFailure, describeLaunch, standaloneConfig, writeMcpConfig,
} from "./project-knowledge/mcp-config.js";

const USAGE = "Usage: c64re mcp-config [--project <dir>] [--print]";

interface Options { projectDir: string; print: boolean }

function parseArgs(args: string[]): Options {
  let projectDir = process.cwd();
  let print = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--print") print = true;
    else if (arg === "--project") {
      const v = args[++i];
      if (!v) throw new Error(`--project needs a directory.\n${USAGE}`);
      projectDir = resolve(v);
    } else if (arg.startsWith("--project=")) projectDir = resolve(arg.slice("--project=".length));
    else throw new Error(`Unknown argument '${arg}'.\n${USAGE}`);
  }
  return { projectDir, print };
}

export async function runMcpConfig(rawArgs: string[]): Promise<void> {
  const opts = parseArgs(rawArgs);
  const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = buildServerEntry({
    projectDir: opts.projectDir,
    launch: describeLaunch({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, repoDir }),
    env: process.env,
  });
  if (opts.print) {
    process.stdout.write(standaloneConfig(entry));
    return;
  }
  if (!existsSync(opts.projectDir) || !statSync(opts.projectDir).isDirectory()) {
    throw new Error(`Project directory does not exist: ${opts.projectDir}`);
  }
  const outcome = writeMcpConfig(opts.projectDir, entry);
  if (outcome.kind === "refused") {
    process.exitCode = 1;
    throw new Error(`${describeFailure(outcome.path, outcome.failure)} Nothing was written. Fix the file, or delete it and run this again.`);
  }
  process.stdout.write(`c64re mcp-config: ${outcome.path} ${outcome.kind}\n`);
  for (const w of checkMcpConfig(opts.projectDir)) process.stdout.write(`${w}\n`);
}
