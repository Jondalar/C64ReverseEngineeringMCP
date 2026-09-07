#!/usr/bin/env node
// Spec 831 — a dump lands in the project, and the button says so.
//
// Hermetic: a temp project, the path library, the route, and the two call
// sites read as source. No daemon, no ROMs, no network — the whole point is
// that the path policy is decided on THIS side, so it can be checked here.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:831

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 831 — where a dump lands, and what the button says\n");

const { dumpDirForProject, dumpTargetFor, ensureDumpDir, sanitizeDumpLabel } =
  await import(join(ROOT, "dist/runtime/dump-location.js"));

const project = mkdtempSync(join(tmpdir(), "c64re-831-"));

// ------------------------------------------------------------ D1 the location
const target = dumpTargetFor(project, "dump", 1788688201142, "ab12");
check(isAbsolute(target.path), "the path is ABSOLUTE — the daemon's working directory is not the project's, which is the whole defect");
check(target.path.startsWith(resolve(project) + sep), `it is inside the project (${target.relativePath})`);
check(target.relativePath === "runtime/dumps/dump-1788688201142-ab12.c64re", `the project-relative form is what the UI shows: ${target.relativePath}`);
check(!target.relativePath.startsWith(".."), "…and it never climbs out of the project");
check(target.path.endsWith(".c64re"), "the extension is .c64re");
check(dumpDirForProject(project) === join(resolve(project), "runtime", "dumps"), "the directory is <project>/runtime/dumps — beside 827's runtime/traces.json pointer");

// --------------------------------------------------------- names cannot collide
const a = dumpTargetFor(project, "dump", 1788688201142);
const b = dumpTargetFor(project, "dump", 1788688201142);
check(a.path !== b.path, "two dumps in the SAME millisecond get different names (a bare timestamp allows a collision)");

// ------------------------------------------------------ a label cannot escape
for (const [label, why] of [["../../etc/passwd", "a traversal"], ["scrub cp/3280224", "a slash and a space"], ["", "an empty label"], ["...", "dots only"]]) {
  const t = dumpTargetFor(project, label, 1, "zz");
  check(t.path.startsWith(dumpDirForProject(project) + sep), `${why} cannot escape the dump directory (${label || "<empty>"} → ${t.name})`);
  check(!t.name.includes("/") && !t.name.includes("\\") && !t.name.includes(".."), `…and produces a plain filename: ${t.name}`);
}
check(sanitizeDumpLabel("scrub-cp_67174_2691") === "scrub-cp_67174_2691", "a well-formed label survives unchanged");

// --------------------------------------------------------------- the directory
check(!existsSync(dumpDirForProject(project)), "the directory does not exist before it is asked for");
const dir = ensureDumpDir(project);
check(existsSync(dir), "ensureDumpDir creates <project>/runtime/dumps");
check(ensureDumpDir(project) === dir, "…and is idempotent");

// ------------------------------------------------------------------- the route
const serverSrc = readFileSync(join(ROOT, "src/workspace-ui/server.ts"), "utf8");
check(/\/api\/runtime\/dump-target/.test(serverSrc), "the server exposes GET /api/runtime/dump-target — rule 6: library, route, then a button");
check(/ensureDumpDir\(projectDir\)/.test(serverSrc), "the route creates the directory before it answers, so the daemon's write cannot fail on a missing path");
check(/syncWarning\(/.test(serverSrc), "a project inside a sync client gets a NOTE (D6) — 827's detector, reused");

// ---------------------------------------------------------- the two call sites
const controls = readFileSync(join(ROOT, "ui/src/workbench/components/MachineControls.tsx"), "utf8");
const filmstrip = readFileSync(join(ROOT, "ui/src/workbench/components/Filmstrip.tsx"), "utf8");
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const controlsCode = codeOnly(controls);
const filmstripCode = codeOnly(filmstrip);

for (const [name, code] of [["MachineControls", controlsCode], ["Filmstrip", filmstripCode]]) {
  check(/api\.dumpTarget\(/.test(code), `${name} asks the server for the path`);
  check(/path: target\.path/.test(code), `${name} sends the ABSOLUTE path to snapshot/dump`);
  check(!/`dumps\/[^`]*\.c64re`/.test(code), `${name} builds no relative dumps/… path any more — that was the defect`);
  check(/setDumpMsg\(/.test(code), `${name} reports the outcome in the DOM`);
  check(/dump failed/.test(code), `${name} reports a FAILURE too — silence was why this went unnoticed for two months`);
  check(!/console\.log\("dump/.test(code) && !/console\.error\("dump/.test(code), `${name} does not answer into the console`);
}

// D4 — a failed dump takes no screenshot
const snapshotFn = controlsCode.slice(controlsCode.indexOf("const snapshot = async"), controlsCode.indexOf("const [tracing"));
const catchAt = snapshotFn.indexOf("} catch");
check(catchAt > 0 && snapshotFn.indexOf("onSnapshotTaken()") < catchAt, "onSnapshotTaken() is inside the SUCCESS path — a filmstrip frame is a claim that something was captured (D4)");

rmSync(project, { recursive: true, force: true });
console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 831: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
