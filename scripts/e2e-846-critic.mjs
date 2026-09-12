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
    check("D3: every check declares a severity", CHECKS.every((c) => !!c.severity) && CHECKS.length === 7,
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
    check("the report says which checks RAN, so silence is distinguishable from breakage",
      r.ran.length === 7 && /Checks run:/.test(text), r.ran.join(","));
    check("D5: the handover questions are questions, not prompts C64RE runs",
      r.handover.length === 0 || r.handover.every((q) => q.trim().endsWith("?")),
      r.handover[0] ?? "(none - fewer than two findings)");
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe critic bites" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
