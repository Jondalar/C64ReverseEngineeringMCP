// Spec 847 — the doors onto the document layer.
//
// `doc_register` declares one document. `doc_lint` says what is undeclared, malformed or
// citing something that is not there. `wiki_index` renders the index from the
// declarations, which is why it cannot sit empty the way Spec 740's did in both projects
// for four months.
//
// There is no `doc_write`. Nothing here generates prose: the evidence is that sessions
// write their synthesis unprompted — 59 KB of it in one file, nine model documents in
// another directory — they just write it invisibly. This makes existing behaviour
// legible; it does not ask for new behaviour.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerToolContext } from "./types.js";
import { lintDocs, formatDocLint } from "../docs/scan.js";
import { registerDoc, listDocNodes, renderWikiIndex, writeWikiIndex, DocRegisterError } from "../docs/register.js";
import { DOC_KINDS, template } from "../docs/frontmatter.js";

export function registerDocTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "doc_register",
    "Declare one Markdown document: read its frontmatter and make it a node in the graph, so it can be cited, linted and found. Use after writing a synthesis document (a model, a port spec, a budget). Refuses without frontmatter and hands back the template. Inputs: path. Returns: the node + what it covers.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      path: z.string().describe("Project-relative path to the .md, e.g. docs/model/A_overlay_model.md"),
    },
    async ({ project_dir, path }) => {
      const pd = context.projectDir(project_dir, true);
      try {
        const d = await registerDoc(pd, path);
        return {
          content: [{ type: "text" as const, text: `Registered ${d.kind} "${d.title}" (${d.path}) — ${d.covers} coverage entr${d.covers === 1 ? "y" : "ies"}.` }],
          structuredContent: { id: d.id, path: d.path, kind: d.kind, covers: d.covers },
        };
      } catch (e) {
        if (e instanceof DocRegisterError) {
          return { content: [{ type: "text" as const, text: `# doc_register refused\n\n${e.message}` }] };
        }
        throw e;
      }
    },
  );

  server.tool(
    "doc_lint",
    "Which documents declare themselves and which do not: undeclared files, malformed frontmatter, and `amends:` citations naming a document that is not in the project. Use after a writing session, or to see the backlog. Read-only. Inputs: optional project_dir. Returns: the lists, largest undeclared first.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
    },
    async ({ project_dir }) => {
      const pd = context.projectDir(project_dir);
      const r = lintDocs(pd);
      return {
        content: [{ type: "text" as const, text: formatDocLint(r) }],
        structuredContent: {
          total: r.docs.length, declared: r.declaredCount,
          undeclared: r.undeclared.map((d) => d.path),
          malformed: r.malformed.map((d) => ({ path: d.path, error: d.error })),
          dangling: r.dangling,
        },
      };
    },
  );

  server.tool(
    "doc_template",
    "The frontmatter block to put at the top of a document, for a given kind. Use before writing a synthesis document, or when doc_register refuses. Inputs: kind, title. Returns: the block, ready to paste.",
    {
      kind: z.enum(DOC_KINDS).default("synthesis").describe("synthesis = an argued narrative; reference = a lookup; decision = a choice and why; generated = written by a tool"),
      title: z.string().describe("The document's title"),
    },
    async ({ kind, title }) => ({
      content: [{ type: "text" as const, text: template(kind, title) }],
    }),
  );

  server.tool(
    "wiki_index",
    "The project's document index, DERIVED from the declarations (Spec 847 D6) — never hand-maintained, so it cannot go empty. Use to see what is documented and what covers which address range. Inputs: optional write. Returns: the index; with write=true also saves docs/index.md.",
    {
      project_dir: z.string().optional().describe("Project directory (default: the current project)"),
      write: z.boolean().default(false).describe("Also write docs/index.md"),
    },
    async ({ project_dir, write }) => {
      const pd = context.projectDir(project_dir, write);
      const text = await renderWikiIndex(pd);
      let wrote = "";
      if (write) wrote = `\n\nWritten: ${await writeWikiIndex(pd)}`;
      const nodes = await listDocNodes(pd);
      return {
        content: [{ type: "text" as const, text: text + wrote }],
        structuredContent: { documents: nodes.filter((n) => !n.placeholder).length },
      };
    },
  );
}
