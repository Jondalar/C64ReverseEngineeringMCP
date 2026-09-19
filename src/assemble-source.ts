import { execFile } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedAssembler = "kickassembler" | "64tass";
export type AssemblerSelection = SupportedAssembler | "auto";

export interface AssembleSourceOptions {
  projectDir: string;
  sourcePath: string;
  assembler: AssemblerSelection;
  outputPath?: string;
  compareToPath?: string;
  /**
   * Spec 804 — also write the build's symbol file, `<output stem>.vs` (VICE label
   * format: KickAssembler `-vicesymbols`, 64tass `--vice-labels -l`). It is what the
   * `build` name layer reads: only the build knows where a name landed.
   */
  symbols?: boolean;
}

export interface AssembleSourceResult {
  assembler: SupportedAssembler;
  sourcePath: string;
  outputPath: string;
  /** Spec 804 — the symbol file, when asked for and written */
  symbolsPath?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  compareToPath?: string;
  compareMatches?: boolean;
  comparedBytes?: number;
  firstDiffOffset?: number;
}

export async function assembleSource(options: AssembleSourceOptions): Promise<AssembleSourceResult> {
  const sourcePath = resolve(options.projectDir, options.sourcePath);
  const assembler = resolveAssemblerSelection(options.assembler, sourcePath);
  const outputPath = resolve(
    options.projectDir,
    options.outputPath ?? defaultOutputPathForSource(sourcePath),
  );

  const symbolsPath = options.symbols ? symbolPathForOutput(outputPath) : undefined;
  const run = assembler === "kickassembler"
    ? await runKickAssembler(options.projectDir, sourcePath, outputPath, symbolsPath)
    : await run64tass(options.projectDir, sourcePath, outputPath, symbolsPath);

  const result: AssembleSourceResult = {
    assembler,
    sourcePath,
    outputPath,
    ...(symbolsPath && run.exitCode === 0 && existsSync(symbolsPath) ? { symbolsPath } : {}),
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
  };

  if (run.exitCode !== 0 || !options.compareToPath) {
    return result;
  }

  const compareToPath = resolve(options.projectDir, options.compareToPath);
  const compare = await compareBinaryFiles(outputPath, compareToPath);
  return {
    ...result,
    compareToPath,
    compareMatches: compare.matches,
    comparedBytes: compare.comparedBytes,
    firstDiffOffset: compare.firstDiffOffset,
  };
}

function resolveAssemblerSelection(selection: AssemblerSelection, sourcePath: string): SupportedAssembler {
  if (selection !== "auto") {
    return selection;
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".tas" || extension === ".tass") {
    return "64tass";
  }
  if (extension === ".asm") {
    return "kickassembler";
  }
  throw new Error(`Cannot auto-select assembler for ${sourcePath}. Use assembler=\"kickassembler\" or assembler=\"64tass\".`);
}

function defaultOutputPathForSource(sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".asm" || extension === ".tas" || extension === ".tass") {
    return sourcePath.slice(0, -extension.length) + ".prg";
  }
  return `${sourcePath}.prg`;
}

/** `<output stem>.vs` — the build layer finds the output PRG by the same stem. */
export function symbolPathForOutput(outputPath: string): string {
  const ext = extname(outputPath);
  return `${ext ? outputPath.slice(0, -ext.length) : outputPath}.vs`;
}

async function runKickAssembler(projectDir: string, sourcePath: string, outputPath: string, symbolsPath?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const jarPath = resolveKickAssemblerJarPath();
  const run = await execTool(
    "/usr/bin/java",
    ["-jar", jarPath, sourcePath, "-o", outputPath, ...(symbolsPath ? ["-vicesymbols"] : [])],
    projectDir,
  );
  if (symbolsPath && run.exitCode === 0) {
    // Measured: KickAssembler writes `<SOURCE stem>.vs` next to the OUTPUT, and has no
    // flag to name it. Moved to `<output stem>.vs` so the pair is found by one rule.
    const sourceStem = basename(sourcePath).replace(/\.[^.]+$/u, "");
    const written = join(dirname(outputPath), `${sourceStem}.vs`);
    if (written !== symbolsPath && existsSync(written)) renameSync(written, symbolsPath);
  }
  return run;
}

async function run64tass(projectDir: string, sourcePath: string, outputPath: string, symbolsPath?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binaryPath = resolve64tassBinaryPath();
  return execTool(
    binaryPath,
    ["-a", "-B", "-o", outputPath, ...(symbolsPath ? ["--vice-labels", "-l", symbolsPath] : []), sourcePath],
    projectDir,
  );
}

function execTool(binary: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      args,
      {
        cwd,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? 1 : 0,
        });
      },
    );
  });
}

function resolveKickAssemblerJarPath(): string {
  const candidates = [
    process.env.C64RE_KICKASS_JAR,
    "/Applications/KickAssembler/KickAss.jar",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error("KickAssembler jar not found. Set C64RE_KICKASS_JAR or install KickAssembler in /Applications/KickAssembler/KickAss.jar.");
}

function resolve64tassBinaryPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(thisDir, "..");
  const candidates = [
    process.env.C64RE_64TASS_BIN,
    "/opt/homebrew/bin/64tass",
    "/usr/local/bin/64tass",
    ...resolveFromPath("64tass"),
    resolve(projectRoot, "node_modules", ".bin", "64tass"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error("64tass not found. Set C64RE_64TASS_BIN or install 64tass (for example with Homebrew).");
}

function resolveFromPath(binaryName: string): string[] {
  const pathValue = process.env.PATH ?? "";
  return pathValue.split(":").filter(Boolean).map((entry) => `${entry}/${binaryName}`);
}

async function compareBinaryFiles(leftPath: string, rightPath: string): Promise<{
  matches: boolean;
  comparedBytes: number;
  firstDiffOffset?: number;
}> {
  const [left, right] = await Promise.all([
    readFile(leftPath),
    readFile(rightPath),
  ]);
  const comparedBytes = Math.min(left.length, right.length);
  for (let index = 0; index < comparedBytes; index += 1) {
    if (left[index] !== right[index]) {
      return {
        matches: false,
        comparedBytes,
        firstDiffOffset: index,
      };
    }
  }
  if (left.length !== right.length) {
    return {
      matches: false,
      comparedBytes,
      firstDiffOffset: comparedBytes,
    };
  }
  return {
    matches: true,
    comparedBytes: left.length,
  };
}
