// Spec 818 D8 / 819 D8 — `c64re graph <verb>`, the CLI over the query API.
// Human output is a table; `--json` is ONE document on stdout and nothing else.
// MCP tools over the same library are Spec 823.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { seedControlFlow } from "./producers/control-flow.js";
import { seedMemoryAccess } from "./producers/memory-access.js";
import { resolveAddresses } from "./producers/resolve.js";
import { boundaries, boundaryEntries, formatBoundaries } from "./query-boundaries.js";
import { importRuntimeTrace, removeRuntimeRun } from "./producers/runtime.js";
import { irqHandlers, pointerTargets, runs as listRuns, runtimeObservations, unconfirmed, unexplained } from "./query-runtime.js";
import { importAnnotationFile, migrateProject } from "./migrate/migrate.js";
import { exportGraphRecords } from "./export.js";
import { assignSubsystem, linkNodes, nameNode } from "./migrate/human.js";
import { annotations as nodeAnnotations, searchAnnotations, subsystem as subsystemView, subsystems as listSubsystems } from "./query-human.js";
import { edgesWalk, nodeCard, overview, resolveRef, shortestPath, type EdgeKind, type Focus } from "./cards.js";
import { formatEdges, formatFind, formatNode, formatOverview, formatPath } from "./format.js";
import { Graph, type EdgeHit, type ResolvedNode } from "./query.js";
import { GraphStore } from "./store.js";

const USAGE = `Usage: c64re graph <verb> [args] [--project <dir>] [--json]

  find <$addr|id|name>          nodes at an address, one id, or a name substring
  node <ref>                    the card for one node (823)
  edges <ref> [--in|--out|--both] [--kind K] [--origin O] [--depth 1|2]   the neighbourhood walk (823)
  overview [--focus F]          the project's structural map (823)
  callers <id>                  CALLS / CALLS_ROM into a node
  callees <id>                  CALLS / CALLS_ROM out of a node
  readers <$addr>               READS into the node(s) at an address
  writers <$addr>               WRITES into the node(s) at an address
  references <$addr>            every edge into and out of the node(s) at an address
  path <from-id> <to-id>        shortest control-flow path
  routines [--owner <stem>]     routine nodes
  labels <routine-id>           labels a routine CONTAINS
  uses-kernal <name|$addr>      callers of a platform ROM node (CHROUT, $FFD2)
  seed [--owner <stem>]         run the producers (819 control flow, 820 memory access, 826.0 resolve) over every _analysis.json (or one)
  resolve                       826.0 T2: the project-wide RESOLVES_TO pass (addr aliases → the one routine/label/data block at that address)
  boundaries [--entries]        826.0 T3/T4: where a human drew a routine boundary 819 did not (splits, unseen, data outside code); --entries prints the unseen starts for analyze_prg
  zp-usage <routine-id>         ZP addresses a routine touches, by role
  uses-hardware <$addr|name>    routines touching a register, READS/WRITES split
  indirect <routine-id|$zp>     the *_INDIRECT edges — the unknowns, as unknowns
  import-trace <file.c64retrace> [--owner <stem>]   821: import a trace run (origin=runtime rows)
  remove-run <run-id>           821: drop one run's rows
  runs                          821: imported runs
  observations <id|$addr>       821: runtime rows for a node or address
  pointer-targets <$zp>         821: what a zero-page pointer actually pointed at
  unconfirmed <routine-id>      821: static access edges no run observed
  unexplained                   821: runtime rows with no static edge
  irq-handlers                  821: HANDLES_IRQ / HANDLES_NMI from the runs
  migrate [--dry-run]           822: migrate knowledge/*.json into the graph (idempotent, incremental)
  export [--out <dir>]          822.2: write the graph back into the legacy record shapes (knowledge/export/*.json) for humans and git diff
  annotations-import <file> [--force]   822.2: the annotation-file door — import <stem>_annotations.json into the human layer
  annotations <id>              822: annotations + claims on a node
  search <text>                 822: full-text search over annotations
  subsystems | subsystem <name> 822: the subsystem layer
  name <id> <name>              822: the human door — name a node (human row, never touched by re-analysis)
  link <from> <TYPE> <to>       822: a human edge
  assign-subsystem <name> <id…> 822: put nodes into a subsystem
  dump                          canonical dump of the generated layer (818 D6)
  stats                         row counts and meta`;

