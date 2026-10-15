#!/usr/bin/env node
// Spec 844 §4 — the slot list, D1 (doors refuse) and D2 (empty is a query result).
//
// Written to be able to FAIL. Every case below asserts a status or a refusal that the
// code has to produce; none of it is a header line claiming the build works.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// coverage counts the file on disk, so a fixture record needs its file: write each row's file at its fileSize.
function writeArtifactsJson(file, text) {
  writeFileSync(file, text);
  const root = join(dirname(file), "..");
  for (const a of JSON.parse(text).items) {
    const p = join(root, a.relativePath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(a.fileSize ?? 0));
  }
}


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
    check("fifteen slots", SLOTS.length === 15, `${SLOTS.length} defined`);
    const ids = SLOTS.map((s) => s.id);
    check("slot ids are unique and context..writable-space", new Set(ids).size === 15 && ids[0] === "context" && ids[14] === "writable-space");

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
    check("engaged project: register_payload refuses on data-geometry", !g.allowed,
      (g.refusal ?? "").split("\n")[0]);
    check("the refusal names the slot and what fills it",
      /data-geometry/.test(g.refusal ?? "") && /payload entities/.test(g.refusal ?? ""));
    check("the refusal points at a tool that exists", /slot_record/.test(g.refusal ?? ""));
  }

  // ---------------------------------------------------- filling a slot opens the door
  {
    const d = newProject("fill"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "stage 1", addressRange: { start: 0x0801, end: 0x08ff } });
    let r = await slotReport(d);
    check("data-geometry starts empty", statusOf(r, "data-geometry") === "empty", statusOf(r, "data-geometry"));

    rec.saveFinding({
      kind: "observation", title: "payloads sit in tracks 18-24, LUT at $3000, packed with exomizer",
      tags: ["slot:data-geometry"],
    });
    r = await slotReport(d);
    check("tagging slot:data-geometry fills it", statusOf(r, "data-geometry") === "filled", r.states.find((s) => s.slot.id === "data-geometry")?.detail);
    const g = await checkSlotGate("register_payload", d);
    check("the door opens once the slot is filled", g.allowed, g.refusal?.split("\n")[0]);
  }

  // ------------------------------------------------- free-ram: read-derived stays a hypothesis
  {
    const d = newProject("s11"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec.saveFinding({ kind: "memory-map", title: "$C000-$CFFF is free", tags: ["slot:free-ram", "method:read"] });
    let r = await slotReport(d);
    check("read-derived free RAM is a HYPOTHESIS, not a fill", statusOf(r, "free-ram") === "hypothesis",
      r.states.find((s) => s.slot.id === "free-ram")?.detail);

    const g = await checkSlotGate("runtime_candidate_variant", d);
    check("a hypothesis does NOT open the allocating door", !g.allowed,
      (g.refusal ?? "").split("\n")[0] ?? "(allowed)");

    rec.saveFinding({ kind: "memory-map", title: "$C000-$CFFF confirmed free by run", tags: ["slot:free-ram", "method:run"] });
    r = await slotReport(d);
    check("a run-watched free-ram fills the slot", statusOf(r, "free-ram") === "filled", r.states.find((s) => s.slot.id === "free-ram")?.detail);
    check("…and its text says a run saw no write, never that a run proved it free",
      /saw no write/.test(r.states.find((s) => s.slot.id === "free-ram")?.detail ?? "") && !/confirmed by running/.test(r.states.find((s) => s.slot.id === "free-ram")?.detail ?? ""));
    check("the allocating door opens", (await checkSlotGate("runtime_candidate_variant", d)).allowed);
  }

  // ------------------------------------------ writable-space: the BAM is a hypothesis, chains settle it
  {
    const d = newProject("s15"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    writeArtifactsJson(join(d, "knowledge", "artifacts.json"), JSON.stringify({ items: [
      { id: "m1", kind: "d64", title: "side1.d64", path: "side1.d64", relativePath: "side1.d64", scope: "input", tags: [] },
    ] }, null, 2));

    let r = await slotReport(d);
    check("a registered medium makes writable-space apply", statusOf(r, "writable-space") === "empty",
      r.states.find((s) => s.slot.id === "writable-space")?.detail);

    rec.saveFinding({ kind: "observation", title: "30 blocks free per the BAM", tags: ["slot:writable-space", "method:bam"] });
    r = await slotReport(d);
    check("a BAM-derived free list is a HYPOTHESIS, not a fill", statusOf(r, "writable-space") === "hypothesis",
      r.states.find((s) => s.slot.id === "writable-space")?.detail);

    rec.saveFinding({ kind: "observation", title: "78 blocks spare after walking every chain", tags: ["slot:writable-space", "method:chains"] });
    r = await slotReport(d);
    check("walking the chains settles writable-space", statusOf(r, "writable-space") === "filled",
      r.states.find((s) => s.slot.id === "writable-space")?.detail);
  }

  // ------------------------------------------------- writable-space is n/a while no medium is registered
  {
    const d = newProject("s15-nomedium"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    const r = await slotReport(d);
    check("no medium ⇒ writable-space is n/a, not an open slot", statusOf(r, "writable-space") === "n/a",
      r.states.find((s) => s.slot.id === "writable-space")?.detail);
  }

  // --------------------------------------------------------- conditional slots are n/a
  {
    const d = newProject("cond"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    let r = await slotReport(d);
    check("runtime-linkage is n/a while runtime-count has stated no count", statusOf(r, "runtime-linkage") === "n/a",
      r.states.find((s) => s.slot.id === "runtime-linkage")?.detail);

    rec.saveFinding({ kind: "observation", title: "this game has 3 runtimes", tags: ["slot:runtime-count"] });
    r = await slotReport(d);
    check("stating 3 runtimes makes runtime-linkage required", statusOf(r, "runtime-linkage") === "empty",
      r.states.find((s) => s.slot.id === "runtime-linkage")?.detail);

    const d2 = newProject("cond1"); dirs.push(d2);
    const rec2 = new KnowledgeRecords(d2);
    rec2.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec2.saveFinding({ kind: "observation", title: "one runtime, resident at $0801", tags: ["slot:runtime-count"] });
    const r2 = await slotReport(d2);
    check("stating one runtime keeps runtime-linkage n/a", statusOf(r2, "runtime-linkage") === "n/a",
      r2.states.find((s) => s.slot.id === "runtime-linkage")?.detail);
  }

  // ------------------------- BUG-059 defect 9: runtime-linkage was gated on a digit in runtime-count's title
  //
  // An autonomous run answered runtime-count "Two permanently resident images and twelve
  // swappable windows" and got back "its wording states no number this can read
  // … re-record runtime-count with a count in it". It re-recorded as "4 resident runtimes
  // and 14 swappable windows" and that did not clear it either, so runtime-linkage..S9 stayed
  // permanently n/a. Both are perfectly clear sentences; the parser demanded the
  // digit immediately before the word "runtime".
  {
    const cases = [
      ["Two permanently resident images and twelve swappable windows", 2, "applies"],
      ["4 resident runtimes and 14 swappable windows", 4, "applies"],
      ["Two resident images", 2, "applies"],
      ["a single resident image at $0801", undefined, "unreadable"],
      ["one runtime image, resident at $0801", 1, "n/a"],
    ];
    let caseN = 0;
    for (const [title, expected, expect] of cases) {
      caseN += 1;
      const d = newProject(`s5case${caseN}`); dirs.push(d);
      const rec = new KnowledgeRecords(d);
      rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
      rec.saveFinding({ kind: "observation", title, tags: ["slot:runtime-count"] });
      const rr = await slotReport(d);
      const s6 = rr.states.find((x) => x.slot.id === "runtime-linkage");
      const s5 = rr.states.find((x) => x.slot.id === "runtime-count");
      if (expect === "applies") {
        check(`runtime-linkage applies from "${title}"`, s6?.status === "empty", s6?.detail);
        check(`…and runtime-count's line says the count it read (${expected})`,
          (s5?.detail ?? "").includes(`count ${expected} (read from the wording)`), s5?.detail);
      } else if (expect === "n/a") {
        check(`runtime-linkage stays n/a for one runtime ("${title}")`, s6?.status === "n/a", s6?.detail);
      } else {
        check(`an unreadable wording still says so ("${title}")`,
          s6?.status === "n/a" && /slot_record\(slot="runtime-count", count=N/.test(s6?.detail ?? ""), s6?.detail);
        check("…and runtime-count's own line admits it read no count",
          /no count could be read/.test(s5?.detail ?? ""), s5?.detail);
      }
    }

    // The count as a FIELD beats prose, and beats an earlier prose-only claim —
    // which is what "re-recording did not clear it either" was about.
    const d = newProject("s5-field"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec.saveFinding({ kind: "observation", title: "a single resident image at $0801", tags: ["slot:runtime-count"] });
    let rf = await slotReport(d);
    check("a prose-only runtime-count that states no number leaves runtime-linkage undecided", statusOf(rf, "runtime-linkage") === "n/a");
    rec.saveFinding({ kind: "observation", title: "four resident images and fourteen windows", tags: ["slot:runtime-count", "count:4"] });
    rf = await slotReport(d);
    check("recording the count as a field settles runtime-linkage", statusOf(rf, "runtime-linkage") === "empty",
      rf.states.find((x) => x.slot.id === "runtime-linkage")?.detail);
    check("…and runtime-count's line says the count came from a field",
      (rf.states.find((x) => x.slot.id === "runtime-count")?.detail ?? "").includes("count 4 (recorded as a field)"),
      rf.states.find((x) => x.slot.id === "runtime-count")?.detail);

    // A sentence with two different counts on the same noun is refused, not guessed.
    const d3 = newProject("s5-ambig"); dirs.push(d3);
    const rec3 = new KnowledgeRecords(d3);
    rec3.saveFinding({ kind: "observation", title: "seed", addressRange: { start: 0x0801, end: 0x08ff } });
    rec3.saveFinding({ kind: "observation", title: "One resident image per phase, five images in all", tags: ["slot:runtime-count"] });
    const r3 = await slotReport(d3);
    check("two different counts in one sentence are not guessed at",
      /no count could be read/.test(r3.states.find((x) => x.slot.id === "runtime-count")?.detail ?? ""),
      r3.states.find((x) => x.slot.id === "runtime-count")?.detail);
  }

  // ------------------------------------------------------ coverage: the vocabulary is gated
  {
    const d = newProject("cov"); dirs.push(d);
    const rec = new KnowledgeRecords(d);
    rec.saveEntity({ kind: "payload", name: "main", addressRange: { start: 0x0801, end: 0x0900 } });
    // 256 covered bytes against a 16 KB artifact ⇒ ~1.5 %.
    const artifacts = join(d, "knowledge", "artifacts.json");
    writeArtifactsJson(artifacts, JSON.stringify({ items: [
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

  // ------------- BUG-059 defect 8: the metric must not reward a blanket placeholder
  //
  // An autonomous run found that emitting `unknown` segments named `unnamed_XXXX`
  // over ranges it had ALREADY named as routines — the loader among them — moved
  // the coverage number, because a placeholder with an extent counted and a named
  // routine's own extent did not. It reverted all 47 by hand. A metric that scores
  // a blanket above a name is the defect.
  {
    const { GraphStore } = await import("../dist/knowledge-graph/store.js");
    const slug = "covgame";
    const mk = () => {
      const dir = mkdtempSync(join(tmpdir(), "c64re-cov8-"));
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: slug, slug }, null, 2));
      writeArtifactsJson(join(dir, "knowledge", "artifacts.json"), JSON.stringify({ items: [
        { id: "a1", kind: "prg", title: "main.prg", path: "main.prg", relativePath: "main.prg", scope: "input", fileSize: 4098, tags: [] },
      ] }, null, 2));
      return dir;
    };
    const seed = (dir, nodes) => {
      const store = GraphStore.open(dir);
      store.replaceGenerated("test", null, nodes, []);
      store.close();
    };
    const node = (kind, addr, end, name, segmentKind) => ({
      id: `${slug}:ram/main:${kind}:${addr.toString(16).padStart(4, "0")}`,
      kind, name, endAddress: end, origin: "static", confidence: "certain",
      ...(segmentKind ? { attrs: { segment_kind: segmentKind } } : {}),
    });

    // 1. a blanket: one `unknown` segment over the whole file, with a placeholder name
    const dBlanket = mk(); dirs.push(dBlanket);
    seed(dBlanket, [node("segment", 0x0801, 0x1800, "unnamed_0801", "unknown")]);
    const rb = await slotReport(dBlanket);
    check("a blanket `unknown` range moves coverage not at all", rb.coverage.covered === 0,
      `${rb.coverage.covered}/${rb.coverage.total}`);
    check("…and the bytes are reported as declared-unknown, not hidden", rb.coverage.declaredUnknown > 0,
      `declaredUnknown=${rb.coverage.declaredUnknown}`);
    check("…and the report says where they went",
      /declared `unknown`/.test(formatSlotReport(rb)),
      formatSlotReport(rb).split("\n").find((l) => /not counted/.test(l)));

    // 2. a machine name over an extent, with nothing said about it
    const dMachine = mk(); dirs.push(dMachine);
    seed(dMachine, [node("routine", 0x0801, 0x1800, "W0801")]);
    const rm = await slotReport(dMachine);
    check("a machine-named extent with no classification moves it not at all", rm.coverage.covered === 0,
      `${rm.coverage.covered}/${rm.coverage.total}`);
    check("…and is reported as such", rm.coverage.machineOnly > 0, `machineOnly=${rm.coverage.machineOnly}`);

    // 3. the honest work: the same range, named
    const dNamed = mk(); dirs.push(dNamed);
    seed(dNamed, [node("routine", 0x0801, 0x1800, "irq_dispatch")]);
    const rn = await slotReport(dNamed);
    check("naming the routine IS what moves the number", rn.coverage.covered === 0x1800 - 0x0801 + 1,
      `${rn.coverage.covered}/${rn.coverage.total}`);

    // 4. …and so is classifying it, which is what the analyser does
    const dClassified = mk(); dirs.push(dClassified);
    seed(dClassified, [node("segment", 0x0801, 0x1800, "seg_0801", "code")]);
    const rc = await slotReport(dClassified);
    check("a classified range counts even under a machine name — `code` is a claim", rc.coverage.covered > 0,
      `${rc.coverage.covered}/${rc.coverage.total}`);

    // 5. the reported manoeuvre, end to end: painting `unknown` over a named routine
    //    must LOWER nothing and RAISE nothing.
    const dBoth = mk(); dirs.push(dBoth);
    seed(dBoth, [
      node("routine", 0x0801, 0x0900, "irq_dispatch"),
      node("segment", 0x0901, 0x1800, "unnamed_0901", "unknown"),
    ]);
    const rboth = await slotReport(dBoth);
    check("painting a blanket beside real names adds nothing to coverage",
      rboth.coverage.covered === 0x0900 - 0x0801 + 1,
      `${rboth.coverage.covered} covered, ${rboth.coverage.declaredUnknown} declared unknown`);

    // 6. issue #46: "not counted" must not name bytes that ARE counted. A generated
    //    routine (machine name) inside a classified segment is covered, not machine-only.
    const inv = (r) => r.coverage.covered + r.coverage.declaredUnknown + r.coverage.machineOnly <= r.coverage.total;
    const dInside = mk(); dirs.push(dInside);
    seed(dInside, [
      node("segment", 0x0801, 0x0fff, "seg_0801", "code"),
      node("routine", 0x0900, 0x09ff, "W0900"),
    ]);
    const rin = await slotReport(dInside);
    check("a machine-named range inside a counted one is not 'not counted'",
      rin.coverage.machineOnly === 0 && rin.coverage.covered === 0x0fff - 0x0801 + 1,
      `covered=${rin.coverage.covered} machineOnly=${rin.coverage.machineOnly}`);
    check("…and the invariant covered+unknown+machine <= total holds", inv(rin));

    const dHalf = mk(); dirs.push(dHalf);
    seed(dHalf, [
      node("segment", 0x0801, 0x0900, "seg_0801", "code"),
      node("routine", 0x0881, 0x0980, "W0881"),
    ]);
    const rhalf = await slotReport(dHalf);
    check("a machine-named range half outside the counted one: only the outside half is machine-only",
      rhalf.coverage.machineOnly === 128 && rhalf.coverage.covered === 256,
      `covered=${rhalf.coverage.covered} machineOnly=${rhalf.coverage.machineOnly}`);
    check("…and the invariant holds", inv(rhalf));

    const dUnk = mk(); dirs.push(dUnk);
    seed(dUnk, [
      node("segment", 0x0801, 0x0fff, "seg_0801", "code"),
      node("segment", 0x0901, 0x0a00, "unnamed_0901", "unknown"),   // inside counted
      node("segment", 0x1000, 0x10ff, "unnamed_1000", "unknown"),   // outside, 256 bytes
      node("routine", 0x1080, 0x117f, "W1080"),                     // half over the unknown range
    ]);
    const runk = await slotReport(dUnk);
    check("`unknown` under a counted range is not 'not counted'; unknown wins over machine-only on overlap",
      runk.coverage.declaredUnknown === 256 && runk.coverage.machineOnly === 128,
      `unknown=${runk.coverage.declaredUnknown} machineOnly=${runk.coverage.machineOnly}`);
    check("…and no byte is reported twice (invariant)", inv(runk));
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
    check("the report lists all 15 slots", (text.match(/^[✓~✗·] [a-z]/gm) ?? []).length === 15,
      text.split("\n")[0]);
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nslot list holds" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
