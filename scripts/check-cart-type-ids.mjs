#!/usr/bin/env node
// Cartridge type-table drift gate.
//
// `CART_TYPE_PROFILES` in src/project-knowledge/view-builders.ts names the CRT
// hardware types the workbench can describe. It is hand-written, and on 2026-08-11
// it was found to carry "GMod3" at id 71 — which is BlackBox 9. A real GMod3 (62)
// fell through to the generic fallback and stayed nameless, and a BlackBox 9 would
// have rendered as a flash cart it is not. Nothing checked, so nothing complained.
//
// Two rules, and the second is the one that would have caught it:
//
//   1. PROVENANCE — every row cites the VICE source it was read from. This table
//      describes what a cartridge IS (read direction), never how one is built, and
//      the citation is what makes that checkable rather than a matter of trust.
//      Runs without VICE present.
//
//   2. IDENTITY — no row may carry a name that belongs to a DIFFERENT id in
//      `cartridge.h`. Needs the VICE tree; skipped, loudly, when it is absent, so
//      the gate never becomes a hard dependency on a checkout this repo does not own.
//
// Exit 0 = pass (including "skipped"), 1 = fail.
//
//   node scripts/check-cart-type-ids.mjs
//   C64RE_VICE_SRC=/path/to/vice/src node scripts/check-cart-type-ids.mjs

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TABLE_FILE = join(REPO_ROOT, "src/project-knowledge/view-builders.ts");

// The VICE tree is a reference checkout, not a dependency. Env first, then the
// conventional local path. Override with C64RE_VICE_SRC.
const VICE_SRC =
  process.env.C64RE_VICE_SRC ?? "/Users/alex/Development/C64/Tools/vice/vice/src";

// Product spellings that legitimately differ from VICE's identifier. Kept HERE and
// not in the table, so this stays the gate's own data and never becomes a second
// copy of the thing it checks.
const NAME_ALIASES = new Map([
  [0, "CRT"],                 // VICE's name for the plain container
  [3, "FINAL_III"],           // we spell the product out
  [15, "GS"],                 // "C64 Games System" is the product name
  [86, "MEGABYTER"],          // we prefix the vendor
]);

// Ids that are deliberately not mainline. Each must SAY so in its comment, and the
// identity rule is applied to them in reverse: 61 must NOT be named after the
// upstream cart that owns the number, and 87 must be absent upstream.
const FORK_IDS = new Map([
  [61, { mustNotBeUpstreamName: true, note: "martinpiper fork — upstream 61 is MAX Basic" }],
  [87, { mustBeUnallocated: true, note: "private allocation — upstream CARTRIDGE_LAST is 86" }],
]);

const fails = [];
const warns = [];
const notes = [];

// ---------- read the table ----------

function readTable() {
  const src = readFileSync(TABLE_FILE, "utf8");
  const start = src.indexOf("const CART_TYPE_PROFILES");
  if (start < 0) {
    fails.push(`CART_TYPE_PROFILES not found in ${TABLE_FILE} — did the table move?`);
    return [];
  }
  const end = src.indexOf("\n};", start);
  const body = src.slice(start, end);
  const lines = body.split("\n");

  const rows = [];
  lines.forEach((line, i) => {
    const m = /^\s*(\d+):\s*\{\s*hardwareTypeName:\s*"([^"]+)"/.exec(line);
    if (!m) return;
    // The citation is the run of comment lines immediately above the row.
    const comment = [];
    for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]); j--) comment.unshift(lines[j]);
    rows.push({ id: Number(m[1]), name: m[2], comment: comment.join("\n") });
  });
  return rows;
}

// ---------- rule 1: provenance ----------

// A citation names a VICE source file, or (for the two non-mainline ids) the TRX64
// mapper that implements them. Anything else is prose, not provenance.
const CITES_SOURCE = /\b[a-z0-9_]+\.(c|h)\b|\bcart\.rs\b/;

