// Spec 823 — the MCP surface over the knowledge graph. Thin, and gated thin: a
// handler is parse args → one library call → format. The gate reads this file
// and fails if it imports anything but ../knowledge-graph/*, zod, ./safe-handler,
// ./types — no node:fs, no node:sqlite, no project-knowledge/*. Logic that a
// tool needs lives in src/knowledge-graph/cards.ts; the text and the JSON block
// come from src/knowledge-graph/format.ts, the same formatter the CLI uses.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { edgesWalk, nodeCard, overview, resolveRef, shortestPath, type EdgeKind, type Focus } from "../knowledge-graph/cards.js";
import { formatEdges, formatFind, formatNode, formatOverview, formatPath, stableJson, type Formatted } from "../knowledge-graph/format.js";
import { Graph } from "../knowledge-graph/query.js";
import { safeHandler } from "./safe-handler.js";
import type { ServerToolContext } from "./types.js";

function reply(formatted: Formatted) {
  const text = `${formatted.text}\n\n\`\`\`json\n${stableJson(formatted.json)}\n\`\`\``;
  return { content: [{ type: "text" as const, text }] };
}

function withGraph<T>(context: ServerToolContext, projectDir: string | undefined, fn: (graph: Graph) => T): T {
  const graph = Graph.open(context.projectDir(projectDir, false));
  try {
    return fn(graph);
  } finally {
    graph.close();
  }
}

const REF = z.string().describe("A node reference: an id any graph tool returned, an address like \"$D018\" or \"bank:07:$8000\", or a name / symbol (CHROUT, VMCSB, print_string).");
const PROJECT = z.string().optional().describe("Project root. Defaults to the session's project.");
const BANK = z.number().int().nonnegative().optional().describe("Cartridge bank to narrow an address to.");

