// Spec 740.1 — Project Wiki + Knowledge Retrieval MVP tools.
//
// Default-surface retrieval over the project's curated wiki + structured
// knowledge, so an external LLM can find where a topic / address / track is
// described without reading every .md / .json / ASM file. Deterministic
// index, no embeddings, no vector DB, no network. The index is a cache; the
// raw sources stay authoritative.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";
import {
  buildProjectSearchIndex, writeIndexCache, loadOrBuildIndex,
  searchIndex, findRelated, type SearchHit,
} from "../project-knowledge/project-search.js";
import { ensureWikiSkeleton, appendActivityLog, readWikiIndex } from "../project-knowledge/project-wiki.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fmtAddr(a?: { start: number; end: number }): string {
  if (!a) return "";
  const h = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  return a.start === a.end ? ` ${h(a.start)}` : ` ${h(a.start)}-${h(a.end)}`;
}

function renderHit(h: SearchHit): string {
  const ids = [...h.artifactIds.slice(0, 2), ...h.entityIds.slice(0, 2)];
  const tail = ids.length ? `  →${ids.join(",")}` : "";
  const anchor = h.sourceAnchor ? `#${h.sourceAnchor}` : "";
  return `• [${h.kind}]${fmtAddr(h.addressRange)} ${h.title}\n    ${h.snippet}\n    ${h.sourcePath}${anchor}  | id=${h.id}${tail}\n    why: ${h.why.join("; ")}`;
}

