#!/usr/bin/env node
// Spec 877 D1 — an owed promise refuses the doors that finish the work.
//
// The case this exists for, verbatim from the run that produced it: the footer said
//
//     **Contract: now owed** — named 0.0 % (0/171 nodes) is below the 90 % the contract
//     asks for
//
// and the run read it and carried on building the cartridge. 21 payloads extracted, 2
// analysed, 0 annotated, 105 files under `ef/`. The machinery was right to the last inch;
// nothing made it cost anything.
//
// Written to be able to FAIL. Every case below refuses or allows for a reason that is
// checked. The second half is the one that matters most: a gate that refuses the work
// which would clear the promise is worse than no gate, so the doors that are NEVER shut
// are asserted explicitly and not left to a comment.
//
// Run: node scripts/e2e-877-teeth.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { saveContract } = await import("../dist/contract/contract.js");
const { checkContractTeeth, PUBLISHING_DOORS, RELEASE_ROLES, isReleaseRole, closesAPhase } =
  await import("../dist/contract/teeth.js");
const { contractPromises } = await import("../dist/contract/promises.js");
const { verdict } = await import("../dist/critic/run.js");
const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "testgame";
function newProject(tag) {
  const dir = mkdtempSync(join(tmpdir(), `c64re-877-${tag}-`));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  return dir;
}

/** Three routines, one of them humanly named -> 33 % named, against a contract asking 90 %. */
function seedGraph(d, namedCount) {
  const store = GraphStore.open(d);
  const rid = (a) => `${SLUG}:ram/game:routine:${a.toString(16).padStart(4, "0")}`;
  store.replaceGenerated("test", null, [
    { id: rid(0x2000), kind: "routine", name: "W2000", endAddress: 0x2040, origin: "static", confidence: "certain" },
    { id: rid(0x2100), kind: "routine", name: "W2100", endAddress: 0x2140, origin: "static", confidence: "certain" },
    { id: rid(0x2200), kind: "routine", name: "W2200", endAddress: 0x2240, origin: "static", confidence: "certain" },
  ], []);
  const names = ["fastloader_transfer", "drive_command_loop", "depack_stage2"];
  for (let i = 0; i < namedCount; i++) {
    store.upsertHuman({ id: rid(0x2000 + i * 0x100), kind: "routine", name: names[i], origin: "user", confidence: "user_asserted" });
  }
  store.close();
  new KnowledgeRecords(d).saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x2000, end: 0x2040 } });
}

function walkTs(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (f.endsWith(".ts")) out.push(p);
  }
  return out;
}

