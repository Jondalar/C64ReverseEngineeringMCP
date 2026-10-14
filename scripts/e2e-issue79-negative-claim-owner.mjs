#!/usr/bin/env node
// Issue #79 — a negative claim ("X has no caller") is judged against the owner it is about.
//
// Two game images load at the same addresses ($0801+). The graph holds a routine of each at
// $0C8F. A caller edge exists only in game B.
//   * a claim citing game A (artifact_ids)      -> NOT refuted by B's caller
//   * a claim citing game B                     -> refuted, and the proof names B
//   * a claim citing nothing, shared address    -> flagged AMBIGUOUS (not blocking), never "refuted"
//   * a caller edge in A, claim cites A         -> refuted
// Hermetic: temp project, no daemon, no ROMs.   npm run e2e:issue79-negative-claim-owner
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GraphStore } = await import("../dist/knowledge-graph/store.js");
const { critique } = await import("../dist/critic/run.js");
const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

const SLUG = "griffin";
const rid = (owner, kind, addr) => `${SLUG}:ram/${owner}:${kind}:${addr.toString(16).padStart(4, "0")}`;
const gen = (id, kind, name) => ({ id, kind, name, origin: "static", confidence: "certain" });

const dir = mkdtempSync(join(tmpdir(), "c64re-79-"));
try {
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ name: SLUG, slug: SLUG }));
  const store = GraphStore.open(dir);
  store.replaceGenerated("test", null, [
    gen(rid("sherwood", "routine", 0x0c8f), "routine", "hud_print_score2"),
    gen(rid("sherwood", "routine", 0x0d00), "routine", "sherwood_main"),
    gen(rid("joan", "routine", 0x0c8f), "routine", "joan_routine"),
    gen(rid("joan", "routine", 0x0d00), "routine", "joan_main"),
    gen(rid("sherwood", "routine", 0x0e00), "routine", "sherwood_unused"),
    gen(rid("sherwood", "routine", 0x0e40), "routine", "sherwood_caller2"),
  ], [
    // a caller of $0C8F — in JOAN only
    { from: rid("joan", "routine", 0x0d00), type: "CALLS", to: rid("joan", "routine", 0x0c8f), evidenceKey: "j", origin: "static", confidence: "certain" },
    // a caller of $0E00 — in SHERWOOD
    { from: rid("sherwood", "routine", 0x0e40), type: "CALLS", to: rid("sherwood", "routine", 0x0e00), evidenceKey: "s", origin: "static", confidence: "certain" },
  ]);
  store.close();

  const svc = new ProjectKnowledgeService(dir);
  const sher = svc.saveArtifact({ kind: "prg", scope: "input", title: "sherwood.prg", path: "sherwood.prg", role: "game" });
  const joan = svc.saveArtifact({ kind: "prg", scope: "input", title: "joan.prg", path: "joan.prg", role: "game" });
  const save = (title, artifactIds) => svc.saveFinding({ kind: "observation", title, evidence: [], tags: [], artifactIds });
  save("A: $0C8F has no caller", [sher.id]);
  save("B: $0C8F has no caller", [joan.id]);
  save("anon: $0C8F has no caller", []);
  save("A2: $0E00 has no caller", [sher.id]);

  const hits = (await critique(dir)).findings.filter((f) => f.check === "negative-claim-refuted");
  const of = (prefix) => hits.filter((h) => h.title.startsWith(`"${prefix}:`));

  check("claim on owner A, caller only in owner B: not refuted, not flagged", of("A").length === 0,
    of("A").map((h) => h.title + " :: " + h.proof).join(" | "));
  const b = of("B");
  check("claim on owner B, caller in B: refuted (blocking), proof names owner B",
    b.length === 1 && b[0].severity === "blocking" && /\[owner joan\]/.test(b[0].proof) && !/ambiguous/.test(b[0].title),
    b.map((h) => h.severity + " " + h.title + " :: " + h.proof).join(" | "));
  const anon = of("anon");
  check("claim citing no owner at a shared address: ambiguous, NOT refuted, NOT blocking",
    anon.length === 1 && /ambiguous, not refuted/.test(anon[0].title) && anon[0].severity !== "blocking"
      && /joan/.test(anon[0].proof) && /sherwood/.test(anon[0].proof) && /artifact_ids/.test(anon[0].proof),
    anon.map((h) => h.severity + " " + h.title + " :: " + h.proof).join(" | "));
  const a2 = of("A2");
  check("caller edge in owner A, claim cites A: refuted (blocking)",
    a2.length === 1 && a2[0].severity === "blocking" && /\[owner sherwood\]/.test(a2[0].proof) && !/ambiguous/.test(a2[0].title),
    a2.map((h) => h.severity + " " + h.title + " :: " + h.proof).join(" | "));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nthe owner scope holds" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
