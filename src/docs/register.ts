// Spec 847 D3/D6 — a document is a node, and the index is derived from the nodes.
//
// The question that started this asked whether a JSON store should sit beside the graph.
// It should not: Spec 822.2 removed exactly that arrangement, and DOCTRINE.md records the
// reason — three copies drifted. So a declared document becomes a node like any other,
// with the ranges it covers, and citations become edges. Then Spec 845's boundaries can
// cite a document and Spec 846's `amends:` resolves instead of being a free string.
//
// D6: because the index is a QUERY over those nodes rather than a file someone maintains,
// it cannot sit empty for four months the way Spec 740's wiki did in both projects.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from "./frontmatter.js";
import { scanDocs, type ScannedDoc } from "./scan.js";

export class DocRegisterError extends Error {}

export interface RegisteredDoc {
  id: string;
  path: string;
  title: string;
  kind: string;
  covers: number;
}

/** `docs/model/A_overlay_model.md` -> `a_overlay_model` */
function docSlug(path: string): string {
  const base = basename(path).replace(/\.md$/i, "");
  const s = base.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (s.length === 0) throw new DocRegisterError(`"${path}" has no usable characters for an id`);
  return s;
}

export async function registerDoc(projectDir: string, relPath: string): Promise<RegisteredDoc> {
  const abs = join(projectDir, relPath);
  if (!existsSync(abs)) throw new DocRegisterError(`no document at ${relPath}`);
  const parsed = parseFrontmatter(readFileSync(abs, "utf8"));

  if (parsed.absent) {
    const { template } = await import("./frontmatter.js");
    throw new DocRegisterError(
      [
        `${relPath} has no frontmatter, so nothing can cite it and nothing can check it.`,
        "",
        "Add this at the very top — the fields are what a document like this already says",
        "in its first paragraph, so filling them is transcription, not new thinking:",
        "",
        template("synthesis", basename(relPath).replace(/\.md$/i, "").replace(/[_-]+/g, " ")),
      ].join("\n"),
    );
  }
  if (parsed.error || !parsed.frontmatter) {
    throw new DocRegisterError(`${relPath}: ${parsed.error ?? "the frontmatter did not parse"}`);
  }
  const fm = parsed.frontmatter;

  const { GraphStore, readProjectSlug } = await import("../knowledge-graph/store.js");
  const { deriveSubsystemId } = await import("../knowledge-graph/ids.js");
  const store = GraphStore.open(projectDir);
  try {
    const slug = readProjectSlug(projectDir);
    const id = deriveSubsystemId(slug, `doc.${docSlug(relPath)}`);
    store.upsertHuman({
      id,
      kind: "document",
      name: fm.title,
      attrs: {
        path: relPath,
        docKind: fm.kind,
        status: fm.status,
        covers: fm.covers,
        sources: fm.sources,
        ...(fm.method ? { method: fm.method } : {}),
        ...(fm.amends ? { amends: fm.amends } : {}),
        ...(fm.generated ? { generated: fm.generated } : {}),
      },
      origin: "user",
      confidence: "user_asserted",
      // The document's own declaration IS its evidence: it says what it read.
      evidence: fm.sources.length > 0 ? fm.sources : [relPath],
    }, "847");

    // Citations become edges, so a dangling one is a query rather than a grep.
    for (const a of fm.amends ?? []) {
      const target = deriveSubsystemId(slug, `doc.${docSlug(a)}`);
      store.upsertHuman({
        id: target, kind: "document", name: a,
        attrs: { path: a, docKind: "reference", status: "current", covers: [], sources: [], placeholder: true },
        origin: "imported", confidence: "inferred", evidence: [`cited by ${relPath}`],
      }, "847");
    }
    return { id, path: relPath, title: fm.title, kind: fm.kind, covers: fm.covers.length };
  } finally {
    store.close();
  }
}

export interface DocNode {
  id: string;
  path: string;
  title: string;
  docKind: string;
  status: string;
  covers: Array<{ kind: string; start?: number; end?: number; ref?: string }>;
  method?: string;
  placeholder: boolean;
}