const dirs = [];
try {
  // ------------------------------------------------------ which doors carry the teeth
  {
    check("the three publishing doors are named as data",
      PUBLISHING_DOORS.size === 3
      && PUBLISHING_DOORS.has("render_docs")
      && PUBLISHING_DOORS.has("save_artifact")
      && PUBLISHING_DOORS.has("agent_record_step"),
      [...PUBLISHING_DOORS.keys()].join(", "));

    // Spec 839's rule one level up: the table and the call sites may not drift. A door
    // listed here that nothing calls is a promise the gate does not keep.
    const wired = new Set();
    for (const f of walkTs("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/checkContractTeeth\(\s*"([a-z_0-9]+)"/g)) wired.add(m[1]);
    }
    const listed = new Set(PUBLISHING_DOORS.keys());
    const missing = [...listed].filter((d) => !wired.has(d));
    const extra = [...wired].filter((d) => !listed.has(d));
    check("every listed door actually calls the gate", missing.length === 0,
      missing.length ? `not wired: ${missing.join(", ")}` : `${wired.size} call sites`);
    check("and nothing else does", extra.length === 0,
      extra.length ? `gated but not listed: ${extra.join(", ")}` : "the two sets agree");
  }

  // ------------------------------------------------------------ no contract, no teeth
  {
    const d = newProject("nocontract"); dirs.push(d);
    seedGraph(d, 0);
    const g = await checkContractTeeth("render_docs", d);
    check("no contract = no refusal, ever", g.allowed,
      "the defaults are not a promise anybody made");
  }

  // ------------------------------------------- an engaged project with an owed promise
  {
    const d = newProject("owed"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, {
      goal: "judge whether this can be ported to an EasyFlash cartridge",
      deliver: { slots: ["S1"], namedRatio: 0.9 },
    });

    const owed = await contractPromises(d);
    check("the promise is computed and carries its id", owed.some((p) => p.id === "namedRatio"),
      owed.map((p) => p.id).join(", ") || "(none)");

    const g = await checkContractTeeth("render_docs", d);
    check("render_docs refuses while the promise is owed", !g.allowed,
      (g.refusal ?? "").split("\n")[0] ?? "(allowed)");
    const r = g.refusal ?? "";
    check("the refusal names the spec number", /877/.test(r));
    check("the refusal names the MEASURED number", /33\.3 %/.test(r), r.split("\n").find((l) => /%/.test(l)));
    check("the refusal names what the contract ASKED for", /90 %/.test(r));
    check("the refusal names the shortest path to clearing it",
      /clear:/.test(r) && /disasm|annotat/i.test(r));
    check("the refusal names the human's override", /contract_set/.test(r) && /waive/.test(r));
    check("it is shaped like a 844 refusal — a heading, then the body",
      /^# render_docs refused — /.test(r), r.split("\n")[0]);
  }

  // ------------------------------------------- a release registration, and only that
  {
    const d = newProject("release"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, { goal: "port it to a cartridge and ship it", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    check("`release-crt` is a release", isReleaseRole("release-crt"));
    check("`release` on its own is too", isReleaseRole("release"));
    check("a rebuild's own output is NOT a release", !isReleaseRole("build-output"),
      "assemble_source writes it on every byte-identical rebuild check — that is the work");
    check("a scene reel is NOT a release", !isReleaseRole("release-reel"),
      "a GIF of the screen is evidence, not a shipped artefact");
    check("an extracted payload is NOT a release", !isReleaseRole("payload") && !isReleaseRole("disasm"));
    check("no role at all is not a release", !isReleaseRole(undefined));

    const shipped = await checkContractTeeth("save_artifact", d, { role: "release-crt" });
    check("registering a release refuses", !shipped.allowed, (shipped.refusal ?? "").split("\n")[0]);
    for (const role of ["payload", "disasm", "analysis-json", "build-output", "annotations", undefined]) {
      const ok = await checkContractTeeth("save_artifact", d, { role });
      check(`registering role=${role ?? "(none)"} is allowed`, ok.allowed, (ok.refusal ?? "").split("\n")[0]);
    }
  }

  // -------------------------------------------------- a step that CLOSES a phase
  {
    const d = newProject("step"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, { goal: "map the loader and then write it up", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    check("\"phase 5 complete\" closes a phase", closesAPhase("Phase 5 complete"));
    check("\"phase 3 abgeschlossen\" too", closesAPhase("phase 3 abgeschlossen"));
    check("a completeness claim closes it as well", closesAPhase("the engine is fully mapped"));
    check("recording what was DONE does not close a phase",
      !closesAPhase("annotated 12 routines in the loader") && !closesAPhase("extracted 21 payloads, 2 analysed"));
    check("and neither does queueing the next one", !closesAPhase("next: disassemble the drivecode"));

    const closing = await checkContractTeeth("agent_record_step", d, { step: "Phase 5 complete — semantic analysis done" });
    check("a phase-closing step refuses", !closing.allowed, (closing.refusal ?? "").split("\n")[0]);
    const ordinary = await checkContractTeeth("agent_record_step", d, { step: "annotated 12 routines in the loader" });
    check("an ordinary progress step is recorded as always", ordinary.allowed,
      (ordinary.refusal ?? "").split("\n")[0]);
  }

  // ------------------------------------------------ NEVER the work that would clear it
  //
  // The rule D1 turns on. A door that stops the session naming routines is a gate that
  // guarantees the promise is never kept, so the whole list is asserted rather than
  // trusted to a comment.
  {
    const d = newProject("never"); dirs.push(d);
    seedGraph(d, 0);
    saveContract(d, { goal: "everything, and then some, about this cartridge", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    const NEVER = [
      "analyze", "analyze_prg", "disasm", "disasm_prg", "disasm_raw", "propose_annotations",
      "save_finding", "save_entity", "save_open_question", "slot_record", "model_assert",
      "register_payload", "doc_register", "link_payload_to_asm", "extract_disk", "extract_crt",
      "runtime_session_start", "runtime_run_prg", "runtime_monitor", "runtime_until",
      "runtime_trace_start", "runtime_render_screen", "runtime_sandbox_run", "sandbox_depack",
      "sandbox_6502_run", "project_status", "project_slots", "project_critique", "contract_show",
      "list_findings", "read_artifact", "graph_find", "graph_node", "project_search",
      "c64re_whats_next", "agent_onboard", "agent_propose_next",
    ];
    const shut = [];
    for (const door of NEVER) {
      const g = await checkContractTeeth(door, d);
      if (!g.allowed) shut.push(door);
    }
    check("not one door that does the work is ever shut", shut.length === 0,
      shut.length ? `refused: ${shut.join(", ")}` : `${NEVER.length} doors checked, all open`);
  }

  // ---------------------------------------------------- clearing it clears the refusal
  {
    const d = newProject("clear"); dirs.push(d);
    seedGraph(d, 3);
    saveContract(d, { goal: "name enough of it to judge the port", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    const owed = await contractPromises(d);
    check("with the promise met nothing is owed", owed.length === 0, owed.map((p) => p.id).join(", "));
    const g = await checkContractTeeth("render_docs", d);
    check("and the door opens with no further action", g.allowed, (g.refusal ?? "").split("\n")[0]);
  }

  // ------------------------------------------------------ the 848 blocker text survives
  //
  // The promise list and the verdict are one computation now. If the wording drifts the
  // footer that named "named 0.0 % (0/171 nodes)" stops matching what 848 asserts.
  {
    const d = newProject("verdict"); dirs.push(d);
    seedGraph(d, 0);
    saveContract(d, { goal: "understand the loader well enough to port it", deliver: { slots: ["S1"], namedRatio: 0.5 } });
    const v = await verdict(d);
    check("the verdict still speaks in 848's words",
      v.blockers.some((b) => /named 0\.0 %.*below the 50 %.*counts things with a name/.test(b)),
      v.blockers.find((b) => /named/.test(b)) ?? v.blockers.join(" ; "));
  }

  // ------------------------------------------------------------------ the one switch
  {
    const d = newProject("switch"); dirs.push(d);
    seedGraph(d, 0);
    saveContract(d, { goal: "a contract that is owed and a gate switched off", deliver: { slots: ["S1"], namedRatio: 0.9 } });
    process.env.C64RE_SLOT_GATE = "0";
    const off = await checkContractTeeth("render_docs", d);
    delete process.env.C64RE_SLOT_GATE;
    check("C64RE_SLOT_GATE=0 opens this gate too", off.allowed,
      "one switch for the door gates, not a second one nobody knows about");
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe promise has teeth" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
