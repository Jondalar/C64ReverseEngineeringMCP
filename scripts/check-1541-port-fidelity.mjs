#!/usr/bin/env node
// Spec 612 §6 — 1541 Port Fidelity Check (CI gate).
//
// Reads the file-mapping table from
// `specs/612-1541-port-fidelity-rules.md` §3 and applies rules FC-1..FC-6
// against `src/runtime/headless/vice1541/**`.
//
// Exit 0 = PASS, exit 1 = any FAIL (WARN does not fail).
//
// Usage:
//   node scripts/check-1541-port-fidelity.mjs
//   node scripts/check-1541-port-fidelity.mjs --json    # machine output
//   node scripts/check-1541-port-fidelity.mjs --strict  # WARN → FAIL

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SPEC_PATH = join(REPO_ROOT, "specs/612-1541-port-fidelity-rules.md");
const TODO_PATH = join(REPO_ROOT, "specs/612-1541-port-fidelity-todo.md");
const VICE1541_DIR = join(REPO_ROOT, "src/runtime/headless/vice1541");
const VICE_C_ROOT = "/Users/alex/Development/C64/Tools/vice/vice/src";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const STRICT = args.includes("--strict");

const results = []; // { level: "PASS"|"WARN"|"FAIL", rule, file, detail }
function rec(level, rule, file, detail) {
  results.push({ level, rule, file, detail });
}

// ---------- Parse §3 file-mapping table ----------

function parseFileMap() {
  if (!existsSync(SPEC_PATH)) {
    console.error(`spec not found: ${SPEC_PATH}`);
    process.exit(2);
  }
  const md = readFileSync(SPEC_PATH, "utf8");
  // Find table after "## 3. File Mapping Table"
  const sec = md.split(/^##\s+3\.\s+File Mapping Table/m)[1] ?? "";
  const map = []; // { tsBase, cPaths: string[] }
  // Rows: | `<ts>.ts` | `<c path>` (+ optional more in same cell) |
  const rowRe = /^\|\s*`([^`]+\.ts)`\s*\|\s*(.+?)\s*\|\s*$/gm;
  let m;
  while ((m = rowRe.exec(sec))) {
    const ts = m[1].trim();
    // Strip "src/runtime/headless/vice1541/" prefix if present
    const tsBase = ts.replace(/^.*vice1541\//, "");
    // C cell may contain "(+ also ...)" notes; extract all backtick paths
    const cMatches = [...m[2].matchAll(/`([^`]+?\.[ch])`/g)].map((x) => x[1]);
    if (cMatches.length === 0) continue;
    map.push({ tsBase, cPaths: cMatches });
  }
  return map;
}

// ---------- Parse §3 TODO `pending` markers ----------

function parsePendingSet() {
  if (!existsSync(TODO_PATH)) return new Set();
  const md = readFileSync(TODO_PATH, "utf8");
  const pending = new Set();
  // Lines like "| `xxx.ts` | ... | pending |" or explicit OPEN status near a file ref
  const re = /`([a-z_0-9]+\.ts)`/g;
  let m;
  while ((m = re.exec(md))) pending.add(m[1]);
  return pending;
}

// ---------- List vice1541/ TS files ----------

