#!/usr/bin/env node
// The knowledge graph owns six record types. Their JSON stores are dead: a
// project that still has one gets it folded in once, on open, and the file is
// moved to knowledge/_legacy-822/.
//
// This check exists because one writer survived the cut-over in a place nobody
// looked — the analysis pipeline, which runs as its own CommonJS child process
// and appended a payload entity to knowledge/entities.json after every PRG it
// analysed. The next project open folded the file in and swept it aside, the
// next analysis re-created it, and so on: 32 archived copies in one day on one
// project, each round minting a new id for the same payload because the
// duplicate check could only see the file it had just lost.
//
// So: no source file may write one of these names. Reading is allowed (the
// migration reads them, the exporter writes them on demand, and both are
// listed below by path).
//
//   node scripts/check-no-legacy-store-writers.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The stores Spec 822 migrated into graph.sqlite.
const LEGACY_STORES = ["entities.json", "findings.json", "relations.json",
  "open-questions.json", "labels.json"];

// The two places that are allowed to name them: the migration reads them, and
// the exporter writes the graph back into this shape when asked.
const ALLOWED = new Set([
  "src/knowledge-graph/cutover.ts",
  "src/knowledge-graph/export.ts",
  "src/knowledge-graph/migrate/migrate.ts",
]);

// Product code only. A gate script may legitimately BUILD a legacy store as a
// fixture — that is how the migration itself is tested.
const SEARCH = ["src", "pipeline/src"];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else if (/\.(ts|mjs|js|cjs)$/.test(name)) files.push(abs);
  }
};
for (const dir of SEARCH) walk(join(ROOT, dir));

let pass = 0;
let fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("legacy knowledge stores — nothing writes them any more\n");

const offenders = [];
for (const abs of files) {
  const rel = relative(ROOT, abs);
  if (ALLOWED.has(rel)) continue;
  const text = readFileSync(abs, "utf8");
  for (const store of LEGACY_STORES) {
    if (!text.includes(store)) continue;
    // A mention is fine (a comment, a message). A write is not: the name has to
    // reach a path join AND the file has to write something somewhere.
    const namesAPath = new RegExp(`(join|resolve)\\([^)]*["']${store.replace(".", "\\.")}["']`).test(text);
    const writes = /writeFileSync|writeStoreAtomic|createWriteStream|renameSync/.test(text);
    if (namesAPath && writes) offenders.push(`${rel}:${store}`);
  }
}
ok(offenders.length === 0, `1 no source file writes a migrated store (${files.length} files checked)`, offenders.join(", ") || "none");

console.log(`\n${fail === 0 ? "GREEN" : "RED"} legacy-store writers: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
