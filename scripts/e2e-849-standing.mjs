#!/usr/bin/env node
// Spec 849 §8 — the contract's standing blockers, carried back on the write path.
//
// The measurement this exists for: across three unattended runs the verdict was precise
// and unread. Run 6 never called `project_critique` in 114 turns and stopped with nothing
// named against a contract asking for 40 %. Writes are the channel that is always used —
// 14 to 24 per run, the last landing in the final five per cent of the session.
//
// What is checked here is the discipline, because the discipline is what makes it
// readable: a write speaks only when something moved, a summary tool always answers, and
// a project that never stated a contract is never lectured about defaults.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:849-standing

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standingFooter, resetStanding, WRITE_TOOLS, SUMMARY_TOOLS } from "../dist/contract/standing.js";

let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Spec 849 §8 — the contract carried back on the write path\n");

const SLUG = "standing";
const dirs = [];
function newProject(contract) {
  const dir = mkdtempSync(join(tmpdir(), "c64re-849s-"));
  dirs.push(dir);
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }));
  if (contract) writeFileSync(join(dir, "knowledge", "contract.json"), JSON.stringify(contract, null, 2));
  return dir;
}

try {
  // The two sets are disjoint, or a tool would both report and summarise.
  const overlap = [...WRITE_TOOLS].filter((t) => SUMMARY_TOOLS.has(t));
  check(overlap.length === 0, `write and summary tools are disjoint (${overlap.join(", ") || "no overlap"})`);
  check(WRITE_TOOLS.size >= 10, `${WRITE_TOOLS.size} write tools carry the contract`);

  // 1 — no contract file: silence. The defaults are nobody's promise.
  {
    const dir = newProject(undefined);
    check(await standingFooter(dir, "slot_record") === undefined, "a project with no contract is never lectured");
  }

  // 2 — not a project at all, and an unmapped tool
  {
    const dir = newProject({ goal: "x", deliver: { slots: ["S1"] } });
    check(await standingFooter(undefined, "slot_record") === undefined, "no project_dir means silence");
    check(await standingFooter(dir, "graph_find") === undefined, "a read tool carries nothing");
  }

  // 3 — first write states what is owed; an unchanged second write says nothing
  {
    const dir = newProject({ goal: "a contract", deliver: { slots: ["S1", "S3"] } });
    const first = await standingFooter(dir, "slot_record");
    check(!!first && /still owed/.test(first), `first write states the standing list`);
    check(!!first && /S1|S3/.test(first), "…and names the slots");
    const second = await standingFooter(dir, "save_finding");
    check(second === undefined, "a second write that moved nothing is silent");
  }

  // 4 — a summary tool always answers, whether or not anything moved
  {
    const dir = newProject({ goal: "a contract", deliver: { slots: ["S1"] } });
    await standingFooter(dir, "slot_record");
    const a = await standingFooter(dir, "c64re_whats_next");
    check(!!a && /still owed/.test(a), "a summary tool answers even when nothing moved");
    const b = await standingFooter(dir, "project_slots");
    check(!!b && /still owed/.test(b), "…and does it again on the next one");
  }

  // 5 — onboarding forgets, so the next session is told the standing list once more
  {
    const dir = newProject({ goal: "a contract", deliver: { slots: ["S1"] } });
    await standingFooter(dir, "slot_record");
    check(await standingFooter(dir, "slot_record") === undefined, "quiet within the session");
    resetStanding(dir);
    const again = await standingFooter(dir, "slot_record");
    check(!!again && /still owed/.test(again), "agent_onboard re-arms the standing list");
  }

  // 6 — nothing owed: the summary says so plainly rather than going quiet
  {
    const dir = newProject({ goal: "a contract", deliver: { slots: [] } });
    const a = await standingFooter(dir, "c64re_whats_next");
    check(!!a && /every stated deliverable is met/.test(a), "a met contract is stated, not implied by silence");
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
