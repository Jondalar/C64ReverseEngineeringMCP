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

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ---- is what is PUBLISHED what is in here? ----------------------------------
//
// The gate above proves the pages in this repo are correct. It says nothing
// about the pages a reader actually sees, because publishing is a manual copy
// into a separate wiki repo — and that step was silently skipped for a whole
// spec: `Capture-Scenarios` carried Spec 834's project_dir paragraph here and
// not there, and nothing noticed until somebody went to publish something else.
//
// Read over GIT, not over raw.githubusercontent.com. The raw endpoint is behind
// a CDN and served the previous Home.md for minutes after a push — a check that
// reports drift that is not there is a check people learn to ignore, which is
// the failure this repo already had with four dead workflows. `git ls-remote`
// and a depth-1 clone see what was actually pushed.
//
// It needs the network, so it cannot join the hermetic CI set (Spec 828 made
// that argument for a lookup and it holds for a check). Offline, or with no
// remote, it SKIPS LOUDLY: an unrunnable check must say it did not run.
//
//   --no-remote   skip it deliberately
const wikiRemote = (() => {
  if (process.argv.includes("--no-remote")) return undefined;
  const env = process.env.C64RE_WIKI_GIT?.trim();
  if (env) return env;
  try {
    const url = execFileSync("git", ["-C", ROOT, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /\.wiki\.git$/.test(url) ? url : url.replace(/(\.git)?$/, ".wiki.git");
  } catch {
    return undefined;
  }
})();

if (!wikiRemote) {
  console.log(`\n  SKIP  published wiki not compared: no git origin (set C64RE_WIKI_GIT, or pass --no-remote) — skipped, not passed`);
} else {
  let clone;
  try {
    clone = mkdtempSync(join(tmpdir(), "c64re-wiki-"));
    execFileSync("git", ["clone", "--depth", "1", "--quiet", wikiRemote, clone], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
  } catch (e) {
    const why = e instanceof Error ? (e.stderr?.toString().trim() || e.message) : String(e);
    console.log(`\n  SKIP  published wiki not compared: ${wikiRemote} unreachable — skipped, not passed`);
    console.log(`        ${why.split("\n")[0]}`);
    clone = undefined;
  }
  if (clone) {
    const drift = [];
    for (const page of pages) {
      const here = readFileSync(join(WIKI, page), "utf8").replace(/\r\n/g, "\n");
      const there = join(clone, page);
      if (!existsSync(there)) { drift.push(`${page}: never published`); continue; }
      // Only line endings are forgiven: a published page differing by anything
      // else is still a page somebody has to look at.
      if (readFileSync(there, "utf8").replace(/\r\n/g, "\n") !== here) drift.push(`${page}: published copy differs`);
    }
    const extra = readdirSync(clone).filter((f) => f.endsWith(".md") && !pages.includes(f));
    for (const f of extra) drift.push(`${f}: published but not in docs/wiki (edited in the web UI?)`);
    ok(drift.length === 0, `published wiki matches docs/wiki (${pages.length} pages)`,
      drift.slice(0, 4).join(" | ") || "in sync");
    if (drift.length > 0) {
      console.log(`        run: C64RE_WIKI=<a clone of ${wikiRemote}> npm run publish:wiki   then commit and push there`);
    }
    rmSync(clone, { recursive: true, force: true });
  }
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
