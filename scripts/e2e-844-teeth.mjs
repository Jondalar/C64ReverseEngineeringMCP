#!/usr/bin/env node
// Spec 844 — does the read-before-runtime gate actually have teeth?
//
// The owner's verdict on the gate as it stood: "was ist denn die Hypothese ohne die
// verweigert wird? doch einfach Text". This script is the answer, and it is written to
// be able to FAIL — every case below refuses or allows for a reason that is checked, not
// asserted by a header line.
//
// Run: node scripts/e2e-844-teeth.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkRuntimeDiscipline } = await import("../dist/server-tools/discipline-gate.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

function newProject(slug) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-844-${slug}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: slug, slug }, null, 2));
  return dir;
}

const gate = (hypothesis, projectDir, tool = "runtime_trace_taint") =>
  checkRuntimeDiscipline(hypothesis, { tool, act: "following data-flow taint", projectDir });

const dirs = [];
try {
  // ---------------------------------------------------------------- 1. form check
  {
    const d = newProject("form"); dirs.push(d);
    const noAddr = await gate("I would like to look at the loader for a while please", d);
    check("no $address is still refused", !noAddr.allowed, noAddr.refusal?.split("\n")[0]);
    const noWhy = await gate("$C000", d);
    check("address without rationale is still refused", !noWhy.allowed, noWhy.refusal?.split("\n")[0]);
  }

  // ------------------------------------------------- 2. empty project ⇒ dormant
  {
    const d = newProject("empty"); dirs.push(d);
    const r = await gate("$C000 the loader copies the payload there, I am fairly sure of it", d);
    check("empty project: resolver dormant, call allowed", r.allowed,
      "a gate that fires before there is anything to cite would brick day one");
  }

  // --------------------------------------- 3. corpus exists ⇒ invention refused
  {
    const d = newProject("corpus"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({
      kind: "observation", title: "stage 2 decompressor",
      addressRange: { start: 0x0810, end: 0x08ff },
    });
    const invented = await gate("$C000 the loader copies the payload there, I am fairly sure of it", d);
    check("fabricated $C000 against a real corpus is REFUSED", !invented.allowed,
      invented.refusal?.split("\n")[0] ?? "(allowed — the tooth does not bite)");
    check("refusal names what was searched", /resolves? to nothing/.test(invented.refusal ?? ""),
      (invented.refusal ?? "").split("\n").slice(2, 3).join(" "));

    const real = await gate("$0820 sits inside the stage 2 decompressor I read in the listing", d);
    check("an address that RESOLVES is allowed", real.allowed,
      real.refusal?.split("\n")[0] ?? "resolved against the saved finding");
  }

  // --------------------------------------------------- 4. the accrual ratchet
  {
    const d = newProject("ratchet"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({
      kind: "observation", title: "resident engine",
      addressRange: { start: 0x4000, end: 0x5fff },
    });
    const h = "$4100 is inside the resident engine, confirming the dispatcher table";

    let allowedRuns = 0, refusal = null;
    for (let i = 0; i < 8; i++) {
      const r = await gate(h, d, `run_${i}`);
      if (r.allowed) allowedRuns++;
      else { refusal = r.refusal; break; }
    }
    check("the ratchet eventually refuses a recordless loop", refusal !== null,
      `allowed ${allowedRuns} runs before refusing`);
    check("refusal counts the runs and names the way out",
      /nothing recorded/.test(refusal ?? "") && /refutation/.test(refusal ?? ""),
      (refusal ?? "").split("\n")[0]);

    // Writing ANY durable record releases it — including a negative result.
    rec.saveFinding({
      kind: "observation", title: "refutation: the dispatcher table is not at $4100",
      addressRange: { start: 0x4100, end: 0x4100 },
      tags: ["refutation"],
    });
    const after = await gate(h, d, "run_after_record");
    check("writing a record releases the gate immediately", after.allowed,
      after.refusal?.split("\n")[0] ?? "released");
  }

  // ------------------------------------------------- 5. the escape hatch works
  {
    const d = newProject("off"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "x", addressRange: { start: 0x1000, end: 0x1fff } });
    process.env.C64RE_RUNTIME_RATCHET = "0";
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const r = await gate("$1100 is inside the routine I read", d, `off_${i}`);
      if (r.allowed) allowed++;
    }
    delete process.env.C64RE_RUNTIME_RATCHET;
    check("C64RE_RUNTIME_RATCHET=0 disables the ratchet", allowed === 10, `${allowed}/10 allowed`);
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nall teeth bite" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
