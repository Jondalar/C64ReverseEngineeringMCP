#!/usr/bin/env node
// Spec 612 FC-7 amendment — function-body audit (presence ≠ behaviour).
//
// FC-2 verifies function names exist. FC-7 inspects function BODIES for
// stub-like patterns:
//   (a) empty body — `{ }`
//   (b) only `return;` / `return undefined;`
//   (c) only `return 0;` / `return false;` / `return null;`
//   (d) only comments, no executable statements
//   (e) `_` prefixed args (unused) AND tiny body (≤2 statements) — suggests stub
//
// Each hit gets manually classified:
//   - LEGIT: matches VICE C-source no-op / early-return path
//   - STUB:  TS port hasn't implemented the body yet
//
// Run: node scripts/audit-vice1541-stubs.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const target = join(repoRoot, "src/runtime/headless/vice1541");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const hits = [];

for (const file of walk(target)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  // Match `function NAME(args): T { body }` and `NAME(args): T { body }`
  // (class methods). Capture body to first matching `}` at top level.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::[^{]+)?\s*\{(.*)$/)
          || line.match(/^\s*(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(([^)]*)\)\s*(?::[^{]+)?\s*\{(.*)$/);
    if (!m) { i++; continue; }
    const [, name, args, after] = m;
    // Skip control-flow keywords masquerading as function names.
    if (["if", "for", "while", "switch", "catch"].includes(name)) { i++; continue; }
    // Collect body until matching closing brace.
    let depth = 1;
    let body = after ?? "";
    for (const ch of body) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    let j = i + 1;
    while (depth > 0 && j < lines.length) {
      const l = lines[j];
      for (const ch of l) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth === 0) break;
      }
      body += "\n" + l;
      j++;
    }
    // Trim trailing closing-brace tail.
    const lastBrace = body.lastIndexOf("}");
    const bodyOnly = lastBrace >= 0 ? body.slice(0, lastBrace) : body;

    // Strip comments + whitespace.
    const stripped = bodyOnly
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim();

    // Pattern detection.
    let kind = null;
    if (stripped === "") kind = "EMPTY";
    else if (/^return\s*;?$/.test(stripped)) kind = "RETURN_VOID";
    else if (/^return\s+(0|false|null|undefined);?$/.test(stripped)) kind = "RETURN_FALSY";
    else if (/^void\s+\w+\s*;\s*$/.test(stripped)) kind = "VOID_REF_ONLY";

    if (kind) {
      hits.push({
        file: file.slice(repoRoot.length + 1),
        line: i + 1,
        name, args: args.trim(),
        kind,
        stripped: stripped.length > 80 ? stripped.slice(0, 80) + "…" : stripped,
        // Capture the prior 8 lines of comment context to manual-judge legit
        // vs stub. VICE-source citation usually appears there.
        context: lines.slice(Math.max(0, i - 8), i).join("\n"),
      });
    }
    i = j > i ? j : i + 1;
  }
}

console.log(`Spec 612 FC-7 audit — vice1541/ function-body stub scan`);
console.log(`Files scanned: ${[...walk(target)].length}`);
console.log(`Total hits: ${hits.length}\n`);
console.log("=" .repeat(80));

for (const h of hits) {
  console.log(`\n[${h.kind}] ${h.file}:${h.line}`);
  console.log(`  fn   ${h.name}(${h.args})`);
  console.log(`  body ${h.stripped || "(empty)"}`);
  // Print last 3 lines of preceding comment context.
  const ctx = h.context.split("\n").filter(l => l.match(/^\s*\/\//)).slice(-3).join("\n");
  if (ctx) console.log(`  ctx:\n${ctx.replace(/^/gm, "    ")}`);
}
console.log("\n" + "=".repeat(80));
console.log("\nManual classification required: LEGIT (matches VICE C no-op) or STUB (port incomplete).");
