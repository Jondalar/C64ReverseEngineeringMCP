#!/usr/bin/env node
// Spec 877 D3 — an agent-facing document may not assert what a tool CAN'T do.
//
// The rule this enforces is the one the owner already applies to comments, one
// level up: a capability claim goes stale, and the stale ones are the dangerous
// ones. `docs/runtime-sandbox.md` said, in bold, **"The MCP `runtime_*` tools
// cannot give you that"** and **"Do NOT use the MCP `runtime_*` tools for this"**.
// True when it was written. Then `runtime_sandbox_run` shipped and described
// itself as "a private daemon on its own port, started as a child of this call" —
// exactly what the document forbade. A run read the document, believed it, and
// grew a parallel tool surface out of it: its own daemon, its own WebSocket
// driver, a regex that parsed our monitor's text dump back into bytes, and a
// hand-rolled `until` loop polling the PC every 50 frames.
//
// So: a DENIAL ("cannot", "do NOT use", "is not possible" and their kin) standing
// in the same sentence as a tool name FAILS when that tool exists on the surface.
//
// ── The doc set, and why these ───────────────────────────────────────────────
//
// Scanned are the documents an AGENT is pointed at and reads as instruction:
//
//   docs/agent-doctrine.md   loaded at onboarding; the agent is told to adopt it.
//   docs/runtime-sandbox.md  linked FROM the doctrine as the recipe to follow —
//                            the document this gate was written for.
//   docs/tools/**.md         the per-namespace tool references; their whole job
//                            is to say what a tool does and does not do.
//
// NOT scanned, deliberately:
//
//   the generated surfaces (docs/tool-surface-inventory.*, mcp-llm-playbooks.*,
//   mcp-tool-usecase-matrix.*) — every sentence in them is COPIED from a tool's
//   own description, so a denial there is the tool speaking about itself. Failing
//   it here would report the source twice and fix it in neither.
//
//   the rest of docs/** — audits, design notes, arc42 chapters, baselines. They
//   are developer-facing history: they SHOULD record what was impossible on the
//   day they were written, and nobody acts on them as instruction.
//
// ── Marking a denial that is true ───────────────────────────────────────────
//
// A document may legitimately say what a tool cannot do — `runtime_sandbox_run`'s
// own description opens a paragraph with "WHAT IT CANNOT DO, deliberately". Mark
// such a sentence, and say WHY, in an HTML comment:
//
//   <!-- deliberate-limitation: runtime_sandbox_run — it returns no session id;
//        the machine is gone before the answer is read, so nothing can attach. -->
//
// A mark covers what FOLLOWS it: the rest of the markdown block it sits in, and the
// next block. That is deliberately forgiving about blank lines — whether the mark is
// glued to the end of a bullet list or floats alone above a paragraph, it covers the
// sentence it was written above, which is the only placement anyone will try.
//
// It must name the tool (or the `ns_*` wildcard) the covered denial is about, and it
// must carry a reason of real length — a bare mark is a mute, and a mute is how the
// next stale paragraph gets through. A mark that covers no denial at all fails too:
// it has outlived the sentence it was written for.
//
// Exit 0 = clean, 1 = a document denies a capability the surface has.
//
//   node scripts/check-doc-capability-claims.mjs
//   node scripts/check-doc-capability-claims.mjs --list   # show every mark + scan

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIST = process.argv.includes("--list");

// ── the surface ─────────────────────────────────────────────────────────────
//
// The tool names come from the generated inventory, which the pre-commit hook and
// the npm script regenerate from the registered tools — so this gate cannot be
// fooled by an inventory that fell behind the code.
const INVENTORY = join(ROOT, "docs/tool-surface-inventory.json");
if (!existsSync(INVENTORY)) {
  console.log(`  ${INVENTORY} is missing — run \`npm run gen:tool-surface\` first.`);
  process.exit(1);
}
const TOOLS = new Set((JSON.parse(readFileSync(INVENTORY, "utf8")).tools ?? []).map((t) => t.name));
if (TOOLS.size === 0) {
  console.log("  the tool inventory is empty — nothing to check against, which is not a pass.");
  process.exit(1);
}

/** `runtime_*` names every tool in that namespace. It exists if any of them does. */
function wildcardExists(prefix) {
  for (const n of TOOLS) if (n.startsWith(`${prefix}_`)) return true;
  return false;
}

// ── the doc set ─────────────────────────────────────────────────────────────

function docs() {
  const out = [];
  for (const p of ["docs/agent-doctrine.md", "docs/runtime-sandbox.md"]) {
    if (existsSync(join(ROOT, p))) out.push(p);
  }
  const toolsDir = join(ROOT, "docs/tools");
  if (existsSync(toolsDir)) {
    for (const e of readdirSync(toolsDir).sort()) {
      const p = join("docs/tools", e);
      if (!statSync(join(ROOT, p)).isDirectory() && e.endsWith(".md")) out.push(p);
    }
  }
  return out;
}

