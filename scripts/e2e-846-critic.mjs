#!/usr/bin/env node
// Spec 846 — the critic. Every case able to fail.
//
// The four claims below are Ultima VI's actual false negatives, reworded only as far as
// the test fixture needs. Each one cost that project a rebuild, and each is refutable
// against its own graph — which is the whole bet this spec makes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
const { parseNegativeClaim } = await import("../dist/critic/negative-claims.js");
const { critique, verdict, formatCritique } = await import("../dist/critic/run.js");
const { CHECKS } = await import("../dist/critic/checks.js");
const { assertBoundary } = await import("../dist/model/store.js");
const { checkPhaseComplete } = await import("../dist/slots/gate.js");
const { DEFAULT_TOOLS } = await import("../dist/server-tools/tier-tools.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "testgame";
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "c64re-846-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  return dir;
}

const rid = (owner, kind, addr) => `${SLUG}:ram/${owner}:${kind}:${addr.toString(16).padStart(4, "0")}`;
const aid = (addr) => `${SLUG}:ram:addr:${addr.toString(16).padStart(4, "0")}`;

/** A graph that CONTRADICTS each of the four claims below. */
function seedGraph(dir) {
  const store = GraphStore.open(dir);
  const nodes = [
    { id: rid("game", "routine", 0x3913), kind: "routine", name: "creature_take_turn", endAddress: 0x3950, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x2c45), kind: "routine", name: "sets_f3", endAddress: 0x2c60, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x3e83), kind: "routine", name: "disk_write_a", endAddress: 0x3e99, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x4a10), kind: "routine", name: "disk_write_b", endAddress: 0x4a30, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x4900), kind: "routine", name: "in_the_dead_range", endAddress: 0x4920, origin: "static", confidence: "certain" },
    { id: rid("game", "routine", 0x5000), kind: "routine", name: "caller", endAddress: 0x5020, origin: "static", confidence: "certain" },
    // NOTE: no node is created for $F3 on purpose. Ultima VI's USES_ZP edges point at
    // `c64:zp:00f3`, which lives in the PLATFORM file and is not a row here — and the
    // first version of the check joined on nodes and therefore could not see any of that
    // project's 4970 zero-page edges.
    { id: aid(0xdd00), kind: "addr", origin: "static", confidence: "certain" },
  ];
  const edges = [
    // "$F3 is read by nothing" -> it is
    { from: rid("game", "routine", 0x3913), type: "USES_ZP", to: "c64:zp:00f3", origin: "static", confidence: "certain" },
    // "$4800-$53FF is unreferenced" -> a call lands at $4900
    { from: rid("game", "routine", 0x5000), type: "CALLS", to: rid("game", "routine", 0x4900), origin: "static", confidence: "certain" },
    // "only $3E83 writes to disk" -> $4A10 writes the same target
    { from: rid("game", "routine", 0x3e83), type: "WRITES", to: aid(0xdd00), evidenceKey: "a", origin: "static", confidence: "certain" },
    { from: rid("game", "routine", 0x4a10), type: "WRITES", to: aid(0xdd00), evidenceKey: "b", origin: "static", confidence: "certain" },
  ];
  store.replaceGenerated("test", null, nodes, edges);
  store.close();
}

