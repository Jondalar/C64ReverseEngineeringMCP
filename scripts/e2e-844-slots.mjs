#!/usr/bin/env node
// Spec 844 §4 — the slot list, D1 (doors refuse) and D2 (empty is a query result).
//
// Written to be able to FAIL. Every case below asserts a status or a refusal that the
// code has to produce; none of it is a header line claiming the build works.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SLOTS, DOOR_SLOTS, KNOWN_PENDING_DOORS } = await import("../dist/slots/schema.js");
const { slotReport, formatSlotReport } = await import("../dist/slots/state.js");
const { checkSlotGate, checkCompletenessClaim, checkPhaseComplete } = await import("../dist/slots/gate.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
const { DEFAULT_TOOLS } = await import("../dist/server-tools/tier-tools.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

function newProject(slug) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-slots-${slug}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: slug, slug }, null, 2));
  return dir;
}
const statusOf = (r, id) => r.states.find((s) => s.slot.id === id)?.status;

const dirs = [];
try {
  // ------------------------------------------------------------- schema integrity
  {
    check("fourteen slots", SLOTS.length === 14, `${SLOTS.length} defined`);
    const ids = SLOTS.map((s) => s.id);
    check("slot ids are unique and S1..S14", new Set(ids).size === 14 && ids[0] === "S1" && ids[13] === "S14");

    // Spec 839's rule: a description may not name a verb that does not dispatch. A slot
    // that gates a door nobody can call is the same defect.
    const src = await import("node:fs").then((fs) =>
      ["src/server-tools", "src/project-knowledge"].flatMap((d) =>
        fs.readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(join(d, f), "utf8"))).join("\n"));
    const missing = [...DOOR_SLOTS.keys()].filter((d) => !src.includes(`"${d}",`) && !KNOWN_PENDING_DOORS.has(d));
    check("every gated door exists as a registered tool", missing.length === 0,
      missing.length ? `not found: ${missing.join(", ")}` : `${DOOR_SLOTS.size} doors, ${KNOWN_PENDING_DOORS.size} allowlisted pending`);

    check("slot tools are on the DEFAULT surface",
      DEFAULT_TOOLS.has("project_slots") && DEFAULT_TOOLS.has("slot_record"),
      "a gate naming a hidden tool is a dead end");
  }

  // ------------------------------------------------------- empty project is not gated
  {
    const d = newProject("fresh"); dirs.push(d);
    const g = await checkSlotGate("register_payload", d);
    check("fresh project: doors are NOT gated", g.allowed,
      "the slot list describes a mapped game; an empty directory is not one");
  }

  // ------------------------------------------- an engaged project refuses on the slot
  {
    const d = newProject("engaged"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "stage 1 at $0801", addressRange: { start: 0x0801, end: 0x08ff } });

    const g = await checkSlotGate("register_payload", d);
    check("engaged project: register_payload refuses on S4", !g.allowed,
      (g.refusal ?? "").split("\n")[0]);
    check("the refusal names the slot and what fills it",
      /S4 — Data geometry/.test(g.refusal ?? "") && /payload entities/.test(g.refusal ?? ""));
    check("the refusal points at a tool that exists", /slot_record/.test(g.refusal ?? ""));
  }

  // ---------------------------------------------------- filling a slot opens the door
  {
    const d = newProject("fill"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "stage 1", addressRange: { start: 0x0801, end: 0x08ff } });
    let r = await slotReport(d);
    check("S4 starts empty", statusOf(r, "S4") === "empty", statusOf(r, "S4"));

    rec.saveFinding({
      kind: "observation", title: "payloads sit in tracks 18-24, LUT at $3000, packed with exomizer",
      tags: ["slot:S4"],
    });
    r = await slotReport(d);
    check("tagging slot:S4 fills it", statusOf(r, "S4") === "filled", r.states.find((s) => s.slot.id === "S4")?.detail);
    const g = await checkSlotGate("register_payload", d);
    check("the door opens once the slot is filled", g.allowed, g.refusal?.split("\n")[0]);
  }

  // ------------------------------------------------- S11: read-derived stays a hypothesis
  {
    const d = newProject("s11"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec.saveFinding({ kind: "memory-map", title: "$C000-$CFFF is free", tags: ["slot:S11", "method:read"] });
    let r = await slotReport(d);
    check("read-derived free RAM is a HYPOTHESIS, not a fill", statusOf(r, "S11") === "hypothesis",
      r.states.find((s) => s.slot.id === "S11")?.detail);

    const g = await checkSlotGate("runtime_candidate_patch", d);
    check("a hypothesis does NOT open the allocating door", !g.allowed,
      (g.refusal ?? "").split("\n")[0] ?? "(allowed)");

    rec.saveFinding({ kind: "memory-map", title: "$C000-$CFFF confirmed free by run", tags: ["slot:S11", "method:run"] });
    r = await slotReport(d);
    check("a run settles S11", statusOf(r, "S11") === "filled", r.states.find((s) => s.slot.id === "S11")?.detail);
    check("the allocating door opens", (await checkSlotGate("runtime_candidate_patch", d)).allowed);
  }

  // --------------------------------------------------------- conditional slots are n/a
  {
    const d = newProject("cond"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    let r = await slotReport(d);
    check("S6 is n/a while S5 has stated no count", statusOf(r, "S6") === "n/a",
      r.states.find((s) => s.slot.id === "S6")?.detail);

    rec.saveFinding({ kind: "observation", title: "this game has 3 runtimes", tags: ["slot:S5"] });
    r = await slotReport(d);
    check("stating 3 runtimes makes S6 required", statusOf(r, "S6") === "empty",
      r.states.find((s) => s.slot.id === "S6")?.detail);

    const d2 = newProject("cond1"); dirs.push(d2);
    const rec2 = new KnowledgeRecords(d2);
    rec2.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec2.saveFinding({ kind: "observation", title: "one runtime, resident at $0801", tags: ["slot:S5"] });
    const r2 = await slotReport(d2);
    check("stating one runtime keeps S6 n/a", statusOf(r2, "S6") === "n/a",
      r2.states.find((s) => s.slot.id === "S6")?.detail);
  }

  // ------------------------------------------------------ S12: the vocabulary is gated
  {
    const d = newProject("cov"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveEntity({ kind: "payload", name: "main", addressRange: { start: 0x0801, end: 0x0900 } });
    // 256 covered bytes against a 16 KB artifact ⇒ ~1.5 %.
    const artifacts = join(d, "knowledge", "artifacts.json");
    writeFileSync(artifacts, JSON.stringify({ items: [
      { id: "a1", kind: "prg", title: "main.prg", path: "main.prg", relativePath: "main.prg", scope: "input", fileSize: 16386, tags: [] },
    ] }, null, 2));

    const r = await slotReport(d);
    check("coverage is computed, not asserted", r.coverage.total === 16384 && r.coverage.ratio < 0.1,
      `${r.coverage.covered}/${r.coverage.total} = ${(r.coverage.ratio * 100).toFixed(1)} %`);

    const claim = await checkCompletenessClaim("The engine is now fully mapped", d, "save_finding");
    check("'fully mapped' at 1.6 % is REFUSED", !!claim, (claim ?? "(allowed)").split("\n")[0]);
    check("the refusal states the measured number", /1\.6 %|of 16384 bytes/.test(claim ?? ""));

    const fine = await checkCompletenessClaim("stage 2 decompresses into $C000", d, "save_finding");
    check("ordinary prose passes", fine === undefined);
  }

  // -------------------------------------------------------------- the escape hatch
  {
    const d = newProject("off"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    process.env.C64RE_SLOT_GATE = "0";
    const g = await checkSlotGate("register_payload", d);
    const claim = await checkCompletenessClaim("fully mapped", d, "save_finding");
    delete process.env.C64RE_SLOT_GATE;
    check("C64RE_SLOT_GATE=0 disables both gates", g.allowed && claim === undefined);
  }

  // --------------------------------------------------- phase close needs every slot
  {
    const d = newProject("phase"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    const p = await checkPhaseComplete(d);
    check("closing a phase refuses while slots are open", !p.allowed,
      (p.refusal ?? "").split("\n")[0]);
  }

  // ------------------------------------------------------------------ the report reads
  {
    const d = newProject("fmt"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    const text = formatSlotReport(await slotReport(d));
    check("the report lists all 14 slots", (text.match(/^[✓~✗·] S\d/gm) ?? []).length === 14,
      text.split("\n")[0]);
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nslot list holds" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