function listVice1541Ts() {
  if (!existsSync(VICE1541_DIR)) return [];
  return readdirSync(VICE1541_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

// ---------- FC-1: mapping completeness ----------

function checkFC1(fileMap, tsFiles, pending) {
  const mapped = new Set(fileMap.map((e) => e.tsBase));
  for (const f of tsFiles) {
    if (mapped.has(f)) {
      rec("PASS", "FC-1", f, "in §3 mapping");
    } else if (pending.has(f)) {
      rec("WARN", "FC-1", f, "marked pending in §3");
    } else {
      rec("FAIL", "FC-1", f, "not in §3 mapping nor pending");
    }
  }
  // Reverse: every map entry should have a file or be in pending
  for (const entry of fileMap) {
    if (!tsFiles.includes(entry.tsBase) && !pending.has(entry.tsBase)) {
      rec("WARN", "FC-1", entry.tsBase, "in §3 map but file not present (expected if rebuild not yet at this layer)");
    }
  }
}

// ---------- FC-2: function presence (C → TS) ----------

const C_FUNC_RE = /^(?:static\s+)?(?:inline\s+)?[a-zA-Z_][a-zA-Z0-9_*\s]*\s+\*?\s*([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*\{/gm;

function extractCFunctions(cAbsPath) {
  if (!existsSync(cAbsPath)) return null;
  const src = readFileSync(cAbsPath, "utf8");
  const names = new Set();
  let m;
  C_FUNC_RE.lastIndex = 0;
  while ((m = C_FUNC_RE.exec(src))) {
    const name = m[1];
    // Skip obvious noise: keywords, single letters
    if (["if", "for", "while", "switch", "return", "sizeof"].includes(name)) continue;
    if (m[0].startsWith("static")) continue; // static = module-private, NL-2 exempt
    names.add(name);
  }
  return names;
}

function extractTsExportNames(tsAbsPath) {
  const src = readFileSync(tsAbsPath, "utf8");
  const names = new Set();
  const re = /^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

function checkFC2(fileMap, tsFiles) {
  for (const entry of fileMap) {
    if (!tsFiles.includes(entry.tsBase)) continue;
    const tsAbs = join(VICE1541_DIR, entry.tsBase);
    const tsExports = extractTsExportNames(tsAbs);
    const cFuncs = new Set();
    let anyCFound = false;
    for (const cPath of entry.cPaths) {
      // Skip .h files for function presence (declarations only)
      if (cPath.endsWith(".h")) continue;
      const cAbs = join(VICE_C_ROOT, cPath);
      const funcs = extractCFunctions(cAbs);
      if (funcs === null) continue;
      anyCFound = true;
      for (const f of funcs) cFuncs.add(f);
    }
    if (!anyCFound) {
      rec("WARN", "FC-2", entry.tsBase, `no C source readable at ${entry.cPaths.join(", ")}`);
      continue;
    }
    const missing = [];
    for (const cName of cFuncs) {
      if (!tsExports.has(cName)) missing.push(cName);
    }
    if (missing.length === 0) {
      rec("PASS", "FC-2", entry.tsBase, `${cFuncs.size}/${cFuncs.size} VICE funcs present`);
    } else {
      rec(
        "FAIL",
        "FC-2",
        entry.tsBase,
        `${missing.length}/${cFuncs.size} missing: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "..." : ""}`,
      );
    }
  }
}

// ---------- FC-3: forbidden patterns ----------

function checkFC3(tsFiles) {
  for (const f of tsFiles) {
    const src = readFileSync(join(VICE1541_DIR, f), "utf8");
    // PL-1 / PL-3: no exported class
    if (/^export\s+(?:abstract\s+)?class\s/m.test(src)) {
      rec("FAIL", "FC-3:PL-1", f, "exports a class (PL-1 forbids class wrapping VICE struct)");
    }
    // No cross-import into legacy dirs
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((x) => x[1]);
    for (const imp of imports) {
      if (/(^|\/)\.\.\/drive\//.test(imp)) {
        rec("FAIL", "FC-3:no-legacy", f, `imports from ../drive/: ${imp}`);
      }
      if (/(^|\/)\.\.\/via\//.test(imp)) {
        rec("FAIL", "FC-3:PL-10", f, `imports from ../via/ (parallel port): ${imp}`);
      }
      if (/(^|\/)\.\.\/iec\//.test(imp)) {
        rec("FAIL", "FC-3:PL-10", f, `imports from ../iec/ (parallel port): ${imp}`);
      }
    }
    // PL-2 WARN: kind:"x" discriminated union
    if (/kind\s*:\s*['"][a-z][a-z0-9_]*['"]/.test(src)) {
      rec("WARN", "FC-3:PL-2", f, "discriminated union `kind:` pattern (PL-2: prefer numeric union)");
    }
    // NL-3 WARN: camelCase fields in interfaces (heuristic — match field declarations)
    const ifaceRe = /^\s*(?:export\s+)?interface\s+\w+\s*\{([\s\S]*?)^\}/gm;
    let im;
    const camelFields = new Set();
    while ((im = ifaceRe.exec(src))) {
      const body = im[1];
      const fieldRe = /^\s*([a-z][a-zA-Z0-9]*?[A-Z][a-zA-Z0-9]*)\s*[?:!]/gm;
      let fm;
      while ((fm = fieldRe.exec(body))) {
        camelFields.add(fm[1]);
      }
    }
    if (camelFields.size > 0) {
      const list = [...camelFields].slice(0, 5).join(", ");
      rec("WARN", "FC-3:NL-3", f, `${camelFields.size} camelCase field(s) in interface(s): ${list}${camelFields.size > 5 ? "..." : ""}`);
    }
  }
}

// ---------- FC-4: PORT OF block within 5 lines of export function ----------

function checkFC4(tsFiles) {
  for (const f of tsFiles) {
    const src = readFileSync(join(VICE1541_DIR, f), "utf8");
    const lines = src.split("\n");
    const missing = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
      if (!m) continue;
      const lo = Math.max(0, i - 6);
      const window = lines.slice(lo, i).join("\n");
      if (!/PORT\s+OF\s*:/i.test(window)) missing.push(m[1]);
    }
    if (missing.length === 0) {
      rec("PASS", "FC-4", f, "all exports have PORT OF block");
    } else {
      rec("FAIL", "FC-4", f, `${missing.length} export(s) lack PORT OF block: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "..." : ""}`);
    }
  }
}

// ---------- FC-5: line-count ratio TS/C ∈ [0.7, 1.6] ----------

function countLines(p) {
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").split("\n").length;
}

function checkFC5(fileMap, tsFiles) {
  for (const entry of fileMap) {
    if (!tsFiles.includes(entry.tsBase)) continue;
    const tsLines = countLines(join(VICE1541_DIR, entry.tsBase));
    let cLinesTotal = 0;
    let anyC = false;
    for (const cPath of entry.cPaths) {
      const n = countLines(join(VICE_C_ROOT, cPath));
      if (n !== null) {
        cLinesTotal += n;
        anyC = true;
      }
    }
    if (!anyC || tsLines === null) continue;
    const ratio = tsLines / cLinesTotal;
    const r = ratio.toFixed(2);
    if (ratio >= 0.7 && ratio <= 1.6) {
      rec("PASS", "FC-5", entry.tsBase, `ratio ${r} (${tsLines}/${cLinesTotal})`);
    } else {
      rec("WARN", "FC-5", entry.tsBase, `ratio ${r} outside [0.7, 1.6] (${tsLines}/${cLinesTotal})`);
    }
  }
}

// ---------- FC-6: no duplicate C → TS mapping ----------

function checkFC6(fileMap) {
  const seen = new Map(); // cPath → tsBase
  for (const entry of fileMap) {
    for (const cPath of entry.cPaths) {
      if (cPath.endsWith(".h")) continue;
      if (seen.has(cPath)) {
        rec("FAIL", "FC-6", entry.tsBase, `duplicate map: ${cPath} already mapped to ${seen.get(cPath)}`);
      } else {
        seen.set(cPath, entry.tsBase);
      }
    }
  }
  if ([...seen].length > 0) {
    rec("PASS", "FC-6", "(global)", `${seen.size} unique C→TS mappings`);
  }
}

// ---------- Main ----------

const fileMap = parseFileMap();
const pending = parsePendingSet();
const tsFiles = listVice1541Ts();

if (tsFiles.length === 0) {
  console.error(`no .ts files in ${VICE1541_DIR}`);
  process.exit(2);
}

checkFC1(fileMap, tsFiles, pending);
checkFC2(fileMap, tsFiles);
checkFC3(tsFiles);
checkFC4(tsFiles);
checkFC5(fileMap, tsFiles);
checkFC6(fileMap);

// ---------- Report ----------

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
} else {
  const byLevel = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) byLevel[r.level]++;
  console.log(`Spec 612 §6 Port Fidelity Check`);
  console.log(`  vice1541 dir: ${relative(REPO_ROOT, VICE1541_DIR)}`);
  console.log(`  ts files:     ${tsFiles.length}`);
  console.log(`  map entries:  ${fileMap.length}`);
  console.log(`  results:      ${byLevel.PASS} PASS, ${byLevel.WARN} WARN, ${byLevel.FAIL} FAIL`);
  console.log("");
  for (const r of results) {
    if (r.level === "PASS") continue;
    console.log(`  [${r.level}] ${r.rule.padEnd(14)} ${r.file.padEnd(28)} ${r.detail}`);
  }
  console.log("");
}

const failCount = results.filter((r) => r.level === "FAIL").length;
const warnCount = results.filter((r) => r.level === "WARN").length;
const fatal = failCount > 0 || (STRICT && warnCount > 0);
process.exit(fatal ? 1 : 0);