interface Args { verb: string; positional: string[]; project: string; json: boolean; owner?: string; direction?: "in" | "out" | "both"; kind?: string; origin?: string; depth?: 1 | 2; focus?: string; limit?: number; out?: string; force?: boolean }

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let project = process.env.C64RE_PROJECT_DIR ?? process.cwd();
  let json = false;
  let owner: string | undefined;
  const extra: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--project") project = argv[++i] ?? project;
    else if (a === "--owner") owner = argv[++i];
    else if (a === "--in" || a === "--out" || a === "--both") extra.direction = a.slice(2) as Args["direction"];
    else if (a === "--kind") extra.kind = argv[++i];
    else if (a === "--origin") extra.origin = argv[++i];
    else if (a === "--depth") extra.depth = Number(argv[++i]) === 2 ? 2 : 1;
    else if (a === "--focus") extra.focus = argv[++i];
    else if (a === "--limit") extra.limit = Number(argv[++i]);
    else if (a === "--out") extra.out = argv[++i];
    else if (a === "--force") extra.force = true;
    else positional.push(a);
  }
  const [verb = "help", ...rest] = positional;
  return { verb, positional: rest, project: resolve(project), json, owner, ...extra };
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
    const results = files.map((analysisPath) => {
      const cf = seedControlFlow({ projectDir: args.project, analysisPath });
      const ma = seedMemoryAccess({ projectDir: args.project, analysisPath });
      return { owner: cf.owner, controlFlow: cf, memoryAccess: ma };
    });
    // 826.0 T2 — one project-wide pass after every owner is in
    const resolved = resolveAddresses(args.project);
    out(`${results.map((r) => `${r.owner.padEnd(40)} 819: routines=${r.controlFlow.routines} labels=${r.controlFlow.labels} edges=${JSON.stringify(r.controlFlow.edges)} ${r.controlFlow.ms.toFixed(0)}ms | 820: edges=${JSON.stringify(r.memoryAccess.edges)} indirect-resolved=${r.memoryAccess.indirectResolved} ${r.memoryAccess.ms.toFixed(0)}ms`).join("\n")}\n826.0 resolve: addr nodes=${resolved.addrNodes} RESOLVES_TO=${resolved.resolved} ambiguous=${resolved.ambiguous} ${resolved.ms.toFixed(0)}ms`, { results, resolve: resolved });
    return;
  }
  if (args.verb === "resolve") {
    const r = resolveAddresses(args.project);
    out(`addr nodes=${r.addrNodes} RESOLVES_TO=${r.resolved} ambiguous=${r.ambiguous} ${r.ms.toFixed(0)}ms`, r);
    return;
  }
  if (args.verb === "boundaries") {
    const g = Graph.open(args.project);
    try {
      if (argv.includes("--entries")) { const e = boundaryEntries(g); out(e.join("\n") || "(none)", e); return; }
      const r = boundaries(g);
      out(formatBoundaries(r), r);
    } finally { g.close(); }
    return;
  }

  if (args.verb === "import-trace") {
    const file = args.positional[0];
    if (!file) throw new Error("import-trace needs a .c64retrace path");
    const r = importRuntimeTrace({ projectDir: args.project, tracePath: resolve(file), owner: args.owner });
    out(JSON.stringify(r), r);
    return;
  }
  if (args.verb === "remove-run") {
    const id = args.positional[0];
    if (!id) throw new Error("remove-run needs a run id");
    const r = removeRuntimeRun(args.project, id);
    out(JSON.stringify(r), r);
    return;
  }

  if (args.verb === "migrate") {
    const r = migrateProject({ projectDir: args.project, dryRun: argv.includes("--dry-run") });
    out(JSON.stringify(r, null, 1), r);
    return;
  }
  if (args.verb === "export") {
    const r = exportGraphRecords(args.project, args.out ? resolve(args.out) : undefined);
    out(r.files.map((f) => `${f.path}  ${f.records} records`).join("\n"), r);
    return;
  }
  if (args.verb === "annotations-import") {
    const file = args.positional[0];
    if (!file) throw new Error("annotations-import needs a <stem>_annotations.json path");
    const r = importAnnotationFile(resolve(file), { projectDir: args.project, force: args.force });
    out(`${r.path}: ${r.routines} routines, ${r.labels} labels, ${r.segments} segments${r.dropped ? `, ${r.dropped} dropped` : ""} (${r.changed ? "imported" : "unchanged since the last import"}; owner ${r.owner}, run ${r.runId}, ${r.ms.toFixed(0)} ms)`, r);
    return;
  }
  if (args.verb === "name") {
    const [id, ...rest] = args.positional;
    if (!id || rest.length === 0) throw new Error("name needs <id> <name>");
    const g = Graph.open(args.project);
    const kind = g.resolve(id).kind; g.close();
    const r = nameNode(args.project, { id, kind, name: rest.join(" ") });
    out(JSON.stringify(r), r);
    return;
  }
  if (args.verb === "link") {
    const [from, type, to] = args.positional;
    if (!from || !type || !to) throw new Error("link needs <from> <TYPE> <to>");
    const r = linkNodes(args.project, { from, type, to });
    out(String(r), { linked: r });
    return;
  }
  if (args.verb === "assign-subsystem") {
    const [name, ...members] = args.positional;
    if (!name || members.length === 0) throw new Error("assign-subsystem needs <name> <id…>");
    const r = assignSubsystem(args.project, { name, members });
    out(JSON.stringify(r), r);
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
        const f = formatFind(a, resolveRef(graph, a), args.limit ?? 10);
        out(f.text, f.json);
        return;
      }
      case "node": {
        if (!a) throw new Error("node needs a ref");
        const nodes = resolveRef(graph, a);
        if (nodes.length !== 1) { const f = formatFind(a, nodes, 10); out(nodes.length ? `"${a}" is ambiguous — pick an id:\n${f.text}` : f.text, f.json); return; }
        const f = formatNode(nodeCard(graph, nodes[0]!));
        out(f.text, f.json);
        return;
      }
      case "edges": {
        if (!a) throw new Error("edges needs a ref");
        const roots = resolveRef(graph, a);
        const f = formatEdges(edgesWalk(graph, roots, { direction: args.direction, kind: args.kind as EdgeKind | undefined, origin: args.origin as never, depth: args.depth, limit: args.limit }));
        out(f.text, f.json);
        return;
      }
      case "overview": {
        const f = formatOverview(overview(graph, (args.focus ?? "all") as Focus, args.limit ?? 10));
        out(f.text, f.json);
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
        if (!a || !b) throw new Error("path needs <from> <to>");
        const from = resolveRef(graph, a)[0];
        const to = resolveRef(graph, b)[0];
        if (!from || !to) throw new Error(`cannot resolve ${!from ? a : b}`);
        const f = formatPath(shortestPath(graph, from.id, to.id));
        out(f.text, f.json);
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
      case "zp-usage": {
        if (!a) throw new Error("zp-usage needs a routine id");
        const rows = graph.zpUsage(a);
        out(rows.length ? rows.map((r) => `$${r.address.toString(16).toUpperCase().padStart(4, "0")}  ${r.role.padEnd(12)} ×${r.count}  ${r.id}`).join("\n") : "(none)", rows);
        return;
      }
      case "uses-hardware": {
        if (!a) throw new Error("uses-hardware needs an address or register name");
        const spec = /^(?:\$|0x)?[0-9a-f]{1,4}$/iu.test(a) ? a : (graph.find(a).find((n) => n.platform)?.address ?? a);
        const rows = graph.usesHardware(spec);
        out(rows.length ? rows.map((r) => `${r.routine.padEnd(52)} reads=${r.reads} writes=${r.writes} [${[...r.provenance].join(",")}]`).join("\n") : "(none)", rows.map((r) => ({ ...r, provenance: [...r.provenance] })));
        return;
      }
      case "indirect": {
        if (!a) throw new Error("indirect needs a routine id or a ZP address");
        const hits = graph.indirectAccesses(a);
        out(hits.length ? hits.map(edgeLine).join("\n") : "(none)", hits);
        return;
      }
      case "annotations": { if (!a) throw new Error("annotations needs an id"); const r = nodeAnnotations(graph, a); out(JSON.stringify(r, null, 1), r); return; }
      case "search": { if (!a) throw new Error("search needs text"); const r = searchAnnotations(graph, a); out(JSON.stringify(r, null, 1), r); return; }
      case "subsystems": { const r = listSubsystems(graph); out(r.map(nodeLine).join("\n") || "(none)", r); return; }
      case "subsystem": { if (!a) throw new Error("subsystem needs a name"); const r = subsystemView(graph, a); out(JSON.stringify(r ?? null, null, 1), r ?? null); return; }
      case "runs": { const r = listRuns(graph); out(JSON.stringify(r, null, 1), r); return; }
      case "observations": { if (!a) throw new Error("observations needs an id or address"); const r = runtimeObservations(graph, a); out(JSON.stringify(r, null, 1), r); return; }
      case "pointer-targets": { if (!a) throw new Error("pointer-targets needs a ZP address"); const r = pointerTargets(graph, a); out(JSON.stringify(r, null, 1), r); return; }
      case "unconfirmed": { if (!a) throw new Error("unconfirmed needs a routine id"); const r = unconfirmed(graph, a); out(JSON.stringify(r, null, 1), r); return; }
      case "unexplained": { const r = unexplained(graph); out(JSON.stringify(r, null, 1), r); return; }
      case "irq-handlers": { const r = irqHandlers(graph); out(JSON.stringify(r, null, 1), r); return; }
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