function checkProvenance(rows) {
  for (const { id, name, comment } of rows) {
    if (!comment.trim()) {
      fails.push(`id ${id} "${name}": no provenance comment. Cite the VICE source it was read from.`);
      continue;
    }
    if (!CITES_SOURCE.test(comment)) {
      fails.push(`id ${id} "${name}": comment cites no source file. A row without a citation is suspect by construction.`);
    }
  }
}

// ---------- rule 2: identity ----------

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function readViceIds() {
  const header = join(VICE_SRC, "cartridge.h");
  if (!existsSync(header)) return null;
  const byId = new Map();
  const text = readFileSync(header, "utf8");
  for (const m of text.matchAll(/^#define\s+CARTRIDGE_([A-Z0-9_]+)\s+(\d+)/gm)) {
    const id = Number(m[2]);
    // C128/VIC20/PLUS4/CBM2 share the number space with unrelated meanings, and
    // the SIZE_/GROUP_/FILETYPE_ constants are not cart types at all.
    if (/^(C128|VIC20|PLUS4|CBM2|SIZE|GROUP|FILETYPE)_/.test(m[1])) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(m[1]);
  }
  return byId;
}

function checkIdentity(rows, byId) {
  // Which ids does each VICE name belong to? This is the lookup that catches a name
  // sitting on the wrong number.
  const idsForName = new Map();
  for (const [id, names] of byId) {
    for (const n of names) {
      const k = norm(n);
      if (!idsForName.has(k)) idsForName.set(k, []);
      idsForName.get(k).push(id);
    }
  }

  for (const { id, name, comment } of rows) {
    const fork = FORK_IDS.get(id);
    const upstream = byId.get(id) ?? [];

    if (fork) {
      if (!/fork|private|upstream/i.test(comment)) {
        fails.push(`id ${id} "${name}": is not a mainline id and the comment does not say so (${fork.note}).`);
      }
      if (fork.mustBeUnallocated && upstream.length) {
        fails.push(`id ${id} "${name}": upstream has allocated this id (${upstream.join("/")}). The private allocation now collides — this is the day that was predicted.`);
      }
      if (fork.mustNotBeUpstreamName && upstream.some((u) => norm(u) === norm(name))) {
        fails.push(`id ${id} "${name}": names the UPSTREAM cart, which is not what this repo means by ${id}.`);
      }
      continue;
    }

    const wanted = norm(NAME_ALIASES.get(id) ?? name);
    const owners = idsForName.get(wanted) ?? [];

    if (owners.length && !owners.includes(id)) {
      fails.push(
        `id ${id} "${name}": that name belongs to id ${owners.join("/")} in cartridge.h. ` +
          `This is the exact shape of the GMod3-at-71 defect.`,
      );
      continue;
    }
    if (!owners.length) {
      if (!upstream.length) {
        fails.push(`id ${id} "${name}": no such id in cartridge.h, and it is not declared as fork/private.`);
      } else {
        // Product spelling differs from VICE's identifier — tolerable, but say so,
        // because an unnoticed rename is how a table starts lying.
        warns.push(`id ${id} "${name}": VICE calls it ${upstream.join("/")}. Add an alias if this is deliberate.`);
      }
    }
  }
}

// ---------- run ----------

const rows = readTable();
if (rows.length) notes.push(`${rows.length} cartridge types in the table`);

checkProvenance(rows);

const byId = readViceIds();
if (!byId) {
  notes.push(
    `SKIPPED the identity check — no cartridge.h at ${VICE_SRC}. ` +
      `Set C64RE_VICE_SRC to a VICE source tree to run it.`,
  );
} else {
  notes.push(`cross-checked against ${VICE_SRC}/cartridge.h`);
  checkIdentity(rows, byId);
}

for (const n of notes) console.log(`  ${n}`);
for (const w of warns) console.log(`  WARN  ${w}`);
for (const f of fails) console.log(`  FAIL  ${f}`);

if (fails.length) {
  console.log(`\nRED  cart type ids: ${fails.length} fail, ${warns.length} warn.`);
  process.exit(1);
}
console.log(`\nGREEN  cart type ids: ${rows.length} rows, ${warns.length} warn, 0 fail.`);
