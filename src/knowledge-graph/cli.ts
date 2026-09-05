// Spec 818 D8 / 819 D8 — `c64re graph <verb>`, the CLI over the query API.
// Human output is a table; `--json` is ONE document on stdout and nothing else.
// MCP tools over the same library are Spec 823.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { seedControlFlow } from "./producers/control-flow.js";
import { Graph, type EdgeHit, type ResolvedNode } from "./query.js";
import { GraphStore } from "./store.js";

const USAGE = `Usage: c64re graph <verb> [args] [--project <dir>] [--json]

  find <$addr|id|name>          nodes at an address, one id, or a name substring
  callers <id>                  CALLS / CALLS_ROM into a node
  callees <id>                  CALLS / CALLS_ROM out of a node
  readers <$addr>               READS into the node(s) at an address
  writers <$addr>               WRITES into the node(s) at an address
  references <$addr>            every edge into and out of the node(s) at an address
  path <from-id> <to-id>        shortest control-flow path
  routines [--owner <stem>]     routine nodes
  labels <routine-id>           labels a routine CONTAINS
  uses-kernal <name|$addr>      callers of a platform ROM node (CHROUT, $FFD2)
  seed [--owner <stem>]         run the control-flow producer over every _analysis.json (or one)
  dump                          canonical dump of the generated layer (818 D6)
  stats                         row counts and meta`;

interface Args { verb: string; positional: string[]; project: string; json: boolean; owner?: string }

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let project = process.env.C64RE_PROJECT_DIR ?? process.cwd();
  let json = false;
  let owner: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--project") project = argv[++i] ?? project;
    else if (a === "--owner") owner = argv[++i];
    else positional.push(a);
  }
  const [verb = "help", ...rest] = positional;
  return { verb, positional: rest, project: resolve(project), json, owner };
}

function findAnalysisJsons(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) findAnalysisJsons(p, out, depth + 1);
    else if (entry.endsWith("_analysis.json")) out.push(p);
  }
  return out.sort();
}

function nodeLine(n: ResolvedNode): string {
  const flags = [n.platform ? "platform" : "", n.orphaned ? "orphaned" : "", n.dangling ? "DANGLING" : "", n.layers.includes("human") ? "human" : ""].filter(Boolean).join(",");
  const extent = n.endAddress !== null && n.endAddress !== n.address ? `-$${n.endAddress.toString(16).toUpperCase().padStart(4, "0")}` : "";
  return `${n.id.padEnd(52)} ${n.kind.padEnd(8)} $${n.address.toString(16).toUpperCase().padStart(4, "0")}${extent.padEnd(6)} ${(n.name ?? "").slice(0, 40).padEnd(40)} ${flags}`;
}

function edgeLine(e: EdgeHit): string {
  const ev = e.evidence;
  const where = typeof ev.source_address === "number" ? `@$${(ev.source_address as number).toString(16).toUpperCase().padStart(4, "0")}` : "";
  const instr = typeof ev.instruction === "string" ? ev.instruction : "";
  const amb = ev.ambiguity ? ` [${String(ev.ambiguity)}]` : "";
  const dang = e.toNode.dangling ? " [DANGLING]" : "";
  return `${e.from.padEnd(52)} ${e.type.padEnd(12)} ${e.to.padEnd(40)} ${e.confidence.padEnd(9)} ${where.padEnd(7)} ${instr}${amb}${dang}`;
}

export async function runGraphCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const out = (human: string, json: unknown) => {
    if (args.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    else process.stdout.write(`${human}\n`);
  };

  if (args.verb === "help" || args.verb === "--help") { process.stdout.write(`${USAGE}\n`); return; }

  if (args.verb === "seed") {
    const files = args.owner
      ? findAnalysisJsons(args.project).filter((p) => p.toLowerCase().endsWith(`${args.owner}_analysis.json`))
      : findAnalysisJsons(args.project);
    if (files.length === 0) throw new Error(`no _analysis.json under ${args.project}${args.owner ? ` for owner ${args.owner}` : ""}`);
    const results = files.map((analysisPath) => seedControlFlow({ projectDir: args.project, analysisPath }));
    out(results.map((r) => `${r.owner.padEnd(40)} routines=${r.routines} labels=${r.labels} addr=${r.addrNodes} edges=${JSON.stringify(r.edges)} rom-ambiguous=${r.ambiguousRomCalls} ${r.ms.toFixed(0)}ms`).join("\n"), results);
    return;
  }

  if (args.verb === "dump") {
    const store = GraphStore.open(args.project, { readOnly: true });
    try { process.stdout.write(store.canonicalDump()); } finally { store.close(); }
    return;
  }

  const graph = Graph.open(args.project);
  try {
    const [a, b] = args.positional;
    switch (args.verb) {
      case "stats": {
        const c = graph.store.counts();
        const meta = { schema_version: graph.store.getMeta("schema_version"), producers: graph.store.getMeta("producers"), platform_kb_revision: graph.store.getMeta("platform_kb_revision") };
        out(`nodes=${c.nodes} edges=${c.edges} human-nodes=${c.humanNodes} human-edges=${c.humanEdges} meta=${JSON.stringify(meta)}`, { ...c, meta });
        return;
      }
      case "find": {
        if (!a) throw new Error("find needs an address, id or name");
        const nodes = graph.find(a);
        out(nodes.length ? nodes.map(nodeLine).join("\n") : "(nothing)", nodes);
        return;
      }
      case "callers":
      case "callees": {
        if (!a) throw new Error(`${args.verb} needs an id`);
        const hits = args.verb === "callers" ? graph.callers(a) : graph.callees(a);
        out(hits.length ? hits.map(edgeLine).join("\n") : "(none)", hits);
        return;
      }
      case "readers":
      case "writers": {
        if (!a) throw new Error(`${args.verb} needs an address`);
        const hits = args.verb === "readers" ? graph.readers(a) : graph.writers(a);
        out(hits.length ? hits.map(edgeLine).join("\n") : "(none)", hits);
        return;
      }
      case "references": {
        if (!a) throw new Error("references needs an address");
        const r = graph.references(a);
        out([`# into`, ...r.into.map(edgeLine), `# out of`, ...r.outof.map(edgeLine)].join("\n"), r);
        return;
      }
      case "path": {
        if (!a || !b) throw new Error("path needs <from-id> <to-id>");
        const p = graph.path(a, b);
        out(p ? p.map(edgeLine).join("\n") : "(no path)", p ?? null);
        return;
      }
      case "routines": {
        const nodes = graph.routines(args.owner);
        out(nodes.length ? nodes.map(nodeLine).join("\n") : "(none)", nodes);
        return;
      }
      case "labels": {
        if (!a) throw new Error("labels needs a routine id");
        const nodes = graph.labels(a);
        out(nodes.length ? nodes.map(nodeLine).join("\n") : "(none)", nodes);
        return;
      }
      case "uses-kernal": {
        if (!a) throw new Error("uses-kernal needs a ROM name or address (CHROUT, $FFD2)");
        const targets = graph.find(a).filter((n) => n.platform && n.space === "rom");
        const hits = targets.flatMap((t) => graph.callers(t.id));
        out(hits.length ? hits.map(edgeLine).join("\n") : `(no callers of ${targets.map((t) => t.id).join(", ") || a})`, hits);
        return;
      }
      default:
        throw new Error(`unknown verb "${args.verb}"\n${USAGE}`);
    }
  } finally {
    graph.close();
  }
}
