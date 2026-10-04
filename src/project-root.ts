import { existsSync, statSync, accessSync, realpathSync, constants } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

interface ResolveProjectDirOptions {
  cwd?: string;
  repoDir: string;
  /** A directory the caller NAMED as the project (`project_dir`). Honoured or refused, never swapped. */
  explicitDir?: string;
  /** A file or directory the call works on (`prg_path`, `image_path`, ...). It is not a project name. */
  hintPath?: string;
  /**
   * The project to use when the call names none and the environment names none, and
   * the hint (if any) lies in no project: the one this session onboarded into.
   */
  fallbackDir?: string;
  requireWritable?: boolean;
}

/**
 * Which project a call acts on.
 *
 *  1. `explicitDir` — the caller named a project. It wins over `C64RE_PROJECT_DIR`; a
 *     directory that is not inside a project is refused. There is no fallback from here.
 *  2. `C64RE_PROJECT_DIR` — the default for a call that names no project. A file hint
 *     that lies inside a DIFFERENT project is refused with both roots named, so a file
 *     of project B is never processed into project A by accident. A file outside every
 *     project (input media usually is) is fine.
 *  3. A file hint with no environment project: the project that contains it.
 *  4. `fallbackDir`, then the project containing the cwd.
 */
export function resolveProjectDir(options: ResolveProjectDirOptions): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const requireWritable = options.requireWritable ?? false;
  const validate = (root: string, source: string): string => validateProjectDir(root, {
    source,
    repoDir: options.repoDir,
    requireWritable,
    requireKnowledgeMarker: true,
  });

  const explicit = options.explicitDir?.trim();
  if (explicit) {
    const named = resolve(cwd, explicit);
    const root = findProjectRoot(named);
    if (!root) {
      throw new Error(buildProjectDirError(
        named,
        `project_dir ${explicit}`,
        "No project marker (knowledge/phase-plan.json or knowledge/workflow-state.json) in this directory or any parent. A named project is never swapped for another: run project_init there, or name the right directory.",
      ));
    }
    return validate(root, `project_dir ${explicit}`);
  }

  const hint = options.hintPath?.trim();
  const hintFound = hint ? findProjectRoot(deriveProjectSearchStart(hint, cwd)) : undefined;
  // The MCP repo carries a marker of its own, but validateProjectDir refuses it as a
  // project: it is no project, so a sample or fixture inside it is a file outside every
  // project and is not "another project's file".
  const hintRoot = hintFound && !samePath(hintFound, options.repoDir) && hintFound !== "/" ? hintFound : undefined;

  const envProjectDir = process.env.C64RE_PROJECT_DIR?.trim();
  if (envProjectDir) {
    const root = findProjectRoot(resolve(envProjectDir)) ?? resolve(envProjectDir);
    // A relative hint is relative to the project (callers resolve it that way), so only an
    // absolute one says anything about where the file lives.
    if (hint && hintRoot && isAbsolute(hint) && !samePath(hintRoot, root)) {
      throw new Error(
        `c64re refuses: ${hint} lies inside the project ${hintRoot}, but this call names no project and C64RE_PROJECT_DIR is ${root}. `
        + `Processing a file of one project into another is never done silently. Pass project_dir="${hintRoot}" to work in that project, `
        + `or copy the file out of it.`,
      );
    }
    return validate(root, "C64RE_PROJECT_DIR");
  }

  if (hint) {
    if (hintFound) return validate(hintFound, `hint path ${hint}`);
    if (options.fallbackDir) return validate(options.fallbackDir, "the project this session onboarded into");
    throw new Error(buildProjectDirError(
      deriveProjectSearchStart(hint, cwd),
      `hint path ${hint}`,
      "No existing project marker found while walking parents. Run project_init at the project root or pass project_dir/C64RE_PROJECT_DIR.",
    ));
  }

  if (options.fallbackDir) return validate(options.fallbackDir, "the project this session onboarded into");

  const root = findProjectRoot(cwd);
  if (!root) {
    throw new Error(buildProjectDirError(
      cwd,
      "process.cwd()",
      "No existing project marker found while walking parents. Run project_init at the project root or configure C64RE_PROJECT_DIR.",
    ));
  }
  return validate(root, "process.cwd()");
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
  const na = real(a), nb = real(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
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
