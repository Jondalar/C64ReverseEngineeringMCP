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
 * ONE WRITER. The flag that says which side of the process boundary owns the store.
 *
 * `knowledge/artifacts.json` had two writers in two processes: the MCP server's
 * `saveArtifact`, and `registerCliArtifact` in the pipeline child. That is the reason
 * the store needed a cross-process lock at all (BUG-056), and the reason a legacy
 * entity writer could sit in the child for months without anyone noticing (BUG-054).
 * Since BUG-057 every MCP door registers its own outputs from the parent, so on THIS
 * path the child's registration is a second writer with nothing left to write.
 *
 * It is not removed, because the child is also a program in its own right: a shell
 * loop over `dist/pipeline/cli.cjs` has no parent to register for it, and taking the
 * registration away would make those runs invisible to `list_artifacts`, to the views
 * and to the next session that onboards. So the two callers differ by one argument,
 * and the difference is stated here rather than implied:
 *
 *   MCP server → `pipelineArgvFromMcp()` → `--no-register` → the parent registers.
 *   A human at a shell → no flag → the child registers, as it always did.
 *
 * Every spawn out of this file goes through the helper, so the MCP half cannot
 * acquire a second writer by someone forgetting the flag at a new call site.
 */
export const SUPPRESS_CHILD_REGISTRATION = "--no-register";

/**
 * The argv the MCP server spawns the pipeline with — the verb, the suppression flag,
 * then the verb's own arguments. The flag goes in front of the arguments because
 * `consumeRegisterFlags` strips it before the verb sees a positional slot, and a flag
 * at the front cannot be mistaken for one of them.
 */
export function pipelineArgvFromMcp(command: string, args: string[]): string[] {
  return [command, SUPPRESS_CHILD_REGISTRATION, ...args];
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
      // Spec 817/818 D9: the pipeline reads resources/platform-kb.sqlite through
      // node:sqlite, which prints an ExperimentalWarning on first load; the
      // parent forwards child stderr, so the flag keeps tool output clean even
      // if the in-process filter is bypassed.
      // The store's one writer on this path is the PARENT: every argv built here
      // carries `--no-register` (see `pipelineArgvFromMcp` above).
      ["--disable-warning=ExperimentalWarning", cliPath, ...pipelineArgvFromMcp(command, args)],
      {
        cwd: options.projectDir,
        // Spec 759 — the pipeline reads the project's cross-artifact address
        // index from C64RE_PROJECT_DIR; pass it explicitly (don't rely on the
        // parent's env being set).
        env: { ...process.env, C64RE_PROJECT_DIR: options.projectDir },
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
