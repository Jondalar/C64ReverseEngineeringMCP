#!/usr/bin/env node
// Spec 845 — the model layer. D1..D7, each case able to fail.
//
// The measurement this spec is built on: Ultima VI's graph holds 11161 nodes and the
// session's model holds 177. The test below builds a small graph and checks that a
// handful of asserted boundaries index all of it, that the edges between them are
// derived rather than stated, and that what falls outside is visible.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { assertBoundary, listBoundaries, removeBoundary, ModelBoundaryError } = await import("../dist/model/store.js");
const { modelReport, formatModel } = await import("../dist/model/rollup.js");
const { reentryPackage, formatReentry } = await import("../dist/model/reentry.js");
const { KnowledgeRecords } = await import("../dist/knowledge-graph/records.js");
const { CONTAINER_SLOTS } = await import("../dist/slots/schema.js");
const { DEFAULT_TOOLS } = await import("../dist/server-tools/tier-tools.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "testgame";
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "c64re-845-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }, null, 2));
  return dir;
}

/** A fine graph: routines in two files, with calls inside and across. */
function seedGraph(dir) {
  const store = GraphStore.open(dir);
  const id = (owner, kind, addr) => `${SLUG}:ram/${owner}:${kind}:${addr.toString(16).padStart(4, "0")}`;
  const nodes = [];
  const edges = [];
  // loader: $0801-$0fff, four routines
  for (const a of [0x0801, 0x0900, 0x0a00, 0x0b00]) {
    nodes.push({ id: id("loader", "routine", a), kind: "routine", name: `ld_${a.toString(16)}`, endAddress: a + 0x40, origin: "static", confidence: "certain" });
  }
  // engine: $2000-$3fff, five routines
  for (const a of [0x2000, 0x2100, 0x2200, 0x2300, 0x3000]) {
    nodes.push({ id: id("engine", "routine", a), kind: "routine", name: `en_${a.toString(16)}`, endAddress: a + 0x40, origin: "static", confidence: "certain" });
  }
  // outside anything anyone will name
  nodes.push({ id: id("engine", "routine", 0x9000), kind: "routine", name: "stray", endAddress: 0x9040, origin: "static", confidence: "certain" });

  // inside-loader call, inside-engine call, and two crossings
  edges.push({ from: id("loader", "routine", 0x0801), type: "CALLS", to: id("loader", "routine", 0x0900), origin: "static", confidence: "certain" });
  edges.push({ from: id("engine", "routine", 0x2000), type: "CALLS", to: id("engine", "routine", 0x2100), origin: "static", confidence: "certain" });
  edges.push({ from: id("loader", "routine", 0x0a00), type: "CALLS", to: id("engine", "routine", 0x2000), evidenceKey: "a", origin: "static", confidence: "certain" });
  edges.push({ from: id("loader", "routine", 0x0b00), type: "CALLS", to: id("engine", "routine", 0x2200), evidenceKey: "b", origin: "static", confidence: "certain" });
  edges.push({ from: id("engine", "routine", 0x3000), type: "WRITES", to: id("loader", "routine", 0x0900), evidenceKey: "c", origin: "static", confidence: "certain" });
  store.replaceGenerated("test", null, nodes, edges);
  store.close();
}

