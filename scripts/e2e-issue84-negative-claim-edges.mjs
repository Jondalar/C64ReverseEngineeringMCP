#!/usr/bin/env node
// Issue #84 — only edges that are real uses of an address refute a negative claim.
//
// "X has no caller" was "refuted" by the RESOLVES_TO edge from the address node $0C8F to the
// routine at $0C8F: an identity edge, not a caller. The graph below holds, per claim:
//   $0C8F  routine, an addr alias RESOLVES_TO it, nothing else         -> "no caller" NOT refuted
//   $0D00  routine called by a routine at another address               -> refuted (CALLS)
//   $0E00  routine reached only by a pointer-table reference            -> "no caller" refuted, "never called" refuted
//   $0F00  routine whose only incoming edge is its own internal branch  -> NOT refuted (source spans target)
//   $1000  routine whose only incoming edge is a human DOCUMENTS link   -> NOT refuted, "not checked" note, not blocking
//   $2000  data byte READ by a routine                                  -> "never written" NOT refuted, "never read" refuted
//   $2100  data byte WRITTEN by a routine                               -> "never written" refuted
//   $1100  routine with only a CONTAINS label and a read claim          -> "no reader" NOT refuted
//   $1200  routine only entered by an IRQ vector (HANDLES_IRQ)          -> "no caller" refuted
// Hermetic: temp project, no daemon, no ROMs.   npm run e2e:issue84-negative-claim-edges
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { critique } = await import("../dist/critic/run.js");
const { parseNegativeClaim } = await import("../dist/critic/negative-claims.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "edges84";
const OWNER = "game";
const h4 = (a) => a.toString(16).padStart(4, "0");
const rid = (kind, addr) => `${SLUG}:ram/${OWNER}:${kind}:${h4(addr)}`;
const aid = (addr) => `${SLUG}:ram:addr:${h4(addr)}`;
const gen = (id, kind, address, extra = {}) => ({ id, kind, name: `${kind}_${h4(address)}`, origin: "static", confidence: "certain", ...extra });
const edge = (from, type, to, key = "k") => ({ from, type, to, evidenceKey: key, origin: "static", confidence: "certain" });

// parse level
check("'no callers' is a caller claim, 'no readers' a read claim, 'no writers' a write claim",
  parseNegativeClaim("$0C8F has no callers")?.verb === "caller"
  && parseNegativeClaim("$0C8F has no readers")?.verb === "read"
  && parseNegativeClaim("$0C8F has no writers")?.verb === "write"
  && parseNegativeClaim("$0C8F has no references")?.verb === "any");

const dir = mkdtempSync(join(tmpdir(), "c64re-84-"));
try {
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }));
  const store = GraphStore.open(dir);
  const routines = [0x0c8f, 0x0d00, 0x0e00, 0x0f00, 0x1000, 0x1100, 0x1200, 0x0a00, 0x0a40, 0x0a80, 0x0ac0, 0x0b00];
  const nodes = [
    ...routines.map((a) => gen(rid("routine", a), "routine", a, { endAddress: a === 0x0f00 ? 0x0f2f : undefined })),
    gen(aid(0x0c8f), "addr", 0x0c8f),
    gen(rid("label", 0x0f10), "label", 0x0f10),
    gen(rid("label", 0x1100), "label", 0x1100),
    gen(aid(0x2000), "addr", 0x2000),
    gen(aid(0x2100), "addr", 0x2100),
  ];
  const edges = [
    // $0C8F: identity only (the issue)
    edge(aid(0x0c8f), "RESOLVES_TO", rid("routine", 0x0c8f)),
    // $0D00: a real call from another address
    edge(rid("routine", 0x0a00), "CALLS", rid("routine", 0x0d00)),
    // $0E00: a pointer / table reference only
    edge(rid("routine", 0x0a40), "REFERENCES_DATA", rid("routine", 0x0e00)),
    // $0F00: only an internal branch to its own label (the routine spans the label)
    edge(rid("routine", 0x0f00), "BRANCHES_TO", rid("label", 0x0f10)),
    edge(rid("routine", 0x0f00), "CONTAINS", rid("label", 0x0f10), ""),
    // $1100: a CONTAINS label, nothing else
    edge(rid("routine", 0x1100), "CONTAINS", rid("label", 0x1100), ""),
    // $1200: entered by an interrupt vector
    edge(rid("routine", 0x0a80), "HANDLES_IRQ", rid("routine", 0x1200)),
    // data: read at $2000, written at $2100
    edge(rid("routine", 0x0ac0), "READS", aid(0x2000)),
    edge(rid("routine", 0x0b00), "WRITES", aid(0x2100)),
  ];
  store.replaceGenerated("test", null, nodes, edges);
  // $1000: a human edge of a kind nobody classified
  store.db.prepare(
    "INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, 'DOCUMENTS', ?, 'human', '', 'user', 'user_asserted', 'test', NULL, '{}')",
  ).run(rid("routine", 0x0a00), rid("routine", 0x1000));
  store.close();

  const svc = new ProjectKnowledgeService(dir);
  const art = svc.saveArtifact({ kind: "prg", scope: "input", title: "game.prg", path: "game.prg", role: "game" });
  const save = (title) => svc.saveFinding({ kind: "observation", title, evidence: [], tags: [], artifactIds: [art.id] });
  save("T1: routine $0C8F has no caller");
  save("T2: routine $0D00 has no caller");
  save("T3: routine $0E00 has no caller");
  save("T4: routine $0F10 has no caller");
  save("T5: routine $1000 has no caller");
  save("T6: $2000 is never written");
  save("T7: $2100 is never written");
  save("T8: $2000 is never read");
  save("T9: $1100 has no readers");
  save("T10: routine $1200 has no caller");
  save("T11: $0C8F is unused");
  save("T12: routine $0E00 is never called");
  save("T13: routine $0C8F is unreferenced");

  const hits = (await critique(dir)).findings.filter((f) => f.check === "negative-claim-refuted");
  const of = (p) => hits.filter((h) => h.title.startsWith(`"${p}:`));
  const refuted = (p) => of(p).filter((h) => h.severity === "blocking");
  const dump = (p) => of(p).map((h) => `${h.severity} ${h.title} :: ${h.proof}`).join(" | ");

  check("T1 identity edge only (RESOLVES_TO addr -> routine): NOT refuted", of("T1").length === 0, dump("T1"));
  check("T2 real CALLS from another address: refuted, proof names CALLS and the kinds considered",
    refuted("T2").length === 1 && /CALLS edge/.test(of("T2")[0].proof) && /edge kinds considered/.test(of("T2")[0].proof) && /REFERENCES_DATA/.test(of("T2")[0].proof), dump("T2"));
  check("T3 pointer/table reference: 'no caller' refuted (REFERENCES_DATA)", refuted("T3").length === 1 && /REFERENCES_DATA edge/.test(of("T3")[0].proof), dump("T3"));
  check("T4 internal branch inside the routine (source spans target): NOT refuted", of("T4").length === 0, dump("T4"));
  const t5 = of("T5");
  check("T5 unclassified human kind (DOCUMENTS): NOT refuted, 'not checked' note, not blocking",
    t5.length === 1 && t5[0].severity === "nice-to-have" && /not refuted, DOCUMENTS edges not checked/.test(t5[0].title), dump("T5"));
  check("T6 READS edge vs 'never written': NOT refuted", of("T6").length === 0, dump("T6"));
  check("T7 WRITES edge vs 'never written': refuted", refuted("T7").length === 1 && /WRITES edge/.test(of("T7")[0].proof), dump("T7"));
  check("T8 READS edge vs 'never read': refuted", refuted("T8").length === 1, dump("T8"));
  check("T9 CONTAINS label vs 'no readers': NOT refuted", of("T9").length === 0, dump("T9"));
  check("T10 HANDLES_IRQ vs 'no caller': refuted", refuted("T10").length === 1 && /HANDLES_IRQ edge/.test(of("T10")[0].proof), dump("T10"));
  check("T11 identity edge vs 'unused': NOT refuted", of("T11").length === 0, dump("T11"));
  check("T12 pointer reference vs 'never called': refuted", refuted("T12").length === 1, dump("T12"));
  check("T13 identity edge vs 'unreferenced': NOT refuted", of("T13").length === 0, dump("T13"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nonly real uses refute a negative claim" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