export function registerProjectSearchTools(server: McpServer, ctx: ServerToolContext): void {
  // project_reindex_search — rebuild the local cache.
  server.tool(
    "project_reindex_search",
    "Rebuild the project's local search index from its current files (wiki docs, knowledge findings/entities/relations/flows/artifacts/versions, selected views, and ASM/TASS section headers) and scaffold the wiki skeleton (docs/index.md, knowledge/activity-log.md) if missing. Use once after large ingests/analysis/disassembly so project_search reflects new knowledge; a full rebuild is cheap. Not the way to read knowledge (use project_search / project_find_related) and not a knowledge store (the index is a rebuildable cache, the raw files stay authoritative). Returns counts by kind, source files read, and any warnings.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
    },
    safeHandler("project_reindex_search", async ({ project_dir }: { project_dir?: string }) => {
      const dir = ctx.projectDir(project_dir, true);
      const skeleton = ensureWikiSkeleton(dir);
      const index = buildProjectSearchIndex(dir);
      const nowIso = new Date().toISOString();
      writeIndexCache(dir, index, nowIso);
      appendActivityLog(dir, "reindex", `search index rebuilt (${index.records.length} records)`, nowIso);
      const countLines = Object.entries(index.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join("\n");
      const lines = [
        `Reindexed ${index.records.length} records into knowledge/.cache/project-search-index.json`,
        skeleton.created.length ? `Wiki scaffolded: ${skeleton.created.join(", ")}` : "Wiki files present.",
        `Counts by kind:`,
        countLines,
        `Sources read (${index.sourcesRead.length}): ${index.sourcesRead.slice(0, 20).join(", ")}${index.sourcesRead.length > 20 ? " …" : ""}`,
      ];
      if (index.warnings.length) lines.push(`Warnings (${index.warnings.length}): ${index.warnings.slice(0, 8).join(" | ")}`);
      return textContent(lines.join("\n"));
    }),
  );

  // project_search — the normal "where is X?" entry point.
  server.tool(
    "project_search",
    "Find where a topic, address, track/sector, label, or artifact is described in this project — the normal first step for any \"where is X?\" question instead of reading every doc/JSON/ASM file. Ranks deterministically (exact address/track match, then exact id/title/tag, current-best artifact versions and curated docs/findings over generated analysis, then text match) and returns compact hits: id, kind, title, short snippet, source path/anchor, tags, address range, linked artifact/entity ids, and a why explaining each match. Use the returned ids/paths with read_artifact / read_finding / list_artifact_versions / trace readers for the exact bytes. Not a content dump (snippets only) and not the structured list tools (use list_findings / list_artifacts for full enumerations). Run project_reindex_search first if the index is stale.",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      query: z.string().describe("Free text and/or tokens like $FC00, T18/S11, 'track 36', a label, an artifact/finding id, or a topic."),
      kind: z.string().optional().describe("Filter by record kind: finding, entity, relation, flow, open_question, artifact, artifact_version, doc_section, wiki_page, asm_section, view, activity_log_entry."),
      tag: z.string().optional().describe("Filter by an exact tag."),
      address: z.string().optional().describe("Filter to records touching an address/track, e.g. $FC00 or 'track 36'."),
      artifact_id: z.string().optional().describe("Filter to records linked to this artifact id."),
      entity_id: z.string().optional().describe("Filter to records linked to this entity id."),
      limit: z.number().optional().describe("Max hits (default 10, max 50)."),
    },
    safeHandler("project_search", async (args: { project_dir?: string; query: string; kind?: string; tag?: string; address?: string; artifact_id?: string; entity_id?: string; limit?: number }) => {
      const dir = ctx.projectDir(args.project_dir);
      const index = loadOrBuildIndex(dir);
      const hits = searchIndex(index, args.query, { kind: args.kind, tag: args.tag, address: args.address, artifactId: args.artifact_id, entityId: args.entity_id }, args.limit ?? 10);
      if (hits.length === 0) return textContent(`No matches for "${args.query}". Try project_reindex_search if the project changed, or broaden the query.`);
      return textContent(`${hits.length} hit(s) for "${args.query}":\n\n${hits.map(renderHit).join("\n\n")}`);
    }),
  );

  // project_find_related — walk neighbours of an id / address / subject.
  server.tool(
    "project_find_related",
    "From an id, address, or subject stem (e.g. an artifact id, '$FC00', or '02_2.0'), return the nearby project records grouped by how they connect — artifact versions, findings, entities, relations, docs, views, and address overlaps. Use to pull together everything known about one payload/region/address after project_search points you at it, without manually cross-referencing files. Returns compact grouped hits (id, kind, title, snippet, source path, why). Not a free-text search (use project_search) and not a full relation dump (use the relation/entity list tools for exhaustive graphs).",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      id_or_query: z.string().describe("A record id, an address/track ($FC00, 'track 36'), a subject stem (02_2.0), or a short query."),
      limit: z.number().optional().describe("Max items per group (default 8)."),
    },
    safeHandler("project_find_related", async (args: { project_dir?: string; id_or_query: string; limit?: number }) => {
      const dir = ctx.projectDir(args.project_dir);
      const index = loadOrBuildIndex(dir);
      const result = findRelated(index, args.id_or_query, args.limit ?? 8);
      const seedLabel = "query" in result.seed ? `query "${result.seed.query}"` : `${result.seed.kind} ${result.seed.title} (${result.seed.id})`;
      if (result.groups.length === 0) return textContent(`No related records for ${seedLabel}.`);
      const blocks = result.groups.map((g) => `## ${g.group} (${g.items.length})\n${g.items.map((it) => `• [${it.kind}] ${it.title}\n    ${it.snippet}\n    ${it.sourcePath} | id=${it.id} | why: ${it.why.join(", ")}`).join("\n")}`);
      return textContent(`Related to ${seedLabel}:\n\n${blocks.join("\n\n")}`);
    }),
  );

  // project_wiki_lint — report wiki coverage gaps (small, read-only).
  server.tool(
    "project_wiki_lint",
    "Report gaps between the curated wiki (docs/index.md) and the structured knowledge: important active findings not yet mentioned in the wiki index, and orphan findings with no linked artifact or entity. Use after a mapping session to see what still needs to be written up, instead of eyeballing every finding. Read-only; it never edits files. Returns the gap lists. Not a content generator (writing the wiki up is a manual/740.2 step) and not a structured validator (use the knowledge list tools for full audits).",
    {
      project_dir: z.string().optional().describe("Project root directory. Absolute or project-relative; defaults to the active project."),
      limit: z.number().optional().describe("Max items per list (default 15)."),
    },
    safeHandler("project_wiki_lint", async (args: { project_dir?: string; limit?: number }) => {
      const dir = ctx.projectDir(args.project_dir);
      const index = loadOrBuildIndex(dir);
      const limit = args.limit ?? 15;
      const wiki = (readWikiIndex(dir) ?? "").toLowerCase();
      const findings = index.records.filter((r) => r.kind === "finding");
      const uncovered = findings.filter((f) => {
        const key = f.title.toLowerCase().slice(0, 24);
        const idKey = f.id.toLowerCase();
        return key.length > 4 && !wiki.includes(key) && !wiki.includes(idKey);
      });
      const orphan = findings.filter((f) => f.artifactIds.length === 0 && f.entityIds.length === 0);
      const lines: string[] = [];
      lines.push(`Wiki lint: ${findings.length} finding(s) indexed; docs/index.md ${wiki ? "present" : "MISSING — run project_reindex_search"}.`);
      lines.push(`\nFindings not summarized in docs/index.md (${uncovered.length}):`);
      lines.push(uncovered.slice(0, limit).map((f) => `  • ${f.title}  | id=${f.id}`).join("\n") || "  (none)");
      lines.push(`\nOrphan findings with no linked artifact/entity (${orphan.length}):`);
      lines.push(orphan.slice(0, limit).map((f) => `  • ${f.title}  | id=${f.id}`).join("\n") || "  (none)");
      return textContent(lines.join("\n"));
    }),
  );
}
