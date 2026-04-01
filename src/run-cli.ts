import { execFile } from "node:child_process";
import { resolve } from "node:path";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the TRXDis CLI with the given command and args.
 *
 * Requires C64RE_TOOLS_DIR env var pointing to the TRXDis project root
 * (i.e. the directory containing dist/cli.js).
 */
export function runCli(command: string, args: string[]): Promise<CliResult> {
  const toolsDir = process.env.C64RE_TOOLS_DIR;
  if (!toolsDir) {
    return Promise.resolve({
      stdout: "",
      stderr: "C64RE_TOOLS_DIR environment variable is not set. Point it to the TRXDis project root (containing dist/cli.js).",
      exitCode: 1,
    });
  }

  const cliPath = resolve(toolsDir, "dist", "cli.js");

  return new Promise((res) => {
    execFile(
      "node",
      [cliPath, command, ...args],
      {
        cwd: process.env.C64RE_PROJECT_DIR ?? toolsDir,
        maxBuffer: 50 * 1024 * 1024, // 50 MB — analysis JSONs can be large
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        res({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code === undefined ? 1 : 1 : 0,
        });
      },
    );
  });
}
