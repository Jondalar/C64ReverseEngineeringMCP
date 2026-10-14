// Is the compiled pipeline (dist/pipeline/*.cjs) the build of THIS checkout's version?
//
// The MCP server can run from src/ through tsx while every rendering verb still goes through
// the compiled `dist/pipeline/cli.cjs`. After a `git pull` without `npm run build`, the
// server answers with new code and the listing is produced by the old pipeline — and nothing
// says so (issue #71). `scripts/fix-pipeline-ext.mjs` stamps the pipeline directory with the
// package version at build time; this compares that stamp with the package.json next to it.
//
// An npm install ships dist/ built from the same version, so the two always agree there.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The file `scripts/fix-pipeline-ext.mjs` writes next to the compiled pipeline. */
export const PIPELINE_VERSION_STAMP = ".pipeline-version";

/** The version in the package.json of the checkout this module sits in. */
export function serverVersion(packageRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version;
  } catch { return undefined; }
}

/**
 * The warning to show, or undefined when the pipeline build matches the server (or there is
 * nothing to compare: no package.json, or a pipeline that is not this checkout's own build).
 *
 * `pipelineCli` is the compiled `cli.cjs` the server is about to spawn.
 */
export function pipelineBuildWarning(pipelineCli: string, packageRoot: string): string | undefined {
  const server = serverVersion(packageRoot);
  if (!server) return undefined;
  const own = resolve(packageRoot, "dist", "pipeline");
  if (dirname(resolve(pipelineCli)) !== own) return undefined; // an external pipeline carries its own versioning
  const stampPath = join(own, PIPELINE_VERSION_STAMP);
  let built: string | undefined;
  if (existsSync(stampPath)) {
    try { built = readFileSync(stampPath, "utf8").trim(); } catch { built = undefined; }
  }
  if (built === server) return undefined;
  const what = built
    ? `pipeline build is ${built}, server is ${server}`
    : `pipeline build carries no version stamp (built before stamping, or by hand), server is ${server}`;
  return `WARNING: ${what} — run \`npm run build\`. Rendering and analysis run through dist/pipeline, so this answer may come from an older pipeline than the server's code.`;
}
