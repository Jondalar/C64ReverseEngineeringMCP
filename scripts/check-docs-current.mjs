#!/usr/bin/env node
// Documentation drift gate.
//
// Docs rot in two ways that a reader cannot tell from a lie, and both were found in
// this repo on 2026-08-12 while cleaning up after Spec 806:
//
//   1. DEAD LINKS — six relative `.md` links pointed at files that had been archived
//      or never existed (`specs/773-...` after it moved to `_archive/`, a `TODO.md`
//      that was deleted, a `semantic-ui-layer.md` that never was). A reader clicks and
//      gets nothing; nothing complained.
//
//   2. DEAD PROMISES — the README documented three environment variables
//      (`C64RE_VICE_BIN`, `C64RE_VICE_CONFIG_PATH`, `C64RE_VICE_CONFIG_DIR`) that no
//      code reads, and pointed at `npm run proof:product` / `proof:capability` /
//      `proof:list` as "the current product proof authority" — all three deleted with
//      the emulator months earlier. PLAN.md said they were gone on the same day the
//      README said to run them.
//
// Both classes are mechanical to check and neither needs judgement, which is exactly
// what makes them worth a gate rather than a review.
//
// Scope: the LIVE documentation surface. `specs/_archive/**` is deliberately excluded —
// it is a record of the past and is allowed to name things that no longer exist.
//
//   node scripts/check-docs-current.mjs
//   node scripts/check-docs-current.mjs --list

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SELF = resolve(import.meta.filename);
const LIST = process.argv.includes("--list");

const fails = [];
const notes = [];

// ---------- the live surface ----------

function liveDocs() {
  const out = [];
  for (const f of ["README.md", "PLAN.md", "CLAUDE.md", "DOCTRINE.md"]) {
    if (existsSync(join(ROOT, f))) out.push(f);
  }
  // docs/** minus the archive-flavoured subtrees, and specs/*.md (open specs only —
  // specs/_archive/** is history and may name anything).
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs)) {
      const p = join(rel, e);
      if (statSync(join(ROOT, p)).isDirectory()) {
        if (e === "_archive" || e === "audits" || e === "assets") continue;
        walk(p);
      } else if (e.endsWith(".md")) out.push(p);
    }
  };
  walk("docs");
  for (const e of readdirSync(join(ROOT, "specs"))) {
    if (e.endsWith(".md")) out.push(join("specs", e));
  }
  return out;
}

// ---------- rule 1: no dead relative links ----------

function checkLinks(files) {
  let checked = 0;
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) {
      let target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      target = target.split("#")[0];
      // Only `.md` targets. A sample filename like `mm[activision](german)(!).g64`
      // inside a table makes `](german)` look like a link to this regex; it is not.
      if (!target.endsWith(".md")) continue;
      checked++;
      const abs = resolve(ROOT, dirname(f), target);
      if (!existsSync(abs)) {
        fails.push(`${f} → ${target} does not exist`);
      }
    }
  }
  notes.push(`${checked} relative links checked across ${files.length} live docs`);
}

// ---------- rule 2: what the docs promise must exist ----------

