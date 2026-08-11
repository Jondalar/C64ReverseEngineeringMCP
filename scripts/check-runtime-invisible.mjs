#!/usr/bin/env node
// Spec 800 §A / acceptance 1 — the runtime backend stays invisible to the RE agent.
//
// The agent is told WHAT it can do, never WHICH backend does it. The backend is
// named in exactly one place: the setup recipe, and only when the runtime is
// missing. That is a property of every agent-facing string in the repo, so it
// decays with every new tool description someone writes — which is exactly what
// happened: a trace-domain description gained "served by the TRX64 daemon" on
// 2026-08-11, hours after the assertion was last believed to hold. Nothing
// checked it, so nothing complained.
//
// Exempt, per the spec: code comments and CLAUDE.md (developer-facing), and the
// recipe module itself (the one place the name belongs).
//
// Exit 0 = clean, 1 = a brand reached the agent surface.
//
//   node scripts/check-runtime-invisible.mjs
//   node scripts/check-runtime-invisible.mjs --list   # show every scanned surface

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LIST = process.argv.includes("--list");

// Words that must never reach the agent. "Leitregel" is the internal split
// vocabulary; an agent that reads it starts reasoning about our repo layout
// instead of the C64 in front of it.
const FORBIDDEN = [/\bTRX64\b/i, /\bLeitregel\b/i];

// `trx64-runtime/N` is the protocol identifier the daemon puts ON THE WIRE, not
// prose about a backend. A version-mismatch error has to quote it verbatim or it
// is not actionable — "expected 1, got 2" without saying of what helps nobody.
// The brand as PROSE ("served by the TRX64 daemon") is the thing this gate is for.
const WIRE_TOKEN = /trx64-runtime\//i;

// The one module allowed to name the backend — it IS the setup recipe.
const ALLOWED_FILES = new Set(["src/server-tools/runtime-setup-recipe.ts"]);

// Agent-facing surfaces: MCP tool descriptions, prompt text, the doctrine the
// agent is told to adopt, and the steering block injected into every project.
function surfaces() {
  const out = [];
  const push = (p) => { if (existsSync(join(ROOT, p))) out.push(p); };
  for (const dir of ["src/server-tools", "src/project-knowledge"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (f.endsWith(".ts")) push(`${dir}/${f}`);
  }
  push("src/server.ts");
  push("src/server-instructions.ts");
  push("docs/agent-doctrine.md");
  return out.filter((p) => !ALLOWED_FILES.has(p));
}

// For .ts we only care about STRING LITERALS — a comment explaining which daemon
// serves a lane is developer-facing and explicitly exempt. For .md the whole file
// is the agent's reading material.
function agentText(path, body) {
  if (path.endsWith(".md")) return [{ line: 1, text: body }];
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // block comments
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))           // line comments
    .join("\n");
  const hits = [];
  const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (const m of stripped.matchAll(LITERAL)) {
    const line = stripped.slice(0, m.index).split("\n").length;
    hits.push({ line, text: m[0] });
  }
  return hits;
}

const fails = [];
const scanned = [];

for (const path of surfaces()) {
  const body = readFileSync(join(ROOT, path), "utf8");
  scanned.push(path);
  for (const { line, text } of agentText(path, body)) {
    for (const rx of FORBIDDEN) {
      const m = rx.exec(text);
      if (!m) continue;
      // Skip a match that is part of the wire token (see WIRE_TOKEN above).
      if (WIRE_TOKEN.test(text.slice(m.index, m.index + 20))) continue;
      // Quote enough context that the fix is obvious without opening the file.
      const at = text.indexOf(m[0]);
      const ctx = text.slice(Math.max(0, at - 60), at + m[0].length + 60).replace(/\s+/g, " ");
      fails.push({ path, line, word: m[0], ctx });
    }
  }
}

if (LIST) for (const s of scanned) console.log(`  scanned  ${s}`);
console.log(`  ${scanned.length} agent-facing surfaces scanned`);
console.log(`  exempt: code comments, CLAUDE.md, and ${[...ALLOWED_FILES].join(", ")}`);

for (const f of fails) {
  console.log(`  FAIL  ${f.path}:${f.line} — "${f.word}" reaches the agent`);
  console.log(`          …${f.ctx}…`);
}

// ---------- acceptance 3 + the recipe's own shape ----------
//
// Cheap and daemon-free: the version-mismatch text must be actionable (name both
// epochs AND carry the recipe), and the recipe must actually differ per OS — a
// single generic paragraph would satisfy "a recipe exists" while helping nobody.

const checks = [];
function check(name, cond, detail = "") {
  checks.push({ name, ok: !!cond, detail });
}

const DIST = join(ROOT, "dist/server-tools/runtime-setup-recipe.js");
if (!existsSync(DIST)) {
  console.log(`  SKIPPED the recipe checks — run \`npm run build:mcp\` first (${relative(ROOT, DIST)}).`);
} else {
  const { EXPECTED_RUNTIME_PROTOCOL, runtimeSetupRecipe } = await import(DIST);

  check("the expected protocol epoch is an integer", Number.isInteger(EXPECTED_RUNTIME_PROTOCOL),
    `epoch=${EXPECTED_RUNTIME_PROTOCOL}`);

  const real = process.platform;
  const seen = new Map();
  for (const plat of ["win32", "darwin", "linux"]) {
    Object.defineProperty(process, "platform", { value: plat, configurable: true });
    seen.set(plat, runtimeSetupRecipe("gate probe"));
  }
  Object.defineProperty(process, "platform", { value: real, configurable: true });

  for (const [plat, text] of seen) {
    check(`${plat} gets a recipe with substance`, typeof text === "string" && text.length > 120,
      `${text?.length ?? 0} chars`);
    check(`${plat}'s recipe carries the reason it was emitted`, /gate probe/.test(text ?? ""));
  }
  // Not "three distinct texts" — macOS and Linux legitimately coincide, because the
  // build commands are the same on both. What must differ is the ONE axis that really
  // does: Windows spells the binary and the env-var syntax differently, and a recipe
  // that told a Windows user to `export` would be worse than none.
  check("Windows gets its own shell syntax", /\bset [A-Z0-9_]+=/.test(seen.get("win32")));
  check("Windows names the .exe", /\.exe\b/.test(seen.get("win32")));
  // Positive only. A "must not contain `set X=`" check reads well and is wrong: the
  // recipe's own prose says "developers may set C64RE_ALLOW_INPROC_RUNTIME=1".
  check("POSIX uses export syntax",
    ["darwin", "linux"].every((p) => /\bexport [A-Z0-9_]+=/.test(seen.get(p))));
  check("Windows and POSIX are not the same text", seen.get("win32") !== seen.get("darwin"));
  check("the recipe names the backend — this is the ONE place that may",
    [...seen.values()].every((t) => /trx64/i.test(t)));
}

for (const c of checks) {
  if (!c.ok) fails.push({ path: "spec 800 acceptance", line: 0, word: c.name, ctx: c.detail });
  else if (LIST) console.log(`  PASS  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}

if (fails.length) {
  console.log(
    `\nRED  spec 800: ${fails.length} problem(s).\n` +
      `     The agent is told WHAT it can do, never WHICH backend does it.\n` +
      `     Say "the runtime" / "the daemon". The backend is named only in the setup recipe.`,
  );
  process.exit(1);
}
console.log(`\nGREEN  spec 800: 0 leaks on ${scanned.length} surfaces, ${checks.length} recipe checks pass.`);
