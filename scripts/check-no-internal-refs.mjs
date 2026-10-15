#!/usr/bin/env node
// Keeps internal ids off the public surface.
//
// What is public: everything a user or an LLM client can read — the tool list (names,
// descriptions, every parameter description), every string the code can hand back or
// write into a project, the CLI help, the user docs, and the NAMES of the files in
// docs/ and resources/. An internal id there — a spec number, a bug id, a section or
// decision marker — means nothing to the reader and ages into a lie.
//
// The ids that count include the slot ids of an earlier release (S1..S15 — a slot is named
// by a descriptive id) and the numeric producer ids of the graph's `producer` column
// (819, 820, 821, 822, 826, 826r, 845, 847, 909 — a producer is named by what it does).
// The few places that must still READ them are allow-listed with the reason.
//
// What is not checked, on purpose: specs/, bugs/, docs/_archive, docs/rust_core/specs,
// code comments, commit messages, test scripts and their names.
//
// Four sweeps:
//   1. the BUILT server's tools — name, description, every (nested) parameter description,
//      enum value and parameter name, enumerated the way gen-tool-surface-inventory does
//   2. every string literal in src/, pipeline/src/ and ui/src/ (read from the syntax tree,
//      so comments never count) — tool answers, errors, notes, listing headers, the
//      names and text written into projects, graph and knowledge base, prompts, CLI help
//   3. the user docs
//   4. file and directory names under docs/ and resources/
//
// A real exception goes into scripts/no-internal-refs.allow.json, one entry per
// {file, match} with the reason it must stay. There is no wildcard entry.
//
//   node scripts/check-no-internal-refs.mjs          (needs `npm run build:mcp` first)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- what counts as an internal id -----------------------------------------
const ID_PATTERNS = [
  /\bSpecs?[ -]?\d{2,3}(?:\.\d+[a-z]?)?\b/i, // Spec 784, Spec-784, spec784, Spec 822.2
  /\bspec[-_]\d{3}/i, // spec-817, spec_710
  /\bspec\d{3}/i, // spec784, spec752-steering
  /\bBUG-\d+/i, // BUG-067
  /\bBug \d+/, // Bug 25
  /§\s?\d/, // §3.3, §0.5
  /\b\d{3}(?:\.\d+[a-z]?)? D\d+(?:\.\d+)?[a-z]?\b/, // 821 D3, 838 D3b
  /\b(?:7|8|9)\d\d\.\d+[a-z]?\b/, // 822.2, 744.4c
  /\b[789]\d\d\.[A-Z]\b/, // 705.B, 726.B
  /\bR\d{2}\b/, // R20, R27
  /\bOQ\d+\b/, // OQ4
  /\bUX\d+\b/, // UX1
  /\bPfad [ABC]\b/, // internal resolver path names
  /\bissue #\d+/i, // issue #11
  /\(#\d{2,3}\)/, // (#48)
  /_legacy-\d{3}|schema_\d{3}|split-table-\d{3}|timeline-\d{3}|\bcutover-\d{3}/, // names carrying a number
  /(?<![\w/:.$#-])S(?:1[0-5]|[1-9])(?![\w-])/, // S1..S15: the slot ids of an earlier release (T18/S4 and T37:S2 are sectors, and do not match)
  /(?<![\w$.#%:/=-])(?:819|820|821|822|826r?|845|847|909)(?![\w.%:/-])/, // the numeric producer ids of the graph's `producer` column (819 control flow ... 909 cartridge)
  /(?:^|[\s(`"'/])D(?:[1-9]|1[0-2])(?:\.\d+)?[a-z]?(?=[\s,;:).`"'\]]|$)(?! *(?:[0-9A-Fa-f]{2}\b))/, // D3, D4.1 decision ids (not hex bytes)
];

const findIds = (text) => {
  const hits = new Set();
  for (const re of ID_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) hits.add(m[0].trim());
  }
  // An id inside a longer id is the same finding: keep the longest.
  const all = [...hits];
  return all.filter((h) => !all.some((o) => o !== h && o.includes(h)));
};

// ---- allow-list ------------------------------------------------------------
const allowPath = join(ROOT, "scripts/no-internal-refs.allow.json");
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")).entries : [];
for (const e of allow) {
  if (!e.file || !e.match || !e.reason || e.file === "*") {
    console.error(`allow-list entry needs file, match and reason (no wildcard file): ${JSON.stringify(e)}`);
    process.exit(2);
  }
}
const usedAllow = new Set();
const allowed = (file, hit) => {
  const i = allow.findIndex((e) => e.file === file && hit.includes(e.match));
  if (i < 0) return false;
  usedAllow.add(i);
  return true;
};

const failures = [];
const note = (where, hit, context) => {
  failures.push(`  ${where}: ${hit}${context ? "   <- " + context.replace(/\s+/g, " ").slice(0, 140) : ""}`);
};
const check = (file, where, text) => {
  const open = findIds(text).filter((hit) => !allowed(file, hit));
  if (!open.length) return;
  const at = text.indexOf(open[0]);
  note(where, open.join(" | "), text.slice(Math.max(0, at - 50), at + open[0].length + 50));
};

// ---- 1. the built server's tools -------------------------------------------
const { collectToolInventory } = await import(pathToFileURL(join(ROOT, "dist/server.js")).href);

// Walks a zod type (v3): description at every level, object keys, enum values.
function walkZod(t, path, out, seen = new Set()) {
  if (!t || typeof t !== "object" || seen.has(t)) return;
  seen.add(t);
  const def = t._def ?? {};
  if (typeof t.description === "string") out.push([path, t.description]);
  else if (typeof def.description === "string") out.push([path, def.description]);
  if (Array.isArray(def.values)) for (const v of def.values) if (typeof v === "string") out.push([`${path}<enum>`, v]);
  if (def.values && !Array.isArray(def.values) && typeof def.values === "object") for (const v of Object.values(def.values)) if (typeof v === "string") out.push([`${path}<enum>`, v]);
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  if (shape && typeof shape === "object") {
    for (const [k, v] of Object.entries(shape)) {
      out.push([`${path}.${k}<name>`, k]);
      walkZod(v, `${path}.${k}`, out, seen);
    }
  }
  for (const k of ["innerType", "type", "schema", "valueType", "left", "right", "in", "out"]) if (def[k] && typeof def[k] === "object") walkZod(def[k], path, out, seen);
  if (Array.isArray(def.options)) for (const o of def.options) walkZod(o, path, out, seen);
  if (def.items && Array.isArray(def.items)) for (const o of def.items) walkZod(o, path, out, seen);
  if (def.typeName === "ZodEffects" && def.schema) walkZod(def.schema, path, out, seen);
}

const tools = collectToolInventory();
let toolStrings = 0;
for (const tool of tools) {
  const file = `tool:${tool.name}`;
  const strings = [[`tool ${tool.name} name`, tool.name], [`tool ${tool.name} description`, tool.description]];
  if (tool.schema) for (const [k, v] of Object.entries(tool.schema)) {
    strings.push([`tool ${tool.name} param ${k} name`, k]);
    const acc = [];
    walkZod(v, `tool ${tool.name} param ${k}`, acc);
    strings.push(...acc);
  }
  for (const [where, text] of strings) { toolStrings++; check(file, where, text); }
}

// ---- 2. string literals in the sources -------------------------------------
const SRC_DIRS = ["src", "pipeline/src", "ui/src"];
const walk = (dir, accept, skip = () => false) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) { if (name === "node_modules" || name === "dist") continue; out.push(...walk(p, accept, skip)); }
    else if (accept(name)) out.push(p);
  }
  return out;
};

let stringCount = 0;
for (const d of SRC_DIRS) {
  for (const file of walk(join(ROOT, d), (n) => /\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      let text = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const p = node.parent;
        const isModuleName =
          (p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isExternalModuleReference(p) || (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)))) ||
          (p && ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === "require")));
        if (!isModuleName) text = node.text;
      } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
      else if (ts.isJsxText(node)) text = node.text;
      if (text) {
        stringCount++;
        if (findIds(text).length) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          check(rel, `${rel}:${line}`, text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

// ---- 3. user docs ----------------------------------------------------------
const DOC_ROOT_FILES = ["README.md", "INSTALL.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"];
const docSkip = (p) => {
  const r = relative(ROOT, p).split(sep).join("/");
  return r === "docs/_archive" || r.startsWith("docs/_archive/") || r === "docs/rust_core/specs" || r.startsWith("docs/rust_core/specs/");
};
const docFiles = [
  ...DOC_ROOT_FILES.map((f) => join(ROOT, f)).filter(existsSync),
  ...walk(join(ROOT, "docs"), (n) => /\.(md|json|txt)$/.test(n), docSkip),
  ...walk(join(ROOT, "assets/project-rules"), (n) => /\.(md|txt|json)$/.test(n)),
];
let docLines = 0;
for (const file of docFiles) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    docLines++;
    // A § in a user doc is that doc's own section numbering (arc42 chapters, "§1.2 of the doctrine"); in code strings it points into a spec nobody outside has.
    check(rel, `${rel}:${i + 1}`, line.replace(/§\s?\d[\d.]*[A-Za-z]?/g, "section"));
    // A link into the internal trees is an internal reference too.
    const m = line.match(/\]\((?:\.\.\/)*(specs|bugs)\/[^)]*\)|`(?:\.\.\/)*(?:specs|bugs)\/[^`]*`/);
    if (m && !allowed(rel, m[0])) note(`${rel}:${i + 1}`, m[0], "link into specs/ or bugs/");
  });
}

// ---- 4. names of files and directories -------------------------------------
const NAME_RE = /(?:^|[-_.])(?:spec[-_]?)?\d{3}[a-z]?(?=[-_.]|$)|(?:^|[-_.])spec[-_]?\d|bug[-_]?\d/i;
let names = 0;
for (const top of ["docs", "resources"]) {
  const visitNames = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (docSkip(p)) continue;
      const rel = relative(ROOT, p).split(sep).join("/");
      names++;
      if (NAME_RE.test(name) && !allowed(rel, name)) note(rel, name, "file or directory name carries an internal id");
      if (statSync(p).isDirectory()) visitNames(p);
    }
  };
  visitNames(join(ROOT, top));
}

// ---- verdict ---------------------------------------------------------------
const stale = allow.filter((_, i) => !usedAllow.has(i));
for (const e of stale) failures.push(`  allow-list entry no longer matches anything (remove it): ${e.file} :: ${e.match}`);

console.log(`internal references on the public surface — ${tools.length} tools (${toolStrings} strings), ${stringCount} source strings, ${docFiles.length} doc files (${docLines} lines), ${names} names, ${allow.length} allow-listed`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length}\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("PASS — no internal ids");
