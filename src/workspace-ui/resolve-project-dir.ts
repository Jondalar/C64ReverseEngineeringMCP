// Spec 724.3 — the ONE project-path resolver, shared by the workspace HTTP
// server and the runtime WS bootstrap. The MCP must be usable from OUTSIDE the
// C64RE dev repo, so there is NO `process.cwd()` fallback: a project path is
// required and resolved explicitly.
//
// Precedence: `--project <dir>` (argv) > `C64RE_PROJECT_DIR` (env) > hard error.
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

/**
 * Resolve the project directory from argv + env, or throw. Never falls back to
 * cwd (that silently "projects" whatever directory the process happens to run
 * in — the root of the cross-project drift bug).
 */
export function resolveProjectDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  let raw: string | undefined;
  const flagIndex = argv.indexOf("--project");
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    raw = argv[flagIndex + 1];
  } else if (env.C64RE_PROJECT_DIR && env.C64RE_PROJECT_DIR.trim()) {
    raw = env.C64RE_PROJECT_DIR;
  }
  if (!raw) {
    throw new Error(
      "No project directory. Pass `--project <dir>` or set C64RE_PROJECT_DIR. "
      + "There is no cwd fallback (Spec 724.3 — the workspace must be explicit "
      + "about which project it serves).",
    );
  }
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Project directory not found or not a directory: ${dir}`);
  }
  return dir;
}

/** `--dev-samples` opt-in: include the repo's top-level `samples/` in media
 * scans (dev convenience). Off by default — production media comes from the
 * project directory only. */
export function hasDevSamples(argv: readonly string[]): boolean {
  return argv.includes("--dev-samples");
}
