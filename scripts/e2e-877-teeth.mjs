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
const { waivePromises } = await import("../dist/contract/waive.js");
const { listWaivers, activeWaivers, formatWaivers } = await import("../dist/contract/standing.js");
const { verdict } = await import("../dist/critic/run.js");
const { ALIAS_SUCCESSOR } = await import("../dist/server-tools/byte-doors.js");
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

    // The refusal's `clear:` line is the ONE instruction a blocked run follows. It
    // pointed at `disasm_prg`, a name 866 retired, and never named `write_annotations`
    // — the door 877 D6 shipped for exactly this job, two commits before this text was
    // written. A session that obeyed it landed on the alias, found it wants a PRG
    // header, and invented one: the 865 failure, reproduced by our own remedy.
    const retired = Object.keys(ALIAS_SUCCESSOR);
    const namesRetired = retired.filter((n) => r.includes(n));
    check("the clear: line names no door we retired", namesRetired.length === 0,
      namesRetired.length ? `${namesRetired.join(", ")} — retired by 866` : retired.join(" / ") + " all absent");
    check("…and names the writer 877 D6 shipped for this job",
      /write_annotations/.test(r), r.split("\n").find((l) => /clear:/.test(l)));
  }

  // -------------------------------- every clearBy is a path a session can still walk
  //
  // The namedRatio promise above is only one of the strings. The boundary promises need
  // a model and a graph to fire, so they are checked where they are WRITTEN: a `clearBy`
  // is remedy text printed verbatim inside a refusal, and a retired name in one is the
  // same defect wherever it sits.
  {
    const src = readFileSync(join("src", "contract", "promises.ts"), "utf8");
    // A template literal here quotes tool names, so its own backticks are escaped —
    // the extractor has to honour `\``, or every string stops at the first mention.
    const clearBys = [...src.matchAll(/clearBy:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
    check("every promise's clearBy was found to read", clearBys.length >= 6, `${clearBys.length} found`);
    const rotten = clearBys.filter((s) => Object.keys(ALIAS_SUCCESSOR).some((n) => s.includes(n)));
    check("no clearBy anywhere names a retired door", rotten.length === 0,
      rotten.map((s) => s.slice(0, 110)).join("\n        "));
    // The remedies that ask for routines to be NAMED — they all offer the per-routine
    // `save_finding` as the second path, which is what identifies them.
    const naming = clearBys.filter((s) => /tags=\[\\?"routine\\?"\]/.test(s));
    check("the naming remedies were found", naming.length === 3, `${naming.length} of 3`);
    const silent = naming.filter((s) => !/write_annotations/.test(s));
    check("every clearBy that asks for routines to be named points at `write_annotations`", silent.length === 0,
      silent.map((s) => s.slice(0, 110)).join("\n        "));
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

  // ==================================================================================
  // D2 — the human overrules, and it is recorded.
  // ==================================================================================

  // --------------------------------------------------- a waiver has to be attributable
  {
    const d = newProject("waive-shape"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, { goal: "ship the cartridge even if the naming is short", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    const noBy = await waivePromises(d, { promises: ["namedRatio"], reason: "demo deadline is tonight", by: "" });
    check("a waiver with nobody behind it is refused", !noBy.ok, noBy.message.split("\n")[0]);
    check("…and it says why a name is needed", /who/i.test(noBy.message), noBy.message.split("\n")[0]);

    const noReason = await waivePromises(d, { promises: ["namedRatio"], reason: "", by: "Alex" });
    check("a waiver with no reason is refused", !noReason.ok, noReason.message.split("\n")[0]);

    const unknown = await waivePromises(d, { promises: ["namedRatioo"], reason: "typo above", by: "Alex" });
    check("a waiver for a promise nobody owes is refused", !unknown.ok, unknown.message.split("\n")[0]);
    check("…naming the ids that ARE owed", /namedRatio/.test(unknown.message), unknown.message);

    check("nothing was written while all of that was refused", listWaivers(d).length === 0);
  }

  // -------------------------------------------- the waiver releases the door, on the record
  {
    const d = newProject("waive"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, { goal: "ship the cartridge even if the naming is short", deliver: { slots: ["S1"], namedRatio: 0.9 } });

    const shut = await checkContractTeeth("render_docs", d);
    check("before the waiver the door is shut", !shut.allowed);

    const w = await waivePromises(d, {
      promises: ["namedRatio"],
      reason: "the demo ships tonight; the naming continues next week",
      by: "Alex (owner)",
    });
    check("the waiver is accepted", w.ok, w.message.split("\n")[0]);
    check("the answer names who, what and why",
      /Alex \(owner\)/.test(w.message) && /namedRatio/.test(w.message) && /ships tonight/.test(w.message),
      w.message.split("\n")[0]);

    const open = await checkContractTeeth("render_docs", d);
    check("after the waiver the door opens", open.allowed, (open.refusal ?? "").split("\n")[0]);

    // the standing file
    const standing = JSON.parse(readFileSync(join(d, "knowledge", "contract-standing.json"), "utf8"));
    check("the standing file records the waiver", Array.isArray(standing.waivers) && standing.waivers.length === 1);
    const rec = standing.waivers?.[0] ?? {};
    check("…with who waived it", rec.by === "Alex (owner)", JSON.stringify(rec.by));
    check("…what was waived", rec.promise === "namedRatio", JSON.stringify(rec.promise));
    check("…why", /ships tonight/.test(rec.reason ?? ""), JSON.stringify(rec.reason));
    check("…when", typeof rec.at === "string" && rec.at.length > 10, JSON.stringify(rec.at));
    check("…and the CHANNEL the server actually saw, rather than a provenance it cannot check",
      rec.via === "contract_set", JSON.stringify(rec.via));
    check("…and what was accepted, measured", /33\.3 %/.test(rec.wasAt ?? ""), JSON.stringify(rec.wasAt));

    // the timeline
    const tl = readFileSync(join(d, "session", "timeline.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ev = tl.find((e) => e.kind === "contract.waived");
    check("the waiver is an event in the project's timeline", !!ev, tl.map((e) => e.kind).join(", "));
    check("…and the event carries who and why",
      /Alex \(owner\)/.test(JSON.stringify(ev ?? {})) && /ships tonight/.test(JSON.stringify(ev ?? {})));

    // nothing is laundered
    const v = await verdict(d);
    check("the VERDICT still measures the shortfall — a waiver releases the door, not the number",
      v.blockers.some((b) => /named 33\.3 %.*below the 90 %/.test(b)),
      v.blockers.find((b) => /named/.test(b)) ?? "(gone)");
    check("contract_show has something to print", /Alex \(owner\)/.test(formatWaivers(d)), formatWaivers(d));

    // the survivor rule: onboarding forgets what it SAID, never what the human DECIDED
    const { resetStanding } = await import("../dist/contract/standing.js");
    resetStanding(d);
    check("agent_onboard's reset does not wipe the waiver", listWaivers(d).length === 1);
    check("and the door is still open after it", (await checkContractTeeth("render_docs", d)).allowed);
  }

  // ------------------------------------- a waived promise still shows in the next refusal
  //
  // A waiver must not be able to make itself invisible. With a second promise still owed
  // the door refuses again, and the refusal names what was already let through.
  {
    const d = newProject("waive-visible"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, {
      goal: "ship it short on naming, but the loader write-up is not negotiable",
      deliver: { slots: ["S1"], namedRatio: 0.9, documents: [{ covers: "$2000-$2040", why: "the loader" }] },
    });
    const w = await waivePromises(d, { promises: ["namedRatio"], reason: "naming continues next week", by: "Alex" });
    check("the naming promise is waived", w.ok, w.message.split("\n")[0]);

    const g = await checkContractTeeth("render_docs", d);
    check("the door still refuses on the promise that was NOT waived", !g.allowed,
      (g.refusal ?? "").split("\n")[0] ?? "(open)");
    check("and the refusal names the waiver that was granted",
      /Already waived here: namedRatio \(by Alex/.test(g.refusal ?? ""),
      (g.refusal ?? "").split("\n").slice(-1)[0]);
    check("…while the waived promise is no longer listed as owed",
      !/asks:.*HUMAN name/.test(g.refusal ?? ""),
      (g.refusal ?? "").split("\n").filter((l) => /asks:/.test(l)).join(" | "));
  }

  // ------------------------------------------------ the waiver lapses when the bar moves
  //
  // The one half of "a run may not waive its own promise" that IS enforceable from inside:
  // waive at 90 %, then quietly change what the contract asks for, and the release is not
  // inherited. See src/contract/waive.ts for the half that is not.
  {
    const d = newProject("lapse"); dirs.push(d);
    seedGraph(d, 1);
    saveContract(d, { goal: "ship it short, and then raise the bar quietly", deliver: { slots: ["S1"], namedRatio: 0.9 } });
    await waivePromises(d, { promises: ["namedRatio"], reason: "shipping short this once", by: "Alex" });
    check("the door is open under the waiver", (await checkContractTeeth("render_docs", d)).allowed);

    saveContract(d, { goal: "ship it short, and then raise the bar quietly", deliver: { slots: ["S1"], namedRatio: 0.95 } });
    const after = await checkContractTeeth("render_docs", d);
    check("changing what the contract asks LAPSES the waiver", !after.allowed,
      (after.refusal ?? "").split("\n")[0] ?? "(still open)");
    check("the waiver itself is kept, not deleted", listWaivers(d).length === 1);
    check("it is simply not active any more",
      activeWaivers(d, await contractPromises(d)).length === 0);
  }

  // ------------------------------------------- the door the human actually types into
  {
    const src = readFileSync("src/server-tools/contract.ts", "utf8");
    check("contract_set takes `waive`", /waive:\s*z\./.test(src));
    check("…with a reason", /waive_reason:\s*z\./.test(src));
    check("…and a name behind it", /waived_by:\s*z\./.test(src));
    check("contract_show prints the waivers", /formatWaivers/.test(src),
      "a waiver nobody can see from outside is not a record");
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe promise has teeth" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