// ── what counts as a denial ─────────────────────────────────────────────────
//
// Kept to phrases that deny a CAPABILITY. "not for X" (every tool description
// says it) and "refuses" (a door stating its rule) are not denials of what the
// tool can do — they are how it is used, and flagging them would train everyone
// to mark everything.
const DENIALS = [
  { rx: /\bcannot\b/i, name: "cannot" },
  { rx: /\bcan\s+not\b/i, name: "can not" },
  { rx: /\bcan['’]t\b/i, name: "can't" },
  { rx: /\b(?:do|does|did)(?:\s+not|n['’]t)\s+(?:use|expect|call|reach|rely|try|attempt|bother)\b/i, name: "do not use/expect" },
  { rx: /\bnever\s+(?:use|call|reach|rely|expect)\b/i, name: "never use" },
  { rx: /\b(?:is|are|was|were|it['’]s)\s+not\s+possible\b/i, name: "is not possible" },
  { rx: /\bimpossible\b/i, name: "impossible" },
  { rx: /\bno\s+way\s+to\b/i, name: "no way to" },
  { rx: /\bunable\s+to\b/i, name: "unable to" },
  { rx: /\bnot\s+supported\b/i, name: "not supported" },
  { rx: /\bthere\s+is\s+no\s+(?:tool|way|door)\b/i, name: "there is no tool" },
];

// A tool name counts when it is written as CODE (`runtime_until`) or when it
// carries an underscore, because those are unmistakably the tool and not the
// English word. Bare `disasm` / `analyze` in prose are the verb far more often
// than the door, and a gate that cried at every "analyze" would be turned off.
function toolsNamedIn(sentence) {
  const found = new Map();
  const add = (label, exists) => { if (exists && !found.has(label)) found.set(label, true); };

  for (const m of sentence.matchAll(/`([^`]+)`/g)) {
    for (const tok of m[1].matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:_\*)?/g)) {
      const t = tok[0];
      if (t.endsWith("_*")) add(t, wildcardExists(t.slice(0, -2)));
      else add(t, TOOLS.has(t));
    }
  }
  for (const tok of sentence.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    add(tok[0], TOOLS.has(tok[0]));
  }
  return [...found.keys()];
}

// ── blocks, sentences, marks ────────────────────────────────────────────────

const MARK_RX = /<!--\s*deliberate-limitation:\s*([\s\S]*?)-->/g;

/** Blank-line separated blocks, with the 1-based line each starts on. */
function blocks(body) {
  const lines = body.split("\n");
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (line.trim() === "") { cur = null; return; }
    if (!cur) { cur = { line: i + 1, lines: [] }; out.push(cur); }
    cur.lines.push(line);
  });
  return out.map((b) => ({ line: b.line, text: b.lines.join("\n") }));
}

function sentences(blockText, blockLine) {
  // Strip fenced code and the marks themselves before splitting: a code sample is
  // not prose, and a mark's own reason may legitimately contain "cannot".
  const cleaned = blockText.replace(MARK_RX, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  let offset = 0;
  for (const raw of cleaned.split(/(?<=[.!?])\s+|\n(?=\s*[-*|>#])/)) {
    const at = cleaned.indexOf(raw, offset);
    const line = blockLine + cleaned.slice(0, at < 0 ? offset : at).split("\n").length - 1;
    offset = (at < 0 ? offset : at) + raw.length;
    const s = raw.trim();
    if (s) out.push({ text: s, line });
  }
  return out;
}

/** `<!-- deliberate-limitation: <tool>[, <tool>] — <reason> -->` */
function parseMarks(blockText, blockLine) {
  const out = [];
  for (const m of blockText.matchAll(MARK_RX)) {
    const body = m[1].trim().replace(/\s+/g, " ");
    const split = body.match(/^(.*?)\s*(?:—|--|–|:)\s*(.+)$/);
    const line = blockLine + blockText.slice(0, m.index).split("\n").length - 1;
    const rawTools = (split ? split[1] : body).split(/[,/]/).map((t) => t.trim().replace(/^`|`$/g, "")).filter(Boolean);
    out.push({ line, tools: rawTools, reason: split ? split[2].trim() : "", used: false });
  }
  return out;
}

const MIN_REASON = 30;

// ── the scan ────────────────────────────────────────────────────────────────

function scanDocument(path, body, report) {
  const fails = [];
  let marksSeen = 0;
  let denialsCovered = 0;
  const bs = blocks(body);

  // A mark covers the rest of its own block and the whole of the next one.
  const marksFor = bs.map(() => []);
  bs.forEach((b, i) => {
    const ms = parseMarks(b.text, b.line);
    if (ms.length === 0) return;
    marksSeen += ms.length;
    marksFor[i].push(...ms);
    if (i + 1 < bs.length) marksFor[i + 1].push(...ms);
    else if (b.text.replace(MARK_RX, "").trim() === "") {
      fails.push({ path, line: ms[0].line, kind: "mark", detail: "a mark at the end of the file covers nothing" });
    }
  });

  bs.forEach((b, i) => {
    for (const s of sentences(b.text, b.line)) {
      const denial = DENIALS.find((d) => d.rx.test(s.text));
      if (!denial) continue;
      const named = toolsNamedIn(s.text);
      if (named.length === 0) continue;

      const mark = marksFor[i].find((mk) => mk.line <= s.line && mk.tools.some((t) => named.includes(t)));
      if (mark) {
        mark.used = true;
        denialsCovered++;
        if (mark.reason.length < MIN_REASON) {
          fails.push({
            path, line: mark.line, kind: "mute",
            detail: `the mark for ${named.join(", ")} carries no reason worth the name `
              + `(${mark.reason.length} chars, ${MIN_REASON} needed): "${mark.reason}"`,
          });
        } else if (report) {
          report(`  MARKED  ${path}:${s.line} — ${named.join(", ")}: ${mark.reason.slice(0, 90)}`);
        }
        continue;
      }
      fails.push({
        path, line: s.line, kind: "claim", tools: named, denial: denial.name,
        detail: s.text.replace(/\s+/g, " ").slice(0, 220),
      });
    }
  });

  for (const mk of new Set(marksFor.flat())) {
    if (mk.used) continue;
    fails.push({
      path, line: mk.line, kind: "stale-mark",
      detail: `nothing it covers denies anything about ${mk.tools.join(", ")} — `
        + `the sentence it was written for is gone, so the mark should go with it`,
    });
  }
  return { fails, marksSeen, denialsCovered };
}

// ── does the gate still bite? ───────────────────────────────────────────────
//
// A gate over prose drifts the moment someone widens a regex to silence a false
// positive. These two fixtures are the exact sentences `docs/runtime-sandbox.md`
// carried until 2026-09-25: the first must still fail, the second — the same
// sentence with a mark — must pass. If the detector stops catching the paragraph
// this gate was written for, it says so here instead of going quietly green.
const SELFTEST_STALE = [
  "**The MCP `runtime_*` tools cannot give you that**: they are all pinned to the ONE",
  "product daemon, and `runtime_session_start` deliberately **attaches**.",
  "Do NOT use the MCP `runtime_*` tools for this — they are for the shared session.",
].join("\n");
const SELFTEST_MARKED =
  "<!-- deliberate-limitation: runtime_* — the fixture's reason, long enough to count. -->\n\n"
  + SELFTEST_STALE;

const selfStale = scanDocument("<selftest:stale>", SELFTEST_STALE);
const selfMarked = scanDocument("<selftest:marked>", SELFTEST_MARKED);
const selfTest = [
  { name: "the paragraph this gate was written for still fails", ok: selfStale.fails.length >= 2 },
  { name: "…and a mark with a reason clears it", ok: selfMarked.fails.length === 0 && selfMarked.denialsCovered >= 2 },
];

const fails = [];
const scanned = [];
let marksSeen = 0;
let denialsCovered = 0;

for (const path of docs()) {
  const r = scanDocument(path, readFileSync(join(ROOT, path), "utf8"), LIST ? console.log : null);
  scanned.push(path);
  fails.push(...r.fails);
  marksSeen += r.marksSeen;
  denialsCovered += r.denialsCovered;
}

for (const t of selfTest) {
  if (!t.ok) fails.push({ path: "self-test", line: 0, kind: "self", detail: `${t.name} — it does not` });
  else if (LIST) console.log(`  SELFTEST  ${t.name}`);
}

console.log(`  ${scanned.length} agent-facing documents scanned against ${TOOLS.size} registered tools`);
if (LIST) for (const s of scanned) console.log(`    ${s}`);
console.log(`  ${marksSeen} deliberate-limitation mark(s), ${denialsCovered} denial(s) covered by one`);
console.log(`  ${selfTest.length} self-test(s) on the paragraph this gate was written for`);

for (const f of fails) {
  if (f.kind === "claim") {
    console.log(`  FAIL  ${f.path}:${f.line} — "${f.denial}" next to ${f.tools.join(", ")}, which exists`);
    console.log(`          ${f.detail}`);
  } else {
    console.log(`  FAIL  ${f.path}:${f.line} — ${f.detail}`);
  }
}

if (fails.length) {
  console.log(
    `\nRED  spec 877 D3: ${fails.length} problem(s).\n` +
      `     A document may not tell an agent a tool cannot do what the tool does.\n` +
      `     Either rewrite the sentence to lead with the tool, or — if the limit is real —\n` +
      `     mark it and say why:\n` +
      `       <!-- deliberate-limitation: <tool_name> — why this limit is real and stays -->`,
  );
  process.exit(1);
}
console.log(`\nGREEN  spec 877 D3: no document denies a capability the surface has.`);
