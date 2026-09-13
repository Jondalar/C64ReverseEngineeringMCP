#!/usr/bin/env node
// Spec 849 — the harness rules, checked against the machinery they describe.
//
// A rule is prose that the session reads as authoritative. Its one unrecoverable failure
// mode is announcing a refusal that does not happen: a session that is told
// `render_docs` will refuse, calls it, and is served, learns that rules are decoration.
// That costs more than the rule was ever worth, and nothing else in the build would
// notice — the rule still parses, still ships, still fires.
//
// So every door name and every slot id a rule mentions is checked here against the slot
// table and the registered tool surface. The frontmatter is checked too, for the same
// reason `smoke-model-router.mjs` exists: a `paths:` key the harness cannot parse fails
// silently, and a rule that never fires looks exactly like a rule that was obeyed.
//
// Exit 0 = pass, 1 = fail.   npm run smoke:project-rules

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RULES = join(ROOT, "assets", "project-rules");
let pass = 0, failCount = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const fail = (m) => { failCount += 1; console.log(`  FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

console.log("Project rules — frontmatter, globs, and the doors they announce\n");

// ---- what the machinery actually offers -------------------------------------------

const schema = readFileSync(join(ROOT, "src", "slots", "schema.ts"), "utf8");
const SLOT_IDS = new Set([...schema.matchAll(/id:\s*"(S\d+)"/g)].map((m) => m[1]));
// doors: ["a", "b"] — every door the slot table gates, per slot id
const DOORS_BY_SLOT = new Map();
for (const m of schema.matchAll(/id:\s*"(S\d+)"[\s\S]*?doors:\s*\[([^\]]*)\]/g)) {
  DOORS_BY_SLOT.set(m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((d) => d[1]));
}
const ALL_DOORS = new Set([...DOORS_BY_SLOT.values()].flat());

// Every tool name the server registers, harvested the same way the 839 gate does.
const TOOLS = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".ts")) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/server\.tool\(\s*\n?\s*"([a-z0-9_]+)"/g)) TOOLS.add(m[1]);
  }
};
walk(join(ROOT, "src"));
check(TOOLS.size > 50, `harvested ${TOOLS.size} registered tools`);
check(SLOT_IDS.size === 14, `slot table has ${SLOT_IDS.size} slots`);

// Doors the slot table names that no tool registers. Spec 844 keeps an allowlist for
// doors built on an unmerged branch; a rule may not announce one of those either.
const PENDING = new Set(
  [...readFileSync(join(ROOT, "src", "slots", "schema.ts"), "utf8")
    .matchAll(/KNOWN_PENDING_DOORS[\s\S]*?\]\);/g)]
    .flatMap((m) => [...m[0].matchAll(/\["([a-z0-9_]+)",/g)].map((d) => d[1])),
);

// ---- the rules ---------------------------------------------------------------------

const claimedBy = new Map();
const files = readdirSync(RULES).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
check(files.length > 0, `${files.length} rule files present`);

for (const file of files) {
  const text = readFileSync(join(RULES, file), "utf8");
  console.log(`\n${file}`);

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) { fail(`${file}: no frontmatter block`); continue; }
  const body = text.slice(fm[0].length);

  const desc = /^description:\s*(.+)$/m.exec(fm[1]);
  check(!!desc && desc[1].trim().length > 20, `description present`);

  // tools: the delivery path that actually fires. Measured: a `paths:` glob fires when a
  // matching file is READ natively, and an RE session reads through the MCP tools — a
  // 102-turn run made four native file accesses, all writes, and fired no rule at all.
  // So every rule must name at least one tool, and every tool it names must exist.
  const toolsLine = /^tools:\s*\[([^\]]*)\]\s*$/m.exec(fm[1]);
  if (!toolsLine) { fail(`tools: must be a single-line JSON array of tool names`); }
  else {
    const trig = [...toolsLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    check(trig.length > 0, `tools: ${trig.join(", ")}`);
    for (const t of trig) {
      check(TOOLS.has(t), `trigger \`${t}\` is a registered tool`);
      // A tool may carry several rules — `disasm_prg` carries both the listing rule and
      // the boundary one, because importing names IS the moment a boundary is owed. What
      // is checked is that nothing is delivered twice from the same file.
      const seenHere = claimedBy.get(t) ?? [];
      check(!seenHere.includes(file), `\`${t}\` lists ${file} once`);
      claimedBy.set(t, [...seenHere, file]);
    }
  }

  const pathsLine = /^paths:\s*\[([^\]]*)\]\s*$/m.exec(fm[1]);
  if (!pathsLine) { fail(`paths: must be a single-line JSON array of globs`); continue; }
  const globs = [...pathsLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(globs.length > 0, `paths: ${globs.join(", ")}`);
  // A glob without a wildcard or a directory only ever matches one literal path, which is
  // fine for knowledge/contract.json and wrong for anything else.
  for (const g of globs) {
    check(/[*?]/.test(g) || g.includes("/"), `glob is anchored or wildcarded: ${g}`);
  }

  // Slot ids the prose names must exist.
  for (const id of new Set([...body.matchAll(/\bS(\d{1,2})\b/g)].map((m) => `S${m[1]}`))) {
    check(SLOT_IDS.has(id), `names an existing slot: ${id}`);
  }

  // Every `tool_name` in backticks must be a tool that is actually registered.
  //
  // Backticks also carry things that are not tools — a frontmatter field (`covers`), a
  // segment kind (`probable_code`), a generated label (`addr_0006`). A token counts as a
  // tool CLAIM when its first underscore-segment is one the real tool surface uses, so a
  // renamed or removed tool is caught while an ordinary identifier is left alone.
  const TOOL_PREFIXES = new Set([...TOOLS].map((t) => t.split("_")[0]));
  const named = new Set(
    [...body.matchAll(/`([a-z][a-z0-9_]{4,})`/g)].map((m) => m[1])
      .filter((n) => n.includes("_") && TOOL_PREFIXES.has(n.split("_")[0])),
  );
  for (const n of named) {
    if (!TOOLS.has(n)) { fail(`names \`${n}\`, which no server.tool() registers`); continue; }
    if (PENDING.has(n)) { fail(`announces \`${n}\`, a door that is not on this branch`); continue; }
    ok(`\`${n}\` is a registered tool`);
  }

  // A rule that says a tool REFUSES must name a tool the slot table actually gates.
  for (const m of body.matchAll(/(?:gates?|refuses?)[^.\n]*?`([a-z][a-z0-9_]+)`/g)) {
    check(ALL_DOORS.has(m[1]), `announces a refusal on \`${m[1]}\`, which the slot table gates`);
  }
  for (const m of body.matchAll(/`([a-z][a-z0-9_]+)`\s+refuses/g)) {
    check(ALL_DOORS.has(m[1]), `announces a refusal on \`${m[1]}\`, which the slot table gates`);
  }
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
