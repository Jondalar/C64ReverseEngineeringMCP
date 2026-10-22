// A temp root that lies inside NO project. findProjectRoot walks up to "/", so a stray
// knowledge/phase-plan.json (or workflow-state.json) in $TMPDIR or /tmp — left there by any
// run that was ever pointed at the temp dir itself — turns every mkdtemp below it into a
// project, and every test whose point is "this lies in no project" fails for a reason
// that is not the product's. Tests that need a project-free directory take it from here.
// The stray markers are named, never deleted: they are not ours to remove.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

// ---- Scratch that removes itself ------------------------------------------------------------
// Every test that needs a scratch directory takes it from testTmpDir(): a mkdtemp under the
// project-free root, removed when the process ends — normal exit, process.exit(), an uncaught
// exception or rejection, SIGINT, SIGTERM, SIGHUP. Only SIGKILL leaves one behind.
// C64RE_KEEP_TEST_TMP=1 keeps them and prints where, for debugging a failure.
// scripts/check-test-tmp.mjs fails any script that calls mkdtemp outside this file.
const owned = new Set();
let hooked = false;

function removeOwned() {
  const keep = process.env.C64RE_KEEP_TEST_TMP === "1";
  for (const d of owned) {
    if (keep) { try { console.error(`C64RE_KEEP_TEST_TMP: kept ${d}`); } catch { /* stderr gone */ } continue; }
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort at exit */ }
  }
  owned.clear();
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on("exit", removeOwned);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => { removeOwned(); process.exit(code); });
  }
}

/** A fresh directory `<root>/<prefix>XXXXXX`, gone when this process is. Returns its real path. */
export function testTmpDir(prefix = "c64re-test-") {
  hook();
  const d = realpathSync(mkdtempSync(join(neutralTmpRoot(), prefix)));
  owned.add(d);
  return d;
}

/** Register a directory or file this process created some other way, so it goes at exit too. */
export function testTmpAdopt(path) {
  hook();
  owned.add(path);
  return path;
}