const ev = [{ kind: "note", title: "listing", excerpt: "read in the disassembly" }];
const dirs = [];
try {
  // ------------------------------------------------------- the parser, in isolation
  {
    const cases = [
      ["$F3 is read by nothing in 07_game.prg", "read"],
      ["nothing writes to $C000 during the boot", "write"],
      ["$4800-$53FF is unreferenced", "any"],
      ["the handler at $1BC9 is never called", "call"],
      ["only $3E83 writes to disk", "write"],
      // Object position. Ultima VI's real wording, which the first cut did not match.
      ["create.prg writes nothing to $0203", "write"],
    ];
    let ok = 0;
    for (const [text, verb] of cases) {
      const c = parseNegativeClaim(text);
      if (c && c.verb === verb) ok++;
      else console.log(`        miss: "${text}" -> ${JSON.stringify(c)}`);
    }
    check("D1: the six claim shapes parse", ok === 6, `${ok}/6`);

    check("ordinary prose is NOT a negative claim",
      parseNegativeClaim("stage 2 decompresses into $C000 and jumps there") === undefined);
    check("a negative about nothing nameable is ignored",
      parseNegativeClaim("nothing reads it, as far as I can tell") === undefined,
      "no $address to check against -> not actionable, so not reported");
  }

  // --------------------------------- D1 against a graph that holds the counter-example
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "$F3 is read by nothing, exhaustive scan", evidence: ev });
    rec.saveFinding({ kind: "observation", title: "$4800-$53FF is unreferenced", addressRange: { start: 0x4800, end: 0x53ff }, evidence: ev });
    rec.saveFinding({ kind: "observation", title: "only $3E83 writes to disk", evidence: ev });
    rec.saveFinding({ kind: "observation", title: "stage 2 depacks into $C000", evidence: ev });

    const r = await critique(d);
    const refuted = r.findings.filter((f) => f.check === "negative-claim-refuted");
    check("D1: all three false negatives are refuted", refuted.length === 3,
      refuted.map((f) => f.title.slice(0, 34)).join(" | "));
    check("D1: the true statement is NOT flagged",
      !refuted.some((f) => /depacks/.test(f.title)), "precision matters more than recall here");
    check("D1: each refutation carries the edge that proves it",
      refuted.every((f) => /edge .* -> /.test(f.proof)),
      refuted[0]?.proof);
    check("D1: an `only` claim is refuted by naming the OTHER doer",
      refuted.some((f) => /also does it/.test(f.proof)),
      refuted.find((f) => /only/.test(f.title))?.proof);
    check("D1: an edge into the PLATFORM file still refutes",
      refuted.some((f) => /\$F3/.test(f.title) && /c64:zp:00f3/.test(f.proof)),
      refuted.find((f) => /\$F3/.test(f.title))?.proof);
    check("D1: a refuted negative claim is BLOCKING",
      refuted.every((f) => f.severity === "blocking"));
  }

  // ------------------------------------------------- refutation without a casualty
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "refutation", title: "create.prg DOES write the save", evidence: ev, addressRange: { start: 0x3e83, end: 0x3e99 } });
    let r = await critique(d);
    check("a refutation that killed nothing is BLOCKING",
      r.findings.some((f) => f.check === "refutation-without-casualty" && f.severity === "blocking"),
      r.findings.find((f) => f.check === "refutation-without-casualty")?.proof);

    rec.saveFinding({ kind: "refutation", title: "create.prg DOES write the save", evidence: ev, addressRange: { start: 0x3e83, end: 0x3e99 }, tags: ["amends:A_overlay_model.md"] });
    r = await critique(d);
    check("an `amends:` tag settles it",
      !r.findings.some((f) => f.check === "refutation-without-casualty"),
      "the refutation now names what it invalidated");
  }

  // ------------------------------------------------------------ the cheap record
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "looked at $4100" });
    const r = await critique(d);
    check("844's ratchet leak is closed: a record with no proof is caught",
      r.findings.some((f) => f.check === "finding-without-evidence"),
      r.findings.find((f) => f.check === "finding-without-evidence")?.proof);
  }

  // --------------------------------------------------------- the model-layer checks
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    await assertBoundary(d, { name: "engine", level: "container", start: 0x2000, end: 0x5fff, description: "the engine", evidence: ["header"], owner: "game" });
    await assertBoundary(d, { name: "engine again", level: "container", start: 0x3000, end: 0x4000, description: "overlaps on purpose", evidence: ["header"], owner: "game" });
    await assertBoundary(d, { name: "nowhere", level: "container", start: 0xe000, end: 0xe100, description: "over nothing", evidence: ["guess"], owner: "game" });
    const r = await critique(d);
    check("overlapping boundaries are found",
      r.findings.some((f) => f.check === "overlapping-boundaries"),
      r.findings.find((f) => f.check === "overlapping-boundaries")?.proof);
    check("a boundary over nothing is found",
      r.findings.some((f) => f.check === "empty-boundary" && /nowhere/.test(f.title)),
      r.findings.find((f) => f.check === "empty-boundary")?.proof);
  }

  // ------------------------------------------------------------------- the verdict
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({ kind: "observation", title: "$F3 is read by nothing", evidence: ev });

    const v = await verdict(d);
    check("D4: the verdict says NO", v.ready === false, `${v.blockers.length} blockers`);
    check("D4: it names what would flip it", v.blockers.length > 0 && v.blockers.every((b) => b.length > 4),
      v.blockers[0]);
    check("D4: the blocking critic finding is among the blockers",
      v.blockers.some((b) => b.startsWith("negative-claim-refuted")),
      v.blockers.filter((b) => !b.startsWith("slot ")).join(" ; "));

    const phase = await checkPhaseComplete(d);
    check("D4: checkPhaseComplete IS the verdict now",
      !phase.allowed && /the verdict is computed, and it says no/.test(phase.refusal ?? ""),
      (phase.refusal ?? "").split("\n")[0]);
  }

  // ------------------------------------------------------------ severity + surface
  {
    check("D3: every check declares a severity", CHECKS.every((c) => !!c.severity) && CHECKS.length >= 7,
      `${CHECKS.length} checks`);
    check("D3: every check says what would settle it", CHECKS.every((c) => c.settleBy.length > 10));
    check("exactly two checks are blocking",
      CHECKS.filter((c) => c.severity === "blocking").length === 2,
      CHECKS.filter((c) => c.severity === "blocking").map((c) => c.id).join(", "));
    check("the critic tools are on the DEFAULT surface",
      DEFAULT_TOOLS.has("project_critique") && DEFAULT_TOOLS.has("critic_checks"));
  }

  // --------------------------------------------------------- an empty critic is honest
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const r = await critique(d);
    const text = formatCritique(r);
    check("a project with no claims produces no blocking findings",
      r.counts.blocking === 0, `${r.counts.blocking} blocking`);
    // Consistency rather than a hardcoded count: a number goes stale the moment a spec
    // adds a check (847 added two), while this still catches the real defect — a check
    // that is defined but never runs, which is how a critic goes quietly blind.
    check("every DEFINED check actually runs, so silence is distinguishable from breakage",
      r.ran.length === CHECKS.length && CHECKS.every((c) => r.ran.includes(c.id)) && /Checks run:/.test(text),
      `${r.ran.length} ran of ${CHECKS.length} defined`);
    check("D5: the handover questions are questions, not prompts C64RE runs",
      r.handover.length === 0 || r.handover.every((q) => q.trim().endsWith("?")),
      r.handover[0] ?? "(none - fewer than two findings)");
  }
  // ---- Spec 849 §7: the orphan limit obeys the contract, and its source decides the bite
  //
  // The limit was declared in the contract, printed back by contract_show, and read by
  // nobody: a measured run sat at 62 % against a stated 50 % and the verdict said
  // nothing. A default is a preference and stays `important`; a number the human wrote
  // into the contract is a promise, and a broken promise blocks.
  {
    const dir = newProject(); dirs.push(dir);
    seedGraph(dir);                       // orphans, no boundaries asserted
    const { critique } = await import("../dist/critic/run.js");

    const noContract = await critique(dir);
    const a = noContract.findings.find((f) => f.check === "orphan-ratio");
    check("849: without a stated limit the orphan check stays advisory",
      !a || a.severity !== "blocking", a ? `${a.severity}: ${a.proof}` : "(not raised)");

    writeFileSync(join(dir, "knowledge", "contract.json"),
      JSON.stringify({ goal: "a test contract", limits: { orphanRatio: 0.01 } }, null, 2));
    const withContract = await critique(dir);
    const b = withContract.findings.find((f) => f.check === "orphan-ratio");
    check("849: a limit the human wrote makes the breach a blocker",
      !!b && b.severity === "blocking", b ? `${b.severity}: ${b.proof}` : "(not raised)");
    check("849: the proof names the contract as the source",
      !!b && /the project contract/.test(b.proof), b?.proof ?? "(none)");

    // With no boundary at all the ratio is 1.0 by definition, so the way to fall under a
    // limit is to assert the model — which is the point of the check.
    const { assertBoundary } = await import("../dist/model/store.js");
    await assertBoundary(dir, {
      name: "game", level: "container", start: 0x2c00, end: 0x5100,
      evidence: ["the routines in this window are the ones the listing shows"],
    });
    writeFileSync(join(dir, "knowledge", "contract.json"),
      JSON.stringify({ goal: "a test contract", limits: { orphanRatio: 0.5 } }, null, 2));
    const covered = await critique(dir);
    check("849: asserting the boundary is what clears the blocker",
      !covered.findings.some((f) => f.check === "orphan-ratio"), "no orphan-ratio finding");
  }
  // ---- #44: a routine reached by JMP / a branch is reached
  //
  // The control-flow producer points JUMPS_TO / BRANCHES_TO at a `label` node when the
  // target is not a JSR target; a human annotation then names the same address a
  // routine. The edge lands on `...:label:XXXX`, the routine is `...:routine:XXXX`. The
  // check has to join on the ADDRESS (owner, space, bank, address), not on the node id.
  {
    const dir = newProject(); dirs.push(dir);
    const store = GraphStore.open(dir);
    const gen = (id, kind, name) => ({ id, kind, name, origin: "static", confidence: "certain" });
    store.replaceGenerated("test", null, [
      gen(rid("game", "routine", 0x1000), "routine", "W1000"),
      gen(rid("game", "label", 0x1b89), "label", "W1b89"),
      gen(rid("game", "label", 0x192a), "label", "W192a"),
      gen(rid("other", "label", 0x3000), "label", "W3000"),
    ], [
      { from: rid("game", "routine", 0x1000), type: "JUMPS_TO", to: rid("game", "label", 0x1b89), evidenceKey: "a", origin: "static", confidence: "certain" },
      { from: rid("game", "routine", 0x1000), type: "BRANCHES_TO", to: rid("game", "label", 0x192a), evidenceKey: "b", origin: "static", confidence: "certain" },
      // another owner's node at the same NUMERIC address: not this routine's caller
      { from: rid("other", "label", 0x3000), type: "JUMPS_TO", to: rid("other", "label", 0x3000), evidenceKey: "c", origin: "static", confidence: "certain" },
    ]);
    const human = (addr, name) => store.upsertHuman({ id: rid("game", "routine", addr), kind: "routine", name });
    human(0x1b89, "main_entry");
    human(0x192a, "tick_game_won");
    human(0x2000, "truly_unreachable");
    human(0x3000, "other_owner_only");
    store.close();

    const r = await critique(dir);
    const un = r.findings.filter((f) => f.check === "unreachable-routine").map((f) => f.title);
    check("#44: a routine reached by `jmp` (edge into a label at its start) is not unreachable",
      !un.some((t) => /main_entry/.test(t)), un.join(" | "));
    check("#44: a routine reached by a branch is not unreachable",
      !un.some((t) => /tick_game_won/.test(t)), un.join(" | "));
    check("#44: the routine nothing points at is still reported",
      un.some((t) => /truly_unreachable/.test(t)), un.join(" | "));
    check("#44: an edge into ANOTHER owner's node at the same address does not count",
      un.some((t) => /other_owner_only/.test(t)), un.join(" | "));
  }
  // ---- #48: the critic's counter-example hunt and the refutation that settles it
  //
  // Three tape files load into the same window ($1000-$1FFF) at different times, so the
  // graph holds nodes of three owners at the same numeric addresses. The fixture mirrors
  // the reporter's: a claim about F1's bytes, a REFERENCES edge that belongs to F3.
  const seed48 = () => {
    const dir = newProject(); dirs.push(dir);
    const store = GraphStore.open(dir);
    const gen = (id, kind, name) => ({ id, kind, name, origin: "static", confidence: "certain" });
    store.replaceGenerated("test", null, [
      gen(rid("megavault_f3", "entry", 0x1008), "entry", "f3_entry"),
      gen(rid("megavault_f3", "segment", 0x1008), "segment", "f3_seg"),
      gen(rid("megavault_f1", "segment", 0x1008), "segment", "f1_seg"),
    ], [
      { from: rid("megavault_f3", "entry", 0x1008), type: "REFERENCES", to: rid("megavault_f3", "segment", 0x1008), evidenceKey: "a", origin: "static", confidence: "certain" },
    ]);
    store.close();
    return dir;
  };
  const negHits = async (dir) => (await critique(dir)).findings.filter((f) => f.check === "negative-claim-refuted");
  const ev48 = [{ kind: "artifact", title: "t", excerpt: "x", capturedAt: new Date().toISOString() }];

  // point 3: a refutation that quotes the claim's words is not itself a negative claim
  {
    const dir = seed48();
    const rec = new KnowledgeRecords(dir);
    const quote = { title: "the F1 'not referenced' claim was wrong", summary: "bytes at $1008 are 'not referenced' per the old finding", addressRange: { start: 0x1000, end: 0x1fff } };
    for (const [name, extra] of [["plain", {}], ["tagged routine", { tags: ["routine"] }], ["claim-door tags", { tags: ["analysis-import", "ram-hypothesis"] }]]) {
      const f = rec.saveFinding({ kind: "refutation", ...quote, title: `${quote.title} (${name})`, evidence: ev48, ...extra });
      check(`#48.3: a refutation saved with ${name} reads back as kind refutation`,
        rec.listFindings().find((x) => x.id === f.id)?.kind === "refutation", `${f.id} -> ${rec.listFindings().find((x) => x.id === f.id)?.kind}`);
    }
    check("#48.3: no refutation is flagged as a negative claim",
      (await negHits(dir)).length === 0, (await negHits(dir)).map((h) => h.title).join(" | "));

    // a claim-backed finding re-saved as the refutation that settles it keeps that kind
    const dir2 = seed48();
    const rec2 = new KnowledgeRecords(dir2);
    const claim = rec2.saveFinding({ kind: "hypothesis", title: "F1 bytes not referenced", addressRange: { start: 0x1000, end: 0x1fff }, tags: ["analysis-import", "ram-hypothesis"] });
    rec2.saveFinding({ id: claim.id, kind: "refutation", title: "F1 'not referenced' was wrong", status: "rejected" });
    const after = rec2.listFindings().find((x) => x.id === claim.id);
    check("#48.3: re-saving a claim-backed finding stores the title it was given",
      after?.title === "F1 'not referenced' was wrong", `title is ${after?.title}`);
    rec2.saveFinding({ id: claim.id, kind: "refutation", title: "F1 'not referenced' was wrong", summary: "settled by the F3 edge" });
    check("#48.3: ... and the summary; an update that omits it keeps it",
      rec2.listFindings().find((x) => x.id === claim.id)?.summary === "settled by the F3 edge");
    rec2.saveFinding({ id: claim.id, kind: "refutation", title: "F1 'not referenced' was wrong" });
    check("#48.3: ... omitted summary leaves the stored one",
      rec2.listFindings().find((x) => x.id === claim.id)?.summary === "settled by the F3 edge");
    check("#48.3: re-saving a claim-backed finding as kind refutation keeps the kind",
      after?.kind === "refutation", `kind is ${after?.kind}`);
  }

  // point 1: a counter-example must belong to the claim's owner when the finding names one
  {
    const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
    const dir = seed48();
    const store = GraphStore.open(dir);
    const gen = (id, kind, name) => ({ id, kind, name, origin: "static", confidence: "certain" });
    store.replaceGenerated("test2", null, [
      gen(rid("megavault_f1", "routine", 0x1000), "routine", "f1_writer"),
      gen(rid("megavault_f3", "routine", 0x1010), "routine", "f3_writer"),
      gen(rid("megavault_f3", "routine", 0x1020), "routine", "f3_zp"),
    ], [
      { from: rid("megavault_f1", "routine", 0x1000), type: "WRITES", to: aid(0xdd00), evidenceKey: "w1", origin: "static", confidence: "certain" },
      { from: rid("megavault_f3", "routine", 0x1010), type: "WRITES", to: aid(0xdd00), evidenceKey: "w3", origin: "static", confidence: "certain" },
      { from: rid("megavault_f3", "routine", 0x1020), type: "USES_ZP", to: "c64:zp:00f3", evidenceKey: "z3", origin: "static", confidence: "certain" },
      // a dangling project id (no node row): only the suffix branch can see it, and it is F3's
      { from: rid("megavault_f3", "routine", 0x1020), type: "CALLS", to: rid("megavault_f3", "routine", 0x2008), evidenceKey: "d3", origin: "static", confidence: "certain" },
    ]);
    store.close();
    const svc = new ProjectKnowledgeService(dir);
    const f1 = svc.saveArtifact({ kind: "prg", scope: "input", title: "megavault_f1.prg", path: "megavault_f1.prg", role: "tape-file" });
    const f3 = svc.saveArtifact({ kind: "prg", scope: "input", title: "megavault_f3.prg", path: "megavault_f3.prg", role: "tape-file" });
    const range = { start: 0x1000, end: 0x1fff };
    const saved = (title, artifactIds) => svc.saveFinding({ kind: "observation", title, addressRange: range, artifactIds, evidence: [], tags: [] });
    const hitsFor = async (title) => (await negHits(dir)).filter((h) => h.title.includes(title));

    saved("F1 window $1000-$1FFF not referenced", [f1.id]);
    check("#48.1: a claim about F1 is not refuted by an edge of F3 in the same window",
      (await hitsFor("F1 window $1000-$1FFF not referenced")).length === 0, (await hitsFor("F1 window $1000-$1FFF not referenced")).map((h) => h.proof).join(" | "));
    saved("F3 window $1000-$1FFF not referenced", [f3.id]);
    const own = await hitsFor("F3 window $1000-$1FFF not referenced");
    check("#48.1: a claim about F3 IS refuted by F3's own edge, and the proof names the owner",
      own.length === 1 && /\[owner megavault_f3\]/.test(own[0].proof), own.map((h) => h.proof).join(" | "));
    saved("anon window $1000-$1FFF not referenced", []);
    const anon = await hitsFor("anon window $1000-$1FFF not referenced");
    check("#48.1: a finding that names no subject still matches any owner, and the proof shows whose edge it was",
      anon.length === 1 && /\[owner megavault_f3\]/.test(anon[0].proof), anon.map((h) => h.proof).join(" | "));

    svc.saveFinding({ kind: "observation", title: "F1 zp: $F3 is read by nothing", artifactIds: [f1.id], evidence: [], tags: [] });
    check("#48.1: zero page is shared - a platform edge still refutes a claim about F1",
      (await hitsFor("F1 zp: $F3")).length === 1, (await hitsFor("F1 zp: $F3")).map((h) => h.proof).join(" | "));

    svc.saveFinding({ kind: "observation", title: "F1 $2008 is not referenced", artifactIds: [f1.id], evidence: [], tags: [] });
    svc.saveFinding({ kind: "observation", title: "F3 $2008 is not referenced", artifactIds: [f3.id], evidence: [], tags: [] });
    check("#48.1: a dangling id of another owner (suffix branch) does not refute a claim about F1, and does refute F3's",
      (await hitsFor("F1 $2008")).length === 0 && (await hitsFor("F3 $2008")).length === 1,
      `F1: ${(await hitsFor("F1 $2008")).length}, F3: ${(await hitsFor("F3 $2008")).length}`);

    // "only $X writes": the other writer must be the same owner's
    svc.saveFinding({ kind: "observation", title: "F1 only $1000 writes to disk", artifactIds: [f1.id], evidence: [], tags: [] });
    svc.saveFinding({ kind: "observation", title: "anon only $1000 writes to disk", evidence: [], tags: [] });
    check("#48.1: 'only $1000 writes' about F1 is not refuted by F3's writer at another address",
      (await hitsFor("F1 only $1000")).length === 0, (await hitsFor("F1 only $1000")).map((h) => h.proof).join(" | "));
    check("#48.1: the same claim with no subject is still refuted by any owner's writer",
      (await hitsFor("anon only $1000")).length === 1, (await hitsFor("anon only $1000")).map((h) => h.proof).join(" | "));
  }

  // point 2: an update without address_range leaves the stored range alone; `null` removes it
  {
    const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
    const dir = seed48();
    const svc = new ProjectKnowledgeService(dir);
    const rec = new KnowledgeRecords(dir);
    const f = svc.saveFinding({ kind: "observation", title: "F1 $1100 not referenced", summary: "first", addressRange: { start: 0x1000, end: 0x1fff }, evidence: [], tags: [] });
    const rangeOf = (id) => rec.listFindings().find((x) => x.id === id)?.addressRange;
    const hit = async () => (await negHits(dir)).some((h) => h.title.includes("F1 $1100"));
    check("#48.2: the range makes the finding hit F3's edge at $1008 (baseline)", await hit());
    const same = svc.saveFinding({ id: f.id, kind: "observation", title: "F1 $1100 not referenced", summary: "second", evidence: [], tags: [] });
    check("#48.2: an update that omits address_range keeps the stored range",
      rangeOf(same.id)?.start === 0x1000 && rangeOf(same.id)?.end === 0x1fff, JSON.stringify(rangeOf(same.id)));
    const cleared = svc.saveFinding({ id: f.id, kind: "observation", title: "F1 $1100 not referenced", summary: "third", addressRange: null, evidence: [], tags: [] });
    check("#48.2: address_range: null removes the stored range", rangeOf(cleared.id) === undefined, JSON.stringify(rangeOf(cleared.id)));
    check("#48.2: the cleared finding is only checked at the address it names",
      !(await hit()), (await negHits(dir)).map((h) => h.proof).join(" | "));
    check("#48.2: clearing the range keeps the rest of the update",
      rec.listFindings().find((x) => x.id === cleared.id)?.summary === "third");
    const again = svc.saveFinding({ id: f.id, kind: "observation", title: "F1 $1100 not referenced", summary: "fourth", evidence: [], tags: [] });
    check("#48.2: after clearing, an omitting update does not bring the range back", rangeOf(again.id) === undefined, JSON.stringify(rangeOf(again.id)));
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe critic bites" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
