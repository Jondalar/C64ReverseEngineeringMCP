#!/usr/bin/env node
// The wiki has no CI of its own, so its pages live HERE (docs/wiki/) and are
// published from here. That makes them checkable, and this is the check.
//
// What decays in a wiki is exactly what nobody re-reads: the code examples. A step
// gets renamed, a tool gains a required argument, a spec is closed — and the page
// keeps saying what used to be true, in a place that reads as authoritative.
//
// So every example is run through the LIVE parser, every tool name is looked up in
// the LIVE inventory, and every page has to name the spec it documents.
//
//   node scripts/check-wiki.mjs
//   node scripts/check-wiki.mjs --publish   # copy into a wiki clone (path in $C64RE_WIKI)

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = join(ROOT, "docs/wiki");

let pass = 0;
let fail = 0;
const ok = (c, m, d = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`);
};

console.log("wiki pages — examples, tool names, spec references\n");

const pages = readdirSync(WIKI).filter((f) => f.endsWith(".md"));
ok(pages.length > 0, "0 there are pages to check", pages.join(", "));

// ---- the live surfaces the pages have to agree with -------------------------
const { parseFeature, parseStep } = await import(`${ROOT}/dist/project-knowledge/scenario-gherkin.js`);
const inventory = JSON.parse(readFileSync(join(ROOT, "docs/tool-surface-inventory.json"), "utf8"));
const toolNames = new Set(inventory.tools.map((t) => t.name));

const specNumbers = new Set();
for (const dir of ["specs", "specs/_archive"]) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    const m = /^(\d+)-/.exec(f);
    if (m) specNumbers.add(m[1]);
  }
}
// Numbers are shared with the sibling repo; its specs count as existing too.
const sibling = join(ROOT, "..", "TRX64", "docs");
if (existsSync(sibling)) {
  for (const f of readdirSync(sibling)) {
    const m = /^(\d+)-/.exec(f);
    if (m) specNumbers.add(m[1]);
  }
  const arch = join(sibling, "_archive");
  if (existsSync(arch)) {
    for (const f of readdirSync(arch)) {
      const m = /^(\d+)-/.exec(f);
      if (m) specNumbers.add(m[1]);
    }
  }
}

// Same rule as check-runtime-invisible: the backend is never named to a reader.
const FORBIDDEN = [/\bTRX64\b/i, /\bLeitregel\b/i];

const fence = /```(\w+)?\n([\s\S]*?)```/g;

for (const page of pages) {
  const text = readFileSync(join(WIKI, page), "utf8");
  const name = basename(page, ".md");

  // 1. every page except the index names the spec it documents.
  if (name !== "Home") {
    const specs = [...text.matchAll(/\(Spec (\d+)\)/g)].map((m) => m[1]);
    ok(specs.length > 0, `${name}: names the spec it documents`, specs.join(", ") || "none");
    for (const s of specs) {
      ok(specNumbers.has(s), `${name}: spec ${s} exists`, specNumbers.has(s) ? "" : "no such spec file");
    }
  }

  // 2. the backend stays unnamed.
  const leaks = FORBIDDEN.flatMap((re) => text.match(new RegExp(re.source, "gi")) ?? []);
  ok(leaks.length === 0, `${name}: no backend brand`, leaks.join(", ") || "clean");

  // 3. every tool name mentioned is a tool that exists.
  const mentioned = new Set([...text.matchAll(/\b(runtime_[a-z_0-9]+)\b/g)].map((m) => m[1]));
  const unknown = [...mentioned].filter((t) => !toolNames.has(t));
  ok(unknown.length === 0, `${name}: every tool named exists`, unknown.join(", ") || [...mentioned].join(", ") || "none named");

  // 4. every gherkin example is understood by the live parser.
  let blocks = 0;
  let bad = [];
  for (const [, lang, body] of text.matchAll(fence)) {
    if (lang !== "gherkin") continue;
    blocks += 1;
    if (/^\s*Scenario:/m.test(body)) {
      // A whole scenario: it has to parse cleanly.
      const r = parseFeature(body);
      for (const issue of r.issues) bad.push(`${name} block ${blocks}: ${issue.message}`);
      continue;
    }
    // A fragment: check the step-shaped lines one by one.
    //
    // `undefined` from parseStep is NOT a failure — the real parser tries a step
    // first and falls through to a criterion, so `And the intro plays` after a
    // `Then` is legal prose. Only a line the parser recognises as a step AND
    // rejects ("almost a step") is a defect.
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#") || line.startsWith("|")) continue;
      const m = /^(?:When|And)\s+(.+)$/.exec(line);
      if (!m) continue;
      const parsed = parseStep(m[1]);
      if (parsed?.error) bad.push(`${name}: ${parsed.error}`);
    }
  }
  ok(bad.length === 0, `${name}: ${blocks} gherkin example(s) parse`, bad.slice(0, 3).join(" | ") || "clean");
}

// ---- optional publish -------------------------------------------------------
if (process.argv.includes("--publish")) {
  const dest = process.env.C64RE_WIKI;
  if (!dest || !existsSync(dest)) {
    console.log(`\n  publish: set C64RE_WIKI to a checkout of <repo>.wiki.git (got ${dest ?? "unset"})`);
    process.exit(1);
  }
  for (const page of pages) writeFileSync(join(dest, page), readFileSync(join(WIKI, page)));
  console.log(`\n  published ${pages.length} page(s) into ${dest} — commit and push there.`);
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} wiki: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
