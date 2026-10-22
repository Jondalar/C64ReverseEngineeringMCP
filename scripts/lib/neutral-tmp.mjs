// A temp root that lies inside NO project. findProjectRoot walks up to "/", so a stray
// knowledge/phase-plan.json (or workflow-state.json) in $TMPDIR or /tmp — left there by any
// run that was ever pointed at the temp dir itself — turns every mkdtemp below it into a
// project, and every test whose point is "this lies in no project" fails for a reason
// that is not the product's. Tests that need a project-free directory take it from here.
// The stray markers are named, never deleted: they are not ours to remove.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function markerAbove(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, "knowledge", "phase-plan.json")) || existsSync(join(cur, "knowledge", "workflow-state.json"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

let cached;
export function neutralTmpRoot() {
  if (cached) return cached;
  const candidates = [realpathSync(tmpdir()), join(homedir(), ".cache", "c64re-tests")];
  const stray = [];
  for (const c of candidates) {
    mkdirSync(c, { recursive: true });
    const m = markerAbove(c);
    if (!m) {
      if (stray.length) console.error(`note: ${stray.join(", ")} hold a project marker (knowledge/phase-plan.json); using ${c} as the temp root so the tests stay project-free`);
      return (cached = realpathSync(c));
    }
    stray.push(m);
  }
  throw new Error(`no project-free temp root: markers at ${stray.join(", ")}`);
}
