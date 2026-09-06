#!/usr/bin/env node
// Spec 822.2 — the gate that closes the coexistence window (822 §6).
//
// After the cut-over, knowledge/{findings,entities,relations,open-questions,
// labels.user}.json are not a store: nothing under src/ may read or write them,
// name their storage loaders, or reach them through the old path keys. The
// migration (src/knowledge-graph/migrate/**) reads them — that is what it is
// for — the cut-over moves them, and `c64re graph export` writes the shape back
// on demand; everything else is a second store, which is the drift 817 exists
// to kill. Red while any such line exists; green is what makes 822 DONE.
//
//   node scripts/check-822-no-json-readers.mjs        exit 0 = green, 1 = red

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

// files that MAY name the legacy stores: the migration, the cut-over, the export
const ALLOW = [
  /^src\/knowledge-graph\/migrate\//u,
  /^src\/knowledge-graph\/cutover\.ts$/u,
  /^src\/knowledge-graph\/export\.ts$/u,
];

const PATTERNS = [
  { re: /\b(?:findings|entities|relations|open-questions|labels\.user)\.json\b/u, what: "names a migrated legacy file" },
  { re: /\b(?:load|save)(?:Entities|Findings|Relations|OpenQuestions|UserLabels)\s*\(/u, what: "calls a legacy store loader/saver" },
  { re: /\bknowledge(?:Entities|Findings|Relations|OpenQuestions|LabelsUser)\b/u, what: "reaches a legacy store path key" },
  { re: /\b(?:Entity|Finding|Relation|OpenQuestion|UserLabel)StoreSchema\b/u, what: "parses a legacy store file shape" },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { if (entry !== "node_modules") walk(p, out); }
    else if (/\.(?:ts|js|mjs)$/u.test(entry) && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const hits = [];
let scanned = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOW.some((re) => re.test(rel))) continue;
  scanned += 1;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push(`${rel}:${i + 1}: ${p.what}: ${line.trim().slice(0, 110)}`);
    }
  });
}

// the storage schema for the six must be gone from the types as a *store* (records stay: they are the graph's projection shape)
console.log(`Spec 822.2 — no JSON reader/writer of the migrated stores under src/ (${scanned} files scanned, ${ALLOW.length} allowed paths)\n`);
if (hits.length) {
  for (const h of hits) console.log(`  FAIL  ${h}`);
  console.log(`\nRED  check:822-no-json-readers: ${hits.length} line(s) still read or write a migrated store.`);
  process.exit(1);
}
console.log("  PASS  no line under src/ names, loads, saves or parses findings/entities/relations/open-questions/labels.user JSON");
console.log("\nGREEN  check:822-no-json-readers");
