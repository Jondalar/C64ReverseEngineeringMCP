// Spec 847 D7 — `c64re doc lint|check <path>`, the entry a hook calls.
//
// The owner asked whether a hook on the write itself could enforce the declaration. It
// can, and it must not be the primary layer, for one reason: a hook lives in the HARNESS,
// and the harness is not the product. A PreToolUse hook works in Claude Code, for one
// user, when configured. Codex gets nothing, CI gets nothing, and a project handed to
// someone else carries none of it.
//
// So the logic lives here and the hook is three lines that call it. The trigger is
// per-harness; the rule travels with the project. A pre-commit hook, a CI step or a
// person gets the identical answer.
//
// And the shape matters as much as the placement: `check` does not merely say no. It
// exits non-zero AND prints the frontmatter template for that document, so the fix is one
// edit away. That is the Spec 834 pattern — refuse and say exactly what is missing —
// applied at the file boundary. A gate that only forbids is a gate people route around,
// which is exactly what happened to Spec 740's wiki.

import { existsSync, readFileSync } from "node:fs";
import { resolve, basename, relative } from "node:path";

export async function runDocCli(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (verb === "lint") {
    const dir = resolve(argv[1] ?? process.env.C64RE_PROJECT_DIR ?? process.cwd());
    const { lintDocs, formatDocLint } = await import("./scan.js");
    const r = lintDocs(dir);
    process.stdout.write(formatDocLint(r) + "\n");
    // Malformed frontmatter is an error; a backlog of undeclared documents is not.
    process.exitCode = r.malformed.length > 0 ? 1 : 0;
    return;
  }

  if (verb === "check") {
    const file = argv[1];
    if (!file) {
      process.stderr.write("usage: c64re doc check <path-to.md>\n");
      process.exitCode = 2;
      return;
    }
    const abs = resolve(file);
    if (!existsSync(abs)) { process.exitCode = 0; return; } // nothing written yet
    if (!/\.md$/i.test(abs)) { process.exitCode = 0; return; }
    if (!/(^|\/)docs(\/|$)/.test(abs.replace(/\\/g, "/"))) { process.exitCode = 0; return; }

    const { parseFrontmatter, template } = await import("./frontmatter.js");
    const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
    if (parsed.frontmatter) { process.exitCode = 0; return; }

    const title = basename(abs).replace(/\.md$/i, "").replace(/[_-]+/g, " ");
    process.stderr.write([
      `${relative(process.cwd(), abs)} ${parsed.absent ? "has no frontmatter" : `has malformed frontmatter: ${parsed.error}`}.`,
      "",
      "Without it nothing can cite this document, no check can read it, and it will not",
      "appear in the index. The fields are what a document like this already states in its",
      "first paragraph, so filling them is transcription:",
      "",
      template("synthesis", title),
    ].join("\n"));
    process.exitCode = 1;
    return;
  }

  if (verb === "index") {
    const dir = resolve(argv[1] ?? process.env.C64RE_PROJECT_DIR ?? process.cwd());
    const { renderWikiIndex } = await import("./register.js");
    process.stdout.write(await renderWikiIndex(dir) + "\n");
    return;
  }

  process.stderr.write([
    "usage:",
    "  c64re doc lint  [project-dir]   what is declared, undeclared, malformed, dangling",
    "  c64re doc check <path.md>       exit 1 + the template when a docs/*.md is undeclared",
    "  c64re doc index [project-dir]   the derived document index",
    "",
    "`check` is what a write hook calls. Claude Code, settings.json:",
    '  {"hooks":{"PreToolUse":[{"matcher":"Write|Edit",',
    '    "hooks":[{"type":"command","command":"c64re doc check \\"$CLAUDE_TOOL_INPUT_file_path\\""}]}]}}',
    "",
    "The same command works from a pre-commit hook, from CI, or by hand — which is the",
    "point: the trigger is per-harness, the rule travels with the project.",
  ].join("\n") + "\n");
  process.exitCode = 2;
}
