// FC-11 initial scan — cross-module shadow scan.
// Aggregate `export (function|const|class) NAME` across LOAD-critical
// modules. List names appearing in ≥ 2 distinct files.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const cwd = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const scopes = [
  "src/runtime/headless/",
  "src/disk/",
  "src/workspace-ui/",
];

const lines = execSync(
  `cd ${cwd} && grep -rnE "^export (function|const|class) [a-zA-Z_][a-zA-Z0-9_]*" ${scopes.join(" ")} --include="*.ts" --exclude-dir="_quarantine_*" 2>/dev/null`,
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
).trim().split("\n").filter((l) => !/_quarantine_/.test(l));

const byName = new Map();  // name → [{file, lineno, kind}]
const exportRe = /^([^:]+):(\d+):export\s+(function|const|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
for (const l of lines) {
  const m = exportRe.exec(l);
  if (!m) continue;
  const [, file, lineno, kind, name] = m;
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push({ file, lineno: +lineno, kind });
}

const dupes = [...byName.entries()]
  .filter(([_, sites]) => new Set(sites.map((s) => s.file)).size >= 2)
  .sort((a, b) => b[1].length - a[1].length);

function bodyOf(file, lineno) {
  try {
    const src = readFileSync(`${cwd}/${file}`, "utf8");
    const arr = src.split("\n");
    const slice = arr.slice(lineno - 1, lineno + 12).join("\n");
    return slice;
  } catch {
    return "";
  }
}
function classify(body) {
  if (/throw new Error\([^)]*PORT-STUB/.test(body)) return "stub-throw";
  if (/^\s*(export\s+)?function\s+[^{]*\{\s*\}/m.test(body)) return "stub-empty";
  if (/^\s*(export\s+)?function\s+[^{]*\{\s*return(\s+(0|false|null|undefined))?;?\s*\}/m.test(body)) return "stub-return-falsy";
  if (/FACADE:\s*delegates/.test(body)) return "legitimate-facade";
  return "impl";
}

console.log(`FC-11 — cross-module shadow scan`);
console.log(`scope: ${scopes.join(", ")}`);
console.log(`total exports: ${lines.length}`);
console.log(`distinct names: ${byName.size}`);
console.log(`names with ≥ 2 cross-file sites: ${dupes.length}`);
console.log(`=`.repeat(80));

let shadowFail = 0;
let dupePort = 0;
let benign = 0;

for (const [name, sites] of dupes) {
  const classified = sites.map((s) => ({ ...s, klass: classify(bodyOf(s.file, s.lineno)) }));
  const klasses = classified.map((c) => c.klass);
  const hasStub = klasses.some((k) => k.startsWith("stub"));
  const implCount = klasses.filter((k) => k === "impl").length;
  const facadeCount = klasses.filter((k) => k === "legitimate-facade").length;

  // Function dupes are the LOAD-critical-path concern. Const dupes
  // are mostly enums / sizes that get re-defined per module — list
  // but classify as low-priority.
  const kinds = sites.map((s) => s.kind);
  const allConst = kinds.every((k) => k === "const");
  const allClass = kinds.every((k) => k === "class");

  let verdict;
  if (hasStub && implCount >= 1) {
    verdict = "FAIL shadow-stub";
    shadowFail++;
  } else if (allConst) {
    verdict = "low-prio const-dupe";
    benign++;
  } else if (allClass) {
    verdict = "low-prio class-dupe";
    benign++;
  } else if (implCount >= 2 && facadeCount === 0) {
    verdict = "FAIL duplicate-port (function)";
    dupePort++;
  } else {
    verdict = "ok-dupe";
    benign++;
  }
  if (verdict.startsWith("FAIL")) {
    console.log(`\n[${verdict}]  ${name}`);
    for (const c of classified) {
      console.log(`  ${c.file}:${c.lineno}  ${c.kind}  ${c.klass}`);
    }
  }
}

console.log(`=`.repeat(80));
console.log(`Summary:`);
console.log(`  FAIL shadow-stub:    ${shadowFail}`);
console.log(`  FAIL duplicate-port: ${dupePort}`);
console.log(`  ok-dupe (no stub):   ${benign}`);
console.log(`  total dupe names:    ${dupes.length}`);
