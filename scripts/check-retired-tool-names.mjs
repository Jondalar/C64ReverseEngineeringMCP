#!/usr/bin/env node
// Spec 878 — a retired door name must not be recommended to the model.
//
// 866 renamed four doors to two and kept the old names alive as aliases for one
// release. The rename landed in the registration and nowhere else: 27 files went on
// telling the model to "run analyze_prg", in parameter descriptions, refusal bodies,
// next-step hints and the hand-maintained use-case matrix. An alias that keeps working
// is a courtesy to code that already calls it; it is not a name to hand out. The run
// that hit this reached for the old name because the tooling had just recommended it,
// got the notice, and spent the detour on it.
//
// What is checked: string literals — the text that reaches the model — in the server
// and pipeline sources and in the matrix generator. Comments are not checked: a comment
// saying "there used to be four doors" is history, and history keeps the old name.
//
// The retired names are READ FROM `ALIAS_SUCCESSOR` in src/server-tools/byte-doors.ts,
// so the next alias is covered the day it is added and no list has to be kept in step.
//
// A site that must name the old name — the registration, the alias map, the default
// tool list, the phase lists, the notice that explains the alias to its caller — says so
// on the line or the line before:
//
//     "analyze_prg", // retired-name-ok: the alias registration itself
//
// The reason has to be a reason. Under MIN_REASON characters is a mute, and a mute
// fails, for the same cause the whole check exists: a marker nobody had to justify is
// how the name comes back.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIN_REASON = 12;
const MARKER = /retired-name-ok:\s*(.*)$/;

const SCAN_DIRS = ["src", "pipeline/src"];
const SCAN_FILES = ["scripts/gen-mcp-tool-usecase-matrix.mjs"];
const EXT = /\.(ts|mjs)$/;

/** The retired names, from the one place that decides them. */
function retiredNames() {
  const src = readFileSync(join(ROOT, "src/server-tools/byte-doors.ts"), "utf8");
  const block = src.match(/ALIAS_SUCCESSOR[^=]*=\s*\{([^}]*)\}/);
  if (!block) {
    console.error("check:tool-names — ALIAS_SUCCESSOR not found in src/server-tools/byte-doors.ts.");
    console.error("  The gate reads the retired names from there. If the map moved, point this at its new home.");
    process.exit(2);
  }
  const names = [...block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  if (names.length === 0) {
    console.error("check:tool-names — ALIAS_SUCCESSOR is empty; nothing retired, nothing to check.");
    process.exit(2);
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(entry)) out.push(p);
  }
  return out;
}

/**
 * The string-literal spans of one line, as [start, end) index pairs.
 *
 * Deliberately simple: it tracks the three quote characters and a line comment, and it
 * does not follow a template literal across lines. A retired name inside a multi-line
 * template is missed; that is a hole, not a lie, and the alternative is a parser. Every
 * site the sweep actually found sat on one line.
 */
function stringSpans(line, state) {
  const spans = [];
  let quote = state.inTemplate ? "`" : null;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (state.inBlockComment) {
      if (c === "*" && line[i + 1] === "/") { state.inBlockComment = false; i++; }
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (quote) {
      if (c === quote) { spans.push([start, i]); quote = null; }
      continue;
    }
    if (c === "/" && line[i + 1] === "*") { state.inBlockComment = true; i++; continue; }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === '"' || c === "'" || c === "`") { quote = c; start = i + 1; continue; }
  }
  // An unterminated backtick runs on to the next line; its tail is still text the model
  // reads, so it counts to the end of the line and the next line opens inside it. An
  // unterminated ' or " is a quote inside prose, not a string — it does not carry over.
  if (quote === "`") { spans.push([start, line.length]); state.inTemplate = true; }
  else state.inTemplate = false;
  return spans;
}

const names = retiredNames();
const pattern = new RegExp(`\\b(${names.join("|")})\\b`);

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SCAN_FILES.map((f) => join(ROOT, f)),
];

const failures = [];
const mutes = [];
let allowed = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const state = { inBlockComment: false, inTemplate: false };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const spans = stringSpans(line, state);
    if (!pattern.test(line)) continue;

    const hit = spans.some(([a, b]) => pattern.test(line.slice(a, b)));
    if (!hit) continue; // the name is in a comment or an identifier — history, or the map key

    const marker = MARKER.exec(line) ?? MARKER.exec(lines[i - 1] ?? "");
    const rel = relative(ROOT, file);
    if (!marker) {
      failures.push({ rel, line: i + 1, text: line.trim() });
      continue;
    }
    const reason = marker[1].trim().replace(/\*\/\s*$/, "").trim();
    if (reason.length < MIN_REASON) {
      mutes.push({ rel, line: i + 1, reason });
      continue;
    }
    allowed++;
  }
}

if (failures.length === 0 && mutes.length === 0) {
  console.log(`check:tool-names — clean. Retired: ${names.join(", ")}. ${allowed} marked site(s), ${files.length} files scanned.`);
  process.exit(0);
}

console.error(`check:tool-names — a retired door name is being handed to the model.`);
console.error(`Retired (from ALIAS_SUCCESSOR): ${names.join(", ")}\n`);

for (const f of failures) {
  console.error(`  ${f.rel}:${f.line}`);
  console.error(`    ${f.text}`);
}
for (const m of mutes) {
  console.error(`  ${m.rel}:${m.line} — the marker's reason is ${m.reason.length} characters ("${m.reason}").`);
  console.error(`    Under ${MIN_REASON} is a mute. Say why this site has to name the old door.`);
}

console.error(`
Fix it by naming the live door instead. If the site genuinely has to say the old name —
the alias registration, the alias map, the default tool list, the phase lists, the notice
that explains the alias to whoever called it — mark it:

    // retired-name-ok: <why this site names the old door>
`);
process.exit(1);
