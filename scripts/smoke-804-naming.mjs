#!/usr/bin/env node
// Spec 804 §2.6 smoke — no name over 20 characters in a project created since the rule.
//
// The owner, 2026-09-19: "bei store eines Labels verweigere in Zukunft alles > 20 Zeichen",
// "nur für neue Projekte". So: project_init stamps the limit into a project it creates;
// every door that stores a name refuses a longer one; a project without the stamp is not
// checked; and disasm_prg refuses BEFORE it renders, so a refusal writes nothing.
// Needs no runtime and no local game project — everything goes through the product's doors.
//
//   node scripts/smoke-804-naming.mjs     (needs `npm run build`)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMcp } from "./lib/fixture-804.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

let pass = 0, fail = 0;
const check = (cond, msg, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

const LONG = "draw_string_next_row_x"; // 22
const FITS = "draw_string_next_row"; //   20
const projectJson = (dir) => JSON.parse(readFileSync(join(dir, "knowledge", "project.json"), "utf8"));

// A PRG at $1000: JSR $1004 / RTS / LDA #$01 / RTS — two routines to name.
const writePrg = (dir) => {
  const prg = join(dir, "payloads", "p.prg");
  mkdirSync(dirname(prg), { recursive: true });
  writeFileSync(prg, Buffer.from([0x00, 0x10, 0x20, 0x04, 0x10, 0x60, 0xa9, 0x01, 0x60]));
  return prg;
};
const writeAnnotations = (prg, name) => writeFileSync(prg.replace(/\.prg$/u, "_annotations.json"), JSON.stringify({
  routines: [{ address: "1000", name: "main", comment: "entry" }, { address: "1004", name, comment: "the second routine" }],
}, null, 2));

console.log("Spec 804 — names over 20 characters, new projects only\n");
const fresh = mkdtempSync(join(tmpdir(), "c64re-804n-"));
const legacy = mkdtempSync(join(tmpdir(), "c64re-804l-"));
const mcps = [];
try {
  const { KnowledgeRecords } = await dist("knowledge-graph/records.js");
  const { nameNode } = await dist("knowledge-graph/migrate/human.js");

  console.log("[a project created now]");
  const a = startMcp(ROOT, { C64RE_PROJECT_DIR: fresh, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_AUTOSTART: "0" });
  mcps.push(a);
  await a.init();
  await a.tool("project_init", { project_dir: fresh, name: "naming fixture" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await a.tool("agent_onboard", { project_dir: fresh });
  check(projectJson(fresh).naming?.maxLabelLength === 20, "project_init stamps the limit into a project it creates", JSON.stringify(projectJson(fresh).naming));
  await a.tool("project_init", { project_dir: fresh, name: "naming fixture" });
  check(projectJson(fresh).naming?.maxLabelLength === 20, "re-running project_init keeps it");

  const records = new KnowledgeRecords(fresh);
  let err = "";
  try { records.saveUserLabel({ label: LONG, address: 0x1004 }); } catch (e) { err = String(e?.message ?? e); }
  check(err.includes(LONG) && err.includes("(22)"), "a user label over 20 is refused, by name and length", err.split("\n")[1]);
  let ok = true;
  try { records.saveUserLabel({ label: FITS, address: 0x1004 }); } catch { ok = false; }
  check(ok, "a label of exactly 20 is stored");
  err = "";
  try { nameNode(fresh, { id: `${projectJson(fresh).slug}:label:x`, kind: "label", name: LONG }); } catch (e) { err = String(e?.message ?? e); }
  check(err.includes(LONG), "the graph's own naming door refuses it too");

  const prg = writePrg(fresh);
  writeAnnotations(prg, LONG);
  const refused = await a.tool("disasm_prg", { project_dir: fresh, prg_path: prg });
  check(/disasm_prg refused/u.test(refused.text) && refused.text.includes(LONG), "disasm_prg refuses an annotations file with a longer name, naming it", refused.text.split("\n").slice(0, 4).join(" / "));
  check(!existsSync(prg.replace(/\.prg$/u, "_disasm.asm")), "…before rendering: no listing was written");
  writeAnnotations(prg, FITS);
  const rendered = await a.tool("disasm_prg", { project_dir: fresh, prg_path: prg });
  check(!/refused/u.test(rendered.text) && existsSync(prg.replace(/\.prg$/u, "_disasm.asm")), "with the name at 20 it renders", rendered.text.split("\n")[0]);

  console.log("\n[a project older than the rule]");
  const b = startMcp(ROOT, { C64RE_PROJECT_DIR: legacy, C64RE_FULL_TOOLS: "1", C64RE_RUNTIME_AUTOSTART: "0" });
  mcps.push(b);
  await b.init();
  await b.tool("project_init", { project_dir: legacy, name: "legacy fixture" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await b.tool("agent_onboard", { project_dir: legacy });
  const pj = projectJson(legacy);
  delete pj.naming; // as every project created before 2026-09-19 is
  writeFileSync(join(legacy, "knowledge", "project.json"), JSON.stringify(pj, null, 2));
  await b.tool("project_init", { project_dir: legacy, name: "legacy fixture" });
  check(projectJson(legacy).naming === undefined, "re-running project_init does not add the rule to an existing project");
  ok = true;
  try { new KnowledgeRecords(legacy).saveUserLabel({ label: LONG, address: 0x1004 }); } catch { ok = false; }
  check(ok, "a long label is stored there, as before");
  const lprg = writePrg(legacy);
  writeAnnotations(lprg, LONG);
  const lr = await b.tool("disasm_prg", { project_dir: legacy, prg_path: lprg });
  check(!/refused/u.test(lr.text) && existsSync(lprg.replace(/\.prg$/u, "_disasm.asm")), "and disasm_prg renders its long names");
} catch (e) {
  fail++;
  console.log(`  FAIL  ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const m of mcps) m.close();
  rmSync(fresh, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-804-naming: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
