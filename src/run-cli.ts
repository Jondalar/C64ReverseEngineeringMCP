import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunCliOptions {
  projectDir: string;
}

/**
 * Run the TRXDis CLI with the given command and args.
 *
 * Uses the bundled pipeline at dist/pipeline/cli.js by default.
 * Falls back to C64RE_TOOLS_DIR if set (for development against an external pipeline).
 */
export function runCli(command: string, args: string[], options: RunCliOptions): Promise<CliResult> {
  // 1. Try bundled pipeline (dist/pipeline/cli.js relative to project root)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(thisDir, "..");
  // Works both when running via tsx (thisDir=src/) and compiled (thisDir=dist/)
  const bundledCli = existsSync(resolve(projectRoot, "dist", "pipeline", "cli.cjs"))
    ? resolve(projectRoot, "dist", "pipeline", "cli.cjs")
    : resolve(projectRoot, "pipeline", "dist", "cli.cjs");

  // 2. Fall back to external C64RE_TOOLS_DIR
  const externalCli = process.env.C64RE_TOOLS_DIR
    ? resolve(process.env.C64RE_TOOLS_DIR, "dist", "cli.js")
    : undefined;

  const cliPath = existsSync(bundledCli) ? bundledCli
    : externalCli && existsSync(externalCli) ? externalCli
    : undefined;

  if (!cliPath) {
    return Promise.resolve({
      stdout: "",
      stderr: `TRXDis pipeline not found. Expected at:\n  ${bundledCli}\nor set C64RE_TOOLS_DIR to an external TRXDis project root.`,
      exitCode: 1,
    });
  }

  return new Promise((res) => {
    execFile(
      "node",
      [cliPath, command, ...args],
      {
        cwd: options.projectDir,
        maxBuffer: 50 * 1024 * 1024, // 50 MB — analysis JSONs can be large
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        res({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? 1 : 0,
        });
      },
    );
  });
}