// An env var is REAL if any source/script/config file mentions it. The docs are not
// source, so they cannot vouch for themselves.
function codeMentions() {
  const hay = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs)) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      const p = join(rel, e);
      const st = statSync(join(ROOT, p));
      if (st.isDirectory()) walk(p);
      // THIS FILE is excluded. Its header names `C64RE_VICE_BIN` and `proof:product`
      // as the defects it was written for, and a scan that reads its own prose finds
      // those strings "in the source" and passes. Verified: the red-test came back
      // green until this line existed.
      else if (/\.(ts|tsx|mjs|js|json|sh)$/.test(e) && p !== relative(ROOT, SELF)) {
        hay.push(readFileSync(join(ROOT, p), "utf8"));
      }
    }
  };
  for (const d of ["src", "pipeline/src", "scripts", "ui", "workspace-ui"]) walk(d);
  hay.push(readFileSync(join(ROOT, "package.json"), "utf8"));

  // The sibling runtime counts as source. These docs legitimately describe daemon
  // behaviour, and some `C64RE_*` variables are read THERE, not here —
  // `C64RE_RECORDER_AUTOFEED` is one. Calling a real variable dead is how a gate
  // teaches people to ignore it. Skipped silently when the checkout is absent, so this
  // never becomes a hard dependency on a repo C64RE does not own.
  const sibling = process.env.C64RE_TRX64_SRC ?? resolve(ROOT, "..", "TRX64", "crates");
  if (existsSync(sibling)) {
    const walkRs = (abs) => {
      for (const e of readdirSync(abs)) {
        if (e === "target" || e === "vendor" || e.startsWith(".")) continue;
        const p = join(abs, e);
        if (statSync(p).isDirectory()) walkRs(p);
        else if (e.endsWith(".rs")) hay.push(readFileSync(p, "utf8"));
      }
    };
    walkRs(sibling);
    notes.push(`sibling runtime source scanned for env vars (${relative(ROOT, sibling)})`);
  } else {
    notes.push(`sibling runtime source absent — env vars it owns cannot be confirmed`);
  }
  return hay.join("\n");
}

function checkPromises(files) {
  const code = codeMentions();
  const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts));

  // A line that RETIRES something is allowed to name it — that is the whole point of a
  // retirement note. Only a line presenting the thing as usable is a defect.
  const RETIRING = /\b(retired|deleted|gone|no longer|used to|superseded|removed|historical|snapshot|went with)\b/i;

  // Whole files exempt from this rule, for three different reasons:
  //   * a HISTORICAL / SUPERSEDED banner in the head — the file IS a record of a dead
  //     system, and naming its dead commands is what makes it a useful record;
  //   * DOCTRINE.md — the register of what was retired, same argument;
  //   * specs/*.md — a spec describes intended state, so it may name a script that
  //     does not exist YET. That is a plan, not a stale promise.
  //
  // The banner must be a real BANNER: a bold marker opening a blockquote line. Matching
  // the bare word anywhere in the head exempted README.md, whose second sentence offers
  // a runtime you can "snapshot, rewind, replay" — so the whole front page silently
  // stopped being checked. Verified: that is why the first red-test came back green.
  const BANNER = /^>\s*\*\*(HISTORICAL|SUPERSEDED|A SNAPSHOT)/im;
  const exempt = (f, src) =>
    f === "DOCTRINE.md" ||
    f.startsWith("specs/") ||
    BANNER.test(src.split("\n").slice(0, 12).join("\n"));

  let envChecked = 0, runChecked = 0, skipped = 0;
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    if (exempt(f, src)) { skipped++; continue; }
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (RETIRING.test(line)) return;
      for (const m of line.matchAll(/\bC64RE_[A-Z0-9_]+\b/g)) {
        envChecked++;
        if (!code.includes(m[0])) {
          fails.push(`${f}:${i + 1} documents ${m[0]}, which no source or script reads`);
        }
      }
      for (const m of line.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
        runChecked++;
        if (!scripts.has(m[1])) {
          fails.push(`${f}:${i + 1} says \`npm run ${m[1]}\`, which is not in package.json`);
        }
      }
    });
  }
  notes.push(
    `${envChecked} env-var + ${runChecked} \`npm run\` mentions checked, ` +
      `${skipped} historical/spec files exempt`,
  );
}

// ---------- run ----------

const files = liveDocs();
if (LIST) {
  for (const f of files) console.log(`  ${f}`);
  process.exit(0);
}

checkLinks(files);
checkPromises(files);

for (const n of notes) console.log(`  ${n}`);
for (const f of fails) console.log(`  FAIL  ${f}`);

if (fails.length) {
  console.log(`\nRED  docs-current: ${fails.length} fail.`);
  process.exit(1);
}
console.log(`\nGREEN  docs-current: 0 fail.`);
