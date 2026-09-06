#!/usr/bin/env node
// The model-router skills and agents (contrib/claude/, because .claude/ is
// gitignored and these have to ship): a typo in `model:` does not
// fail loudly — Claude Code ignores a value it cannot use and silently keeps the
// session model, which is exactly the failure this set exists to prevent. So the
// frontmatter is checked here instead.
//
// Exit 0 = pass, 1 = fail.   npm run smoke:model-router

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

console.log("Model router — skill and agent frontmatter\n");

// A deliberately small YAML reader: these files are flat key/value frontmatter,
// and a dependency for that would be its own kind of cost.
function frontmatter(path) {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) return { error: "no frontmatter block", body: text };
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) return { error: "unterminated frontmatter block", body: text };
  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim() || line.startsWith("#") || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[line.slice(0, colon).trim()] = value;
  }
  return { fields, body: text.slice(end + 5) };
}

// The values Claude Code accepts. An alias outside this set, or a typo, is
// dropped without a word and the turn runs on the session model.
const MODELS = new Set(["opus", "sonnet", "haiku", "fable", "inherit"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SKILL_FIELDS = new Set(["name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable", "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell", "metadata", "license", "compatibility"]);
const AGENT_FIELDS = new Set(["name", "description", "model", "tools", "color"]);

// ---------------------------------------------------------------- skills

const skillsDir = join(ROOT, "contrib/claude/skills");
const routed = { deep: "opus", cheap: "haiku" };
for (const [dir, wantModel] of Object.entries(routed)) {
  const path = join(skillsDir, dir, "SKILL.md");
  if (!existsSync(path)) { fail(`${dir}/SKILL.md missing`); continue; }
  const { fields, error, body } = frontmatter(path);
  if (error) { fail(`${dir}/SKILL.md: ${error}`); continue; }
  check(fields.name === dir, `${dir}: name matches the directory (the /command is the directory name)`);
  check(fields.model === wantModel, `${dir}: model = ${wantModel}${fields.model === wantModel ? "" : ` (found "${fields.model ?? "none"}")`}`);
  check(MODELS.has(fields.model), `${dir}: "${fields.model}" is a value Claude Code accepts — a typo would be dropped silently`);
  check((fields.description ?? "").length > 60, `${dir}: has a description Claude can route on (${(fields.description ?? "").length} chars)`);
  check((`${fields.description ?? ""}${fields.when_to_use ?? ""}`).length <= 1536, `${dir}: description + when_to_use within the 1536-char listing cap`);
  check(Object.keys(fields).every((k) => SKILL_FIELDS.has(k)), `${dir}: no unknown frontmatter field (${Object.keys(fields).join(", ")})`);
  if (fields.effort !== undefined) check(EFFORTS.has(fields.effort), `${dir}: effort "${fields.effort}" is a valid level`);
  check(body.trim().length > 200, `${dir}: carries instructions, not just frontmatter`);
}

// The router itself must be free: deciding where to send work may never cost an upgrade.
{
  const path = join(skillsDir, "model-router/SKILL.md");
  const { fields, error } = existsSync(path) ? frontmatter(path) : { error: "missing" };
  if (error) fail(`model-router/SKILL.md: ${error}`);
  else {
    check(fields.model === undefined && fields.effort === undefined, "model-router: carries NO model/effort — the router runs on whatever the session is");
    check(fields["user-invocable"] !== "false", "model-router: the human can read it with /model-router");
    check(Object.keys(fields).every((k) => SKILL_FIELDS.has(k)), `model-router: no unknown frontmatter field`);
  }
}

// ---------------------------------------------------------------- agents

const agentsDir = join(ROOT, "contrib/claude/agents");
const agents = { reasoner: "opus", bulk: "haiku" };
for (const [name, wantModel] of Object.entries(agents)) {
  const path = join(agentsDir, `${name}.md`);
  if (!existsSync(path)) { fail(`agents/${name}.md missing`); continue; }
  const { fields, error, body } = frontmatter(path);
  if (error) { fail(`agents/${name}.md: ${error}`); continue; }
  check(fields.name === name, `agents/${name}: name matches the file`);
  check(fields.model === wantModel && MODELS.has(fields.model), `agents/${name}: model = ${wantModel}`);
  check((fields.description ?? "").length > 80, `agents/${name}: description says WHEN to pick it (${(fields.description ?? "").length} chars)`);
  check((fields.tools ?? "").length > 0, `agents/${name}: declares its tools`);
  check(Object.keys(fields).every((k) => AGENT_FIELDS.has(k)), `agents/${name}: no unknown frontmatter field (${Object.keys(fields).join(", ")})`);
  check(/empty context|starts with nothing|Give it every fact|keep the volume|value is that/i.test(`${fields.description}${body}`), `agents/${name}: says why delegation costs/pays (a fresh context)`);
}

// ---------------------------------------------------------------- the doctrine is installable

{
  const router = readFileSync(join(skillsDir, "model-router/SKILL.md"), "utf8");
  check(router.includes("cannot be changed by") && router.includes("`/model` is a human action"), "model-router: states plainly that Claude cannot switch the session model");
  check(/cp -R contrib\/claude\/skills\/deep/.test(router), "model-router: carries the user-level install command");
  check(router.includes("~/.claude/CLAUDE.md"), "model-router: carries a paste-ready block for the always-loaded memory");
  for (const name of ["reasoner", "bulk", "/deep", "/cheap"]) check(router.includes(name), `model-router: names ${name}`);
  check(/does not include Opus/.test(router), "model-router: warns that a plan without Opus degrades silently");
  check(/same plan limit|same budget|One budget/i.test(router), "model-router: is honest about subagent token accounting");
}

console.log(`\n${failCount ? "RED" : "GREEN"}  Model router: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
