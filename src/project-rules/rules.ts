// Spec 849 D4 — the rule texts, read once and indexed by what triggers them.
//
// A rule carries two triggers because it has two delivery paths, and only one of them
// was ever real for this workflow:
//
//   paths:  the harness glob. MEASURED: it fires when a matching file is READ with the
//           native Read tool, and not when one is written. An RE session reads through
//           `read_artifact`, `graph_find`, `disasm_prg` — the harness never sees those
//           touches. Run 4 made four native file accesses in 102 turns and all four were
//           writes, so not one rule fired. It stays in the frontmatter because it costs
//           nothing and does work for a human who opens a listing by hand.
//
//   tools:  the real path. The MCP tool that IS the moment appends the rule to its own
//           result. That fires where this work actually happens, and it is ours to
//           control rather than the harness's.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shippedRules, shippedRulesDir } from "./provision.js";

export interface Rule {
  /** the file's stem — the id used in the delivery ledger */
  id: string;
  description: string;
  /** globs for the harness path (advisory; see the note above) */
  paths: string[];
  /** MCP tools whose result carries this rule */
  tools: string[];
  /** the prose, frontmatter stripped */
  body: string;
}

/** Parse one rule file. The frontmatter is flat and the arrays are single-line JSON. */
export function parseRule(id: string, text: string): Rule | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const fm = m[1];
  const list = (key: string): string[] => {
    const line = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]\\s*$`, "m").exec(fm);
    if (!line) return [];
    return [...line[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const desc = /^description:\s*(.+)$/m.exec(fm);
  return {
    id,
    description: desc ? desc[1].trim() : "",
    paths: list("paths"),
    tools: list("tools"),
    body: text.slice(m[0].length).trim(),
  };
}

let cache: Rule[] | undefined;

/** Every shipped rule. Read once per process — they are part of the build, not of a project. */
export function allRules(): Rule[] {
  if (cache) return cache;
  const dir = shippedRulesDir();
  if (!dir) return (cache = []);
  const out: Rule[] = [];
  for (const file of shippedRules(dir)) {
    try {
      const r = parseRule(file.replace(/\.md$/, ""), readFileSync(join(dir, file), "utf8"));
      if (r) out.push(r);
    } catch { /* a rule that cannot be read is not a reason to fail a tool call */ }
  }
  return (cache = out);
}

/** The rule this tool carries, if any. One tool never carries two. */
export function ruleForTool(toolName: string): Rule | undefined {
  return allRules().find((r) => r.tools.includes(toolName));
}

/** A project's own copy, when it has one — a hand-edited rule is the owner's word. */
export function projectRuleOverride(projectDir: string, id: string): Rule | undefined {
  const path = join(projectDir, ".claude", "rules", `${id}.md`);
  if (!existsSync(path)) return undefined;
  try {
    return parseRule(id, readFileSync(path, "utf8"));
  } catch { return undefined; }
}
