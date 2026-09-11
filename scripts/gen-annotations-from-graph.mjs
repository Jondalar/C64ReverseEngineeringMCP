#!/usr/bin/env node
// Spec 843 D8 — project the annotations file OUT of the graph.
//
// The question this answers is "what is authoritative". The graph is, for meaning:
// it is already the authority for findings, entities and questions, it can express
// relations a JSON file cannot, and it is where the Inspect overlay writes.
//
// But the renderer must not read it. A listing has to stay a pure function of files
// in the repo, because this repo's verification standard is a byte-identical rebuild
// — put a mutable database in front of `disasm_prg` and "run this and get the same
// listing" stops being true. So the graph is the source, the annotations file is the
// generated artifact, and `disasm_prg` is untouched.
//
// That is the `gen:tool-surface` pattern: generate, commit, and let `--check` in CI
// report drift instead of letting two authorities disagree in silence.
//
//   node scripts/gen-annotations-from-graph.mjs <project-dir> [--check]
//
// Exit 0 = written / in sync. Exit 1 = drift (with --check).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const projectDir = args.find((a) => !a.startsWith("--")) ?? process.env.C64RE_PROJECT_DIR ?? process.cwd();

const { ProjectKnowledgeService } = await import("../dist/project-knowledge/service.js");
const service = new ProjectKnowledgeService(projectDir);

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

/**
 * A finding becomes a `segments` entry when it carries an address RANGE and names a
 * screen element. A finding without a range is knowledge about something other than
 * a byte span and has no place in an annotations file — it is not dropped, it simply
 * was never an annotation.
 */
function segmentsFromFindings(findings) {
  const out = [];
  for (const f of findings) {
    if (f.status === "archived" || f.status === "rejected") continue;
    const r = f.addressRange;
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end < r.start) continue;
    const kindTag = (f.tags ?? []).find((t) =>
      ["charset", "bitmap", "sprite", "screen_ram", "color_ram", "text", "data"].includes(t));
    out.push({
      start: `$${hex4(r.start)}`,
      end: `$${hex4(r.end)}`,
      kind: kindTag === "screen_ram" || kindTag === "color_ram" ? "data" : (kindTag ?? "data"),
      label: labelOf(f),
      comment: `${f.title}${f.summary ? ` — ${f.summary}` : ""}`,
      // Spec 842 — a relocated annotation says which space it is written in. These
      // come from runtime addresses, because that is what the machine reported.
      space: "runtime",
    });
  }
  // Deterministic: the file is compared byte-for-byte by `--check`, so the order may
  // not depend on insertion or on a map's iteration.
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.label.localeCompare(b.label)));
  return out;
}

/** A label an assembler will accept, derived from the finding's own name. */
function labelOf(f) {
  const base = (f.title ?? "element")
    .replace(/\$[0-9a-fA-F]{2,4}/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const addr = f.addressRange ? hex4(f.addressRange.start) : "0000";
  return base ? `${base}_${addr}`.toLowerCase() : `elem_${addr.toLowerCase()}`;
}

const findings = service.listFindings();
const segments = segmentsFromFindings(findings);

const outPath = join(projectDir, "knowledge", "generated", "graph_annotations.json");
const body = JSON.stringify({
  // Says where it came from, so nobody hand-edits a generated file and loses it.
  _generated: "scripts/gen-annotations-from-graph.mjs — edit the GRAPH, not this file",
  segments,
}, null, 2) + "\n";

if (check) {
  if (!existsSync(outPath)) {
    console.log(`check:annotations-projection — MISSING: ${outPath}`);
    console.log(`  ${segments.length} segment(s) in the graph have no projected file. Run:`);
    console.log(`  node scripts/gen-annotations-from-graph.mjs ${projectDir}`);
    process.exitCode = 1;
  } else if (readFileSync(outPath, "utf8") !== body) {
    console.log(`check:annotations-projection — DRIFT: ${outPath}`);
    console.log(`  the graph holds ${segments.length} annotatable finding(s); the file disagrees.`);
    console.log(`  Regenerate: node scripts/gen-annotations-from-graph.mjs ${projectDir}`);
    process.exitCode = 1;
  } else {
    console.log(`check:annotations-projection — in sync (${segments.length} segment(s))`);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);
  console.log(`wrote ${outPath}: ${segments.length} segment(s) from ${findings.length} finding(s)`);
}