export function registerGraphTools(server: McpServer, context: ServerToolContext): void {
  server.tool(
    "graph_find",
    "Resolve a name, address, register, ROM entry or label to knowledge-graph nodes — every context that has one, with stable ids. Use to start any structural question (\"where is the routine that…\", \"what is at $D018 in this project\") before opening a listing. Not for prose lookups of where a topic is described (use project_search). Inputs: query, optional kind / origin / bank / limit. Returns: ranked one-line hits plus a machine-readable JSON block whose ids round-trip into graph_node and graph_edges.",
    {
      project_dir: PROJECT,
      query: z.string().describe("Address ($D018, d018, bank:07:$8000), exact id, or name substring."),
      kind: z.enum(["routine", "label", "addr", "zp", "io", "rom", "ram", "subsystem", "run", "any"]).optional().describe("Node kind filter."),
      origin: z.enum(["human", "generated", "platform", "any"]).optional().describe("human = has a human row; generated = generated only; platform = the platform's own nodes."),
      bank: BANK,
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)."),
    },
    safeHandler("graph_find", async ({ project_dir, query, kind, origin, bank, limit }) =>
      withGraph(context, project_dir, (graph) => {
        let nodes = resolveRef(graph, query, bank);
        if (kind && kind !== "any") nodes = nodes.filter((n) => n.kind === kind);
        if (origin === "human") nodes = nodes.filter((n) => n.layers.includes("human"));
        else if (origin === "generated") nodes = nodes.filter((n) => !n.layers.includes("human") && !n.platform);
        else if (origin === "platform") nodes = nodes.filter((n) => n.platform);
        return reply(formatFind(query, nodes, limit ?? 10));
      }),
    ),
  );

  server.tool(
    "graph_node",
    "The card for one knowledge-graph node: kind, range, its generated label and its human name side by side, edge counts by type, the hardware / ROM / zero page it touches, and whether a trace run ever observed it. Use after graph_find to understand a routine or an address before reading its code. Not for walking the neighbourhood (use graph_edges) or for prose findings (use project_search). Inputs: ref, optional bank. Returns: the card plus a JSON block with next[] follow-up calls.",
    { project_dir: PROJECT, ref: REF, bank: BANK },
    safeHandler("graph_node", async ({ project_dir, ref, bank }) =>
      withGraph(context, project_dir, (graph) => {
        const nodes = resolveRef(graph, ref, bank);
        if (nodes.length === 0) return reply({ text: `no node for "${ref}"`, json: { ref, card: null } });
        if (nodes.length > 1) return reply({ ...formatFind(ref, nodes, 10), text: `"${ref}" is ambiguous — pick an id:\n${formatFind(ref, nodes, 10).text}` });
        return reply(formatNode(nodeCard(graph, nodes[0]!)));
      }),
    ),
  );

  server.tool(
    "graph_edges",
    "The neighbourhood walk: callers, callees, readers, writers, references, ROM calls, zero-page and hardware use, containment, indirect (unknown-target) accesses — one tool, chosen by direction × kind × origin. Use to answer \"who calls X\", \"who writes $D018\", \"what does this routine touch\", \"what did a trace observe here\". Not for finding the node in the first place (use graph_find) or for a route between two nodes (use graph_path). Inputs: ref, direction (in|out|both), kind, origin (static|runtime|human|any), depth 1–2, limit. Returns: one line per edge with its instruction evidence, plus a JSON block; truncated is stated.",
    {
      project_dir: PROJECT,
      ref: REF,
      direction: z.enum(["in", "out", "both"]).optional().describe("Default out."),
      kind: z.enum(["calls", "jumps", "branches", "reads", "writes", "references", "calls_rom", "uses_zp", "uses_hardware", "changes_banking", "handles_irq", "contains", "indirect", "any"]).optional().describe("Edge family; default any."),
      origin: z.enum(["static", "runtime", "human", "any"]).optional().describe("Default any — static and runtime rows both, each labelled."),
      depth: z.number().int().min(1).max(2).optional().describe("1 or 2 hops (default 1)."),
      bank: BANK,
      limit: z.number().int().min(1).max(200).optional().describe("Max edges (default 25)."),
    },
    safeHandler("graph_edges", async ({ project_dir, ref, direction, kind, origin, depth, bank, limit }) =>
      withGraph(context, project_dir, (graph) => {
        const roots = resolveRef(graph, ref, bank);
        if (roots.length === 0) return reply({ text: `no node for "${ref}"`, json: { ref, edges: [], total: 0, truncated: false } });
        return reply(formatEdges(edgesWalk(graph, roots, { direction, kind: kind as EdgeKind | undefined, origin, depth: depth as 1 | 2 | undefined, limit })));
      }),
    ),
  );

  server.tool(
    "graph_path",
    "Is there a control-flow path from one node to another, and through what. Use to connect an entry point to a routine, or a routine to a KERNAL call, before reading the code in between. Not for listing a node's direct edges (use graph_edges). Inputs: from, to (ids, addresses or names), via (calls | calls+jumps | any), max_depth. Returns: the shortest path as hops with per-hop evidence, or \"no path\" with the size of the reachable frontier, plus a JSON block.",
    {
      project_dir: PROJECT,
      from: REF,
      to: REF,
      via: z.enum(["calls", "calls+jumps", "any"]).optional().describe("Edge families to walk (default any control flow)."),
      max_depth: z.number().int().min(1).max(32).optional().describe("Default 8."),
      bank: BANK,
    },
    safeHandler("graph_path", async ({ project_dir, from, to, via, max_depth, bank }) =>
      withGraph(context, project_dir, (graph) => {
        const a = resolveRef(graph, from, bank)[0];
        const b = resolveRef(graph, to, bank)[0];
        if (!a || !b) return reply({ text: `cannot resolve ${!a ? `from "${from}"` : `to "${to}"`}`, json: { from, to, paths: [], frontier: 0 } });
        return reply(formatPath(shortestPath(graph, a.id, b.id, via, max_depth)));
      }),
    ),
  );

  server.tool(
    "graph_overview",
    "The project's structural map from the graph: entry points, IRQ/NMI handlers seen in trace runs, banking sites, the hardware registers and KERNAL routines most used, the hottest zero page, subsystems, and the indirect accesses that still have no resolution. Use as the first question on a project you have not read, or to find where the unknowns are. Not for one node (use graph_node) or prose (use project_search). Inputs: optional focus, bank. Returns: per-section top-N with counts, plus a JSON block.",
    {
      project_dir: PROJECT,
      focus: z.enum(["entries", "irq", "banking", "hardware", "rom", "zp", "subsystems", "unknown", "all"]).optional().describe("One section, or all (default)."),
      top: z.number().int().min(1).max(50).optional().describe("Entries per section (default 10)."),
    },
    safeHandler("graph_overview", async ({ project_dir, focus, top }) =>
      withGraph(context, project_dir, (graph) => reply(formatOverview(overview(graph, (focus ?? "all") as Focus, top ?? 10)))),
    ),
  );
}
