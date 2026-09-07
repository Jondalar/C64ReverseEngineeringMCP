#!/usr/bin/env node
// Spec 830 D4/D5 — `graph seed` walks no mirror, and refuses a duplicate owner.
//
// Hermetic: a temp project, a 40-byte PRG, the bundled analyzer, and the graph
// CLI. No ROMs, no media, no runtime daemon.
//
// The defect this guards: the owner comes from the file STEM, `findAnalysisJsons`
// walked the whole project, and `artifacts/generated/payloads/<id>/` holds a
// COPY of every registered analysis. `"…/analysis/…"` sorts before
// `"…/artifacts/…"`, the replacement unit is (producer, run_owner), so a STALE
// mirror was written last and won — silently. Measured on Neuromancer: owner
// 02_a seeded once with routines=14 and once with routines=8, and the graph
// kept the 8.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:830-seed

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 830 — the seed that ran twice\n");

const pipelineCli = join(ROOT, "dist/pipeline/cli.cjs");
const graphCli = join(ROOT, "dist/cli.js");
if (!existsSync(pipelineCli) || !existsSync(graphCli)) { console.error("not built — run npm run build"); process.exit(2); }

const project = mkdtempSync(join(tmpdir(), "c64re-830-seed-"));
const payloads = join(project, "analysis", "payloads");
mkdirSync(payloads, { recursive: true });
mkdirSync(join(project, "knowledge"), { recursive: true });
// the graph derives its ids from the slug, so the CLI insists on this file
writeFileSync(join(project, "knowledge", "project.json"), JSON.stringify({
  schemaVersion: 1, id: "project-spec830-gate", name: "Spec 830 gate", slug: "spec830",
  description: "temp project for the Spec 830 seed gate", rootPath: project,
}, null, 2));

// a small routine so the seed has something to find: jsr, branch, rts
const LOAD = 0x0801;
const CODE = [0x20, 0x08, 0x08, 0xa9, 0x01, 0xd0, 0xfb, 0x60, 0xa5, 0x02, 0x8d, 0x20, 0xd0, 0x60];
const prg = join(payloads, "widget.prg");
writeFileSync(prg, Buffer.from([LOAD & 0xff, LOAD >> 8, ...CODE]));
const canonical = join(payloads, "widget_analysis.json");
execFileSync(process.execPath, [pipelineCli, "analyze-prg", prg, canonical, "0801", "--no-register"], { stdio: "pipe" });
check(existsSync(canonical), "the canonical analysis/ file exists");

const seed = () => {
  try {
    return { okRun: true, out: execFileSync(process.execPath, [graphCli, "graph", "seed", "--project", project], { stdio: "pipe" }).toString() };
  } catch (e) {
    return { okRun: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

// ---------------------------------------------------------- the baseline
const first = seed();
check(first.okRun, "a project with one analysis file seeds");
check((first.out.match(/^widget\s/gm) ?? []).length === 1, "…and the owner is listed exactly once");

// ---------------------------------------------------- D4 the mirror is skipped
const mirror = join(project, "artifacts", "generated", "payloads", "entity-artifact-widget-prg");
mkdirSync(mirror, { recursive: true });
copyFileSync(canonical, join(mirror, "widget_analysis.json"));
const withMirror = seed();
check(withMirror.okRun, "a registered project (analysis/ + the artifacts/generated/ mirror) still seeds");
check((withMirror.out.match(/^widget\s/gm) ?? []).length === 1, "the generated mirror is NOT walked — the owner appears once, not twice (D4)");

// ------------------------------------- D5 any other duplicate is an error
const stray = join(project, "backup");
mkdirSync(stray, { recursive: true });
copyFileSync(canonical, join(stray, "widget_analysis.json"));
const withStray = seed();
check(!withStray.okRun, "two files claiming one owner outside the mirror is an ERROR, not a last-write-wins race (D5)");
check(/two analysis files claim owner "widget"/.test(withStray.out), "…the message names the owner");
check(/analysis\/payloads\/widget_analysis\.json/.test(withStray.out) && /backup\/widget_analysis\.json/.test(withStray.out), "…and BOTH paths, so the reader does not have to go looking");
check(/--owner/.test(withStray.out), "…and says what to do instead");

// the graph still holds the good seed — refusing wrote nothing
const graphFile = join(project, "knowledge", "graph.sqlite");
check(existsSync(graphFile), "the refusal left the previously seeded graph in place");

console.log(`\n${failCount ? "RED" : "GREEN"}  Spec 830 seed: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