export async function listDocNodes(projectDir: string): Promise<DocNode[]> {
  const { GraphStore } = await import("../knowledge-graph/store.js");
  let store;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return []; }
  try {
    const rows = store.db.prepare(
      "SELECT id, name, attrs FROM nodes WHERE kind = 'document' ORDER BY id",
    ).all() as Array<{ id: string; name: string | null; attrs: string }>;
    return rows.map((r) => {
      let a: Record<string, unknown> = {};
      try { a = JSON.parse(r.attrs) as Record<string, unknown>; } catch { /* keep empty */ }
      return {
        id: r.id,
        path: typeof a.path === "string" ? a.path : r.id,
        title: r.name ?? r.id,
        docKind: typeof a.docKind === "string" ? a.docKind : "reference",
        status: typeof a.status === "string" ? a.status : "current",
        covers: Array.isArray(a.covers) ? (a.covers as DocNode["covers"]) : [],
        ...(typeof a.method === "string" ? { method: a.method } : {}),
        placeholder: a.placeholder === true,
      };
    });
  } finally { store.close(); }
}

/**
 * D6 — the index, derived.
 *
 * Spec 740's `docs/index.md` was scaffolded into both long-running projects in May and
 * still reads "(no curated entries yet)" in 7 of 7 categories, because 740.2 — the tool
 * that would have written it — was never built and no human filled it by hand. This one
 * is a render of the declarations, so the only way for it to be empty is for there to be
 * no documents.
 */
export async function renderWikiIndex(projectDir: string): Promise<string> {
  const nodes = (await listDocNodes(projectDir)).filter((n) => !n.placeholder);
  const scanned = scanDocs(projectDir);
  const undeclared = scanned.filter((d) => !d.declared);

  const lines: string[] = [];
  lines.push("<!-- generated by c64re wiki_index (Spec 847 D6); derived from document frontmatter -->", "");
  lines.push("# Project Documents", "");
  if (nodes.length === 0) {
    lines.push("No document declares itself yet. `doc_lint` lists what is here;");
    lines.push("`doc_register <path>` declares one.", "");
  }

  const byKind = new Map<string, DocNode[]>();
  for (const n of nodes) byKind.set(n.docKind, [...(byKind.get(n.docKind) ?? []), n]);
  for (const kind of ["synthesis", "decision", "reference", "generated"]) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;
    lines.push(`## ${kind}`, "");
    for (const n of group.sort((a, b) => a.path.localeCompare(b.path))) {
      const cov = n.covers.map((c) => c.kind === "range" ? `$${hex(c.start ?? 0)}-$${hex(c.end ?? 0)}` : `${c.ref}`).join(", ");
      lines.push(`- **[${n.title}](${n.path})**${n.status === "superseded" ? " _(superseded)_" : ""}`);
      if (cov) lines.push(`  covers: ${cov}`);
      if (n.method) lines.push(`  method: ${n.method}`);
    }
    lines.push("");
  }
  if (undeclared.length > 0) {
    lines.push(`## Undeclared (${undeclared.length})`, "");
    lines.push("Present on disk, invisible to every query. Largest first:", "");
    for (const d of [...undeclared].sort((a, b) => b.bytes - a.bytes).slice(0, 15)) {
      lines.push(`- \`${d.path}\` — ${(d.bytes / 1024).toFixed(0)} KB`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeWikiIndex(projectDir: string): Promise<string> {
  const path = join(projectDir, "docs", "index.md");
  writeFileSync(path, await renderWikiIndex(projectDir));
  return path;
}

/** D4 — the provenance block render_docs stamps onto what it writes. */
export function generatedFrontmatter(title: string, counts: Record<string, number>): string {
  const fm: Frontmatter = {
    title, kind: "generated", covers: [], sources: [],
    status: "current",
    generated: { at: new Date().toISOString(), counts },
  };
  return renderFrontmatter(fm);
}

export type { ScannedDoc };
function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