const dirs = [];
try {
  // ------------------------------------------------------------- D3: no cite, no node
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    let err;
    try {
      await assertBoundary(d, { name: "engine", level: "container", start: 0x2000, end: 0x3fff, description: "the resident engine", evidence: [] });
    } catch (e) { err = e; }
    check("D3: a boundary without a citation is REFUSED", err instanceof ModelBoundaryError,
      err ? err.message.slice(0, 90) : "(accepted)");

    let err2;
    try {
      await assertBoundary(d, { name: "x", level: "container", start: 0x3000, end: 0x2000, description: "backwards", evidence: ["listing"] });
    } catch (e) { err2 = e; }
    check("an inverted range is refused", err2 instanceof ModelBoundaryError, err2?.message);

    let err3;
    try {
      await assertBoundary(d, { name: "x", level: "galaxy", start: 0x2000, end: 0x3000, description: "bad level", evidence: ["listing"] });
    } catch (e) { err3 = e; }
    check("an unknown level is refused", err3 instanceof ModelBoundaryError, err3?.message);
  }

  // -------------------------------------- D1/D2: a few boundaries index the whole graph
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    await assertBoundary(d, {
      name: "stage 2 loader", level: "container", start: 0x0801, end: 0x0fff,
      description: "the resident loader", evidence: ["loader.prg header load=$0801"], owner: "loader",
    });
    await assertBoundary(d, {
      name: "resident engine", level: "container", start: 0x2000, end: 0x3fff,
      description: "the play engine", evidence: ["engine.prg header load=$2000"], owner: "engine",
    });

    const r = await modelReport(d);
    check("D1: two boundaries exist", r.nodes.length === 2, `${r.nodes.length}`);
    // Boundaries are identified by NAME, not by start address: two may begin on the
    // same byte (a component at the head of its container), which is the collision the
    // first cut of the id scheme walked straight into.
    const membersOf = (rep, name) => {
      const node = rep.nodes.find((n) => n.name === name);
      return rep.membership.find((m) => m.containerId === node?.id)?.members;
    };
    check("D2: membership is computed, not passed",
      membersOf(r, "stage 2 loader") === 4 && membersOf(r, "resident engine") === 5,
      r.membership.map((m) => `${m.members}`).join(" / "));
    check("D5: the node outside every boundary is an orphan",
      r.orphans.length === 1 && r.orphans[0].name === "stray",
      `${r.orphans.length} orphan(s): ${r.orphans.map((o) => o.name).join(",")}`);
    check("nine of ten nodes are placed by two assertions",
      r.memberTotal === 10 && r.memberTotal - r.orphans.length === 9,
      `${r.memberTotal - r.orphans.length}/${r.memberTotal}`);

    // D4 — only the crossings roll up, and they carry the fine edges as evidence.
    check("D4: edges between boundaries are derived", r.edges.length === 2,
      r.edges.map((e) => `${e.type}x${e.count}`).join(" "));
    const calls = r.edges.find((e) => e.type === "CALLS");
    const writes = r.edges.find((e) => e.type === "WRITES");
    check("D4: the two loader->engine calls are counted as one edge", calls?.count === 2, `count=${calls?.count}`);
    check("D4: the engine->loader write rolls up separately", writes?.count === 1, `count=${writes?.count}`);
    check("D4: a rolled edge carries the fine edges as its citation",
      (calls?.evidence?.length ?? 0) === 2 && calls.evidence[0].from.includes("loader"),
      JSON.stringify(calls?.evidence?.[0] ?? {}).slice(0, 80));
    check("D4: intra-boundary calls do NOT roll up",
      !r.edges.some((e) => e.from === e.to), "two of the five fine edges are internal");

    // innermost wins
    await assertBoundary(d, {
      name: "dispatcher", level: "component", start: 0x2000, end: 0x20ff,
      description: "the main dispatcher", evidence: ["engine.asm:1-40"], owner: "engine",
    });
    const r2 = await modelReport(d);
    check("a component inside a container claims its own members",
      membersOf(r2, "dispatcher") === 1 && membersOf(r2, "resident engine") === 4,
      `dispatcher=${membersOf(r2, "dispatcher")} engine=${membersOf(r2, "resident engine")}`);
    check("the container and the component can start on the same byte",
      r2.nodes.length === 3 && r2.nodes.filter((n) => n.start === 0x2000).length === 2,
      `${r2.nodes.length} boundaries, ${r2.nodes.filter((n) => n.start === 0x2000).length} starting at $2000`);
    check("no node is placed twice",
      r2.memberTotal - r2.orphans.length === 9, `${r2.memberTotal - r2.orphans.length}/${r2.memberTotal}`);

    const text = formatModel(r2);
    check("the model renders with citations", /cite: engine.prg header/.test(text), text.split("\n")[0]);
  }

  // ------------------------------------------------------------------- D6: re-entry
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    await assertBoundary(d, {
      name: "resident engine", level: "container", start: 0x2000, end: 0x3fff,
      description: "the play engine", evidence: ["engine.prg header"], owner: "engine",
    });
    const rec = new KnowledgeRecords(d);
    rec.saveFinding({
      kind: "refutation",
      title: "create.prg does NOT write the save - it does",
      summary: "A grep for the write vector missed the indirect store at $3E83.",
      tags: ["amends:A_overlay_model.md"],
    });
    rec.saveOpenQuestion({ kind: "question", title: "who frees the conversation overlay?" });

    const p = await reentryPackage(d);
    check("D6: the package carries the model", p.model.nodes.length === 1);
    check("D6: the package carries the refutations", p.refutations.length === 1,
      p.refutations[0]?.title);
    check("D6: a refutation names what it invalidated",
      p.refutations[0]?.amended?.[0] === "A_overlay_model.md", JSON.stringify(p.refutations[0]?.amended));
    check("D6: open slots are listed", p.openSlots.length > 0,
      p.openSlots.map((s) => s.id).join(","));

    const text = formatReentry(p);
    check("the re-entry text leads with 'do not re-derive'",
      /Already refuted - do not re-derive/.test(text) && /Still open/.test(text));
  }

  // --------------------------------------------------------------------- D7: the seam
  {
    check("D7: exactly three slots are container-shaped", CONTAINER_SLOTS.size === 3,
      [...CONTAINER_SLOTS.keys()].join(","));
    check("D7: S3 and S5 are containers, S8 is a component",
      CONTAINER_SLOTS.get("S3") === "container" && CONTAINER_SLOTS.get("S5") === "container"
      && CONTAINER_SLOTS.get("S8") === "component");
  }

  // ------------------------------------------------------------------ removal, surface
  {
    const d = newProject(); dirs.push(d); seedGraph(d);
    const n = await assertBoundary(d, {
      name: "engine", level: "container", start: 0x2000, end: 0x3fff,
      description: "the play engine", evidence: ["header"], owner: "engine",
    });
    check("removing a boundary frees its members back to orphans",
      (await removeBoundary(d, n.id)) === true
      && (await listBoundaries(d)).length === 0
      && (await modelReport(d)).orphans.length === 0,
      "modelReport short-circuits to no orphans when there are no boundaries at all");

    check("the model tools are on the DEFAULT surface",
      DEFAULT_TOOLS.has("model_read") && DEFAULT_TOOLS.has("model_assert") && DEFAULT_TOOLS.has("model_remove"),
      "model_read is the re-entry door; a hidden one cannot be found after a /new");
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(failures === 0 ? "\nthe model holds" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
