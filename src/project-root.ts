import { existsSync, statSync, accessSync, constants } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

interface ResolveProjectDirOptions {
  cwd?: string;
  repoDir: string;
  hintPath?: string;
  requireWritable?: boolean;
}

export function resolveProjectDir(options: ResolveProjectDirOptions): string {
  const envProjectDir = process.env.C64RE_PROJECT_DIR?.trim();
  if (envProjectDir) {
    const root = findProjectRoot(resolve(envProjectDir)) ?? resolve(envProjectDir);
    return validateProjectDir(root, {
      source: "C64RE_PROJECT_DIR",
      repoDir: options.repoDir,
      requireWritable: options.requireWritable ?? false,
      requireKnowledgeMarker: true,
    });
  }

  if (options.hintPath) {
    const derived = deriveProjectSearchStart(options.hintPath, options.cwd ?? process.cwd());
    const root = findProjectRoot(derived);
    if (!root) {
      throw new Error(buildProjectDirError(
        derived,
        `hint path ${options.hintPath}`,
        "No existing project marker found while walking parents. Run project_init at the project root or pass project_dir/C64RE_PROJECT_DIR.",
      ));
    }
    return validateProjectDir(root, {
      source: `hint path ${options.hintPath}`,
      repoDir: options.repoDir,
      requireWritable: options.requireWritable ?? false,
      requireKnowledgeMarker: true,
    });
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const root = findProjectRoot(cwd);
  if (!root) {
    throw new Error(buildProjectDirError(
      cwd,
      "process.cwd()",
      "No existing project marker found while walking parents. Run project_init at the project root or configure C64RE_PROJECT_DIR.",
    ));
  }
  return validateProjectDir(root, {
    source: "process.cwd()",
    repoDir: options.repoDir,
    requireWritable: options.requireWritable ?? false,
    requireKnowledgeMarker: true,
  });
}

export function hasProjectMarker(projectDir: string): boolean {
  return existsSync(join(projectDir, "knowledge", "phase-plan.json"))
    || existsSync(join(projectDir, "knowledge", "workflow-state.json"));
}

export function findProjectRoot(startPath: string): string | undefined {
  let current = resolve(startPath);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }

  while (true) {
    if (hasProjectMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function deriveProjectSearchStart(hintPath: string, cwd: string): string {
  const resolvedHint = resolve(cwd, hintPath);
  if (existsSync(resolvedHint) && statSync(resolvedHint).isDirectory()) {
    return resolvedHint;
  }

  if (extname(resolvedHint)) {
    return dirname(resolvedHint);
  }

  return resolvedHint;
}

function validateProjectDir(
  projectDir: string,
  options: {
    source: string;
    repoDir: string;
    requireWritable: boolean;
    requireKnowledgeMarker: boolean;
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
  if (options.requireKnowledgeMarker && !hasProjectMarker(projectDir)) {
    throw new Error(buildProjectDirError(projectDir, options.source, "Directory is not an initialized c64re project (missing knowledge/phase-plan.json or knowledge/workflow-state.json)."));
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
