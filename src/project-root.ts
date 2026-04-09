import { existsSync, statSync, accessSync, constants } from "node:fs";
import { dirname, extname, resolve } from "node:path";

interface ResolveProjectDirOptions {
  cwd?: string;
  repoDir: string;
  hintPath?: string;
  requireWritable?: boolean;
}

export function resolveProjectDir(options: ResolveProjectDirOptions): string {
  const envProjectDir = process.env.C64RE_PROJECT_DIR?.trim();
  if (envProjectDir) {
    return validateProjectDir(resolve(envProjectDir), {
      source: "C64RE_PROJECT_DIR",
      repoDir: options.repoDir,
      requireWritable: options.requireWritable ?? false,
    });
  }

  if (options.hintPath) {
    const derived = deriveProjectDirFromHint(options.hintPath, options.cwd ?? process.cwd());
    return validateProjectDir(derived, {
      source: `hint path ${options.hintPath}`,
      repoDir: options.repoDir,
      requireWritable: options.requireWritable ?? false,
    });
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  return validateProjectDir(cwd, {
    source: "process.cwd()",
    repoDir: options.repoDir,
    requireWritable: options.requireWritable ?? false,
  });
}

function deriveProjectDirFromHint(hintPath: string, cwd: string): string {
  const resolvedHint = resolve(cwd, hintPath);
  if (existsSync(resolvedHint) && statSync(resolvedHint).isDirectory()) {
    return resolvedHint;
  }

  if (extname(resolvedHint)) {
    return dirname(resolvedHint);
  }

  return dirname(resolvedHint);
}

function validateProjectDir(
  projectDir: string,
  options: {
    source: string;
    repoDir: string;
    requireWritable: boolean;
  },
): string {
  if (projectDir === "/") {
    throw new Error(buildProjectDirError(projectDir, options.source, "Resolved to '/'. Configure C64RE_PROJECT_DIR or provide a path-based tool input."));
  }
  if (projectDir === resolve(options.repoDir)) {
    throw new Error(buildProjectDirError(projectDir, options.source, "Resolved to the MCP repo itself. Configure C64RE_PROJECT_DIR or run the MCP from a target project workspace."));
  }
  if (!existsSync(projectDir)) {
    throw new Error(buildProjectDirError(projectDir, options.source, "Directory does not exist."));
  }
  if (!statSync(projectDir).isDirectory()) {
    throw new Error(buildProjectDirError(projectDir, options.source, "Resolved path is not a directory."));
  }
  if (options.requireWritable) {
    try {
      accessSync(projectDir, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(buildProjectDirError(projectDir, options.source, "Directory is not writable."));
    }
  }
  return projectDir;
}

function buildProjectDirError(projectDir: string, source: string, details: string): string {
  return `c64re requires a valid project directory. Resolved projectDir = "${projectDir}" from ${source}. ${details}`;
}
