// Spec 861 D1 — what a change can break.
//
// A walk over the edges the graph already has, ordered by DEPTH and with
// UNKNOWN as a class of its own. The order is the point: depth 1 will break,
// depth 2 is likely affected, depth 3 may need testing, and UNKNOWN is never
// folded into "low" — an indirect jump, a computed return, a write into the
// code, the other CPU and every address the graph could not resolve are listed
// as what they are, because "the walk found nothing" and "there is nothing" are
// different answers.
//
// What it walks:
//   who reaches it          CALLS · JUMPS_TO · BRANCHES_TO, upstream by depth
//   who depends on it       WRITES from the range, then READS of those addresses
//   what points into it     REFERENCES_DATA — the jump and pointer tables a call
//                           graph never shows
//   what describes it       the container, the documents whose `covers` overlap,
//                           the findings on the range: claims that may be false
//                           after the change, listed as such
//   what actually ran       an edge with origin = runtime is marked "seen in a
//                           trace", against "reachable on paper"

import { readFileSync } from "node:fs";
import { resolveRef } from "../knowledge-graph/cards.js";
import { nodeCard } from "../knowledge-graph/cards.js";
import type { EdgeHit, Graph, ResolvedNode } from "../knowledge-graph/query.js";
import { KnowledgeRecords } from "../knowledge-graph/records.js";
import { buildCfg } from "./cfg.js";
import { ALL_LOCS, formatLocs, liveness, type LocSet } from "./liveness.js";
import type { Loc } from "../knowledge-graph/isa-6502.js";

const CONTROL = ["CALLS", "CALLS_ROM", "JUMPS_TO", "BRANCHES_TO"] as const;

export interface ImpactItem {
  depth: 1 | 2 | 3;
  id: string;
  label: string;
  /** the edge that put it here */
  via: string;
  /** "on paper" or "seen in a trace" */
  seen: "static" | "runtime";
  evidence: string;
}

export interface UnknownItem {
  what: string;
  why: string;
  where: string;
}

export interface StaleClaim {
  kind: "document" | "finding" | "container";
  id: string;
  title: string;
  why: string;
}

export interface ImpactRange { start: number; end: number }

export interface TimingImpact {
  /** the lines the routine was measured to run in */
  lines: string;
  /** the cycles it occupies on its busiest line, and what is left of that line */
  worstLine: string;
  /** set when the candidate adds cycles inside raster-timed code */
  warning: string | null;
}

export interface ImpactReport {
  ref: string;
  roots: ResolvedNode[];
  range: ImpactRange | null;
  items: ImpactItem[];
  unknown: UnknownItem[];
  claims: StaleClaim[];
  preserve: { locs: LocSet; how: string } | null;
  timing: TimingImpact | null;
  notes: string[];
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
/** A node's printable name: what it is called, else where it is. An ownerless
 *  `addr` node — a pointer cell, a byte nobody has named — has no name at all,
 *  and its id is not what a reader needs to see first. */
const nameOf = (n: ResolvedNode): string => n.name ?? (n.address ? hex4(n.address) : n.id);

function rangeOf(nodes: ResolvedNode[]): ImpactRange | null {
  const real = nodes.filter((n) => !n.dangling);
  if (real.length === 0) return null;
  const start = Math.min(...real.map((n) => n.address));
  const end = Math.max(...real.map((n) => n.endAddress ?? n.address));
  return { start, end };
}

const overlaps = (a: ImpactRange, b: ImpactRange): boolean => a.start <= b.end && b.start <= a.end;

export interface ImpactOptions {
  /** the bytes the changed range would become, for the liveness answer and the timing flag */
  candidate?: { address: number; bytes: Uint8Array };
  /** a PRG whose bytes back the containing routine, so §3.3 liveness can be run on it */
  prgPath?: string;
  /** an address range, when the caller named one instead of a node */
  range?: ImpactRange;
  /** a measured cost for the routine (§4), when one exists */
  timing?: TimingImpact;
  maxDepth?: 1 | 2 | 3;
  limitPerDepth?: number;
}

export function changeImpact(graph: Graph, projectDir: string, ref: string, options: ImpactOptions = {}): ImpactReport {
  const notes: string[] = [];
  // Resolved by ID, always: a name lookup matches ONE layer's row (an annotation
  // names the human row, never the generated twin), and that row carries no
  // extent — so a routine found by its name would be a range of one byte.
  let roots = (options.range ? nodesInRange(graph, options.range) : resolveRef(graph, ref))
    .map((n) => (n.platform || n.dangling ? n : graph.resolve(n.id)));
  roots = roots.filter((n) => !n.platform);
  const range = options.range ?? rangeOf(roots);

  const items: ImpactItem[] = [];
  const unknown: UnknownItem[] = [];
  const seenIds = new Set(roots.map((r) => r.id));
  const maxDepth = options.maxDepth ?? 3;

  // ---- what points into it, and what reaches it
  let frontier = roots.map((r) => r.id);
  for (let depth = 1 as 1 | 2 | 3; depth <= maxDepth; depth = (depth + 1) as 1 | 2 | 3) {
    const next: string[] = [];
    for (const id of frontier) {
      const types = depth === 1 ? [...CONTROL, "REFERENCES_DATA"] : [...CONTROL];
      for (const e of graph.edgesInto(id, types)) {
        if (seenIds.has(e.from)) continue;
        seenIds.add(e.from);
        items.push(itemFor(e, depth, e.fromNode));
        next.push(e.from);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // ---- who depends on what it writes: WRITES out of the range, then READS of those cells
  if (maxDepth >= 2) {
    for (const root of roots) {
      for (const w of graph.edgesOutOf(root.id, ["WRITES"])) {
        for (const r of graph.edgesInto(w.to, ["READS"])) {
          if (seenIds.has(r.from) || roots.some((x) => x.id === r.from)) continue;
          seenIds.add(r.from);
          items.push({
            depth: 2,
            id: r.from,
            label: nameOf(r.fromNode),
            via: `reads ${hex4(w.toNode.address)}, which this range writes`,
            seen: r.origin === "runtime" || w.origin === "runtime" ? "runtime" : "static",
            evidence: String(r.evidence.instruction ?? r.evidence.source_address ?? ""),
          });
        }
      }
    }
  }

  // ---- UNKNOWN, as its own class
  for (const node of [...roots, ...items.map((i) => graph.resolve(i.id))]) {
    if (node.dangling) {
      unknown.push({ what: node.id, why: "the graph has no node for this address — it is named by an edge and by nothing else", where: hex4(node.address) });
      continue;
    }
    for (const exit of exitsOf(node)) {
      unknown.push({
        what: exit.detail ?? exit.kind,
        why:
          exit.kind === "jmp-indirect" ? "the destination is a pointer in memory, so no edge carries it — who this reaches is not known here"
            : exit.kind === "computed-return" ? "the return address was pushed, not inherited — this returns somewhere the graph cannot name"
              : "the resume address comes from the stack",
        where: `${nameOf(node)} @${exit.at}`,
      });
    }
    if (node.space === "drv" || node.id.startsWith("c1541:")) {
      unknown.push({ what: nameOf(node), why: "this runs on the drive's own 6502 — a different machine with a different clock", where: hex4(node.address) });
    }
    for (const e of graph.edgesOutOf(node.id, ["READS_INDIRECT", "WRITES_INDIRECT"])) {
      unknown.push({
        what: `${nameOf(node)} → ${e.toNode.name ?? e.to}`,
        why: "the address comes through a pointer; the graph holds the pointer, not the cell",
        where: String(e.evidence.instruction ?? hex4(node.address)),
      });
    }
  }
  // self-modifying code: something writes INTO the range
  if (range) {
    for (const writer of writersInto(graph, range)) {
      if (roots.some((r) => r.id === writer.from)) continue;
      unknown.push({
        what: `${nameOf(writer.fromNode)} writes ${hex4(writer.toNode.address)}`,
        why: "a write lands inside the changed range — the bytes are modified while the program runs, so what is there is not what is on disk",
        where: String(writer.evidence.instruction ?? hex4(writer.fromNode.address)),
      });
    }
  }

  // ---- the claims that may go stale
  const claims = range ? staleClaims(graph, projectDir, range) : [];

  // ---- what the change must preserve
  const preserve = preserveSet(graph, roots, range, options, notes);

  dedupe(unknown);
  items.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ref, roots, range, items, unknown, claims, preserve, timing: options.timing ?? null, notes };
}

function itemFor(e: EdgeHit, depth: 1 | 2 | 3, node: ResolvedNode): ImpactItem {
  const via = e.type === "REFERENCES_DATA" ? "points into it" : `${e.type.toLowerCase().replace("_", " ")} it`;
  const evidence =
    e.type === "REFERENCES_DATA"
      ? `${e.evidence.source ?? "reference"}${e.evidence.operand ? ` → ${e.evidence.operand}` : ""}`
      : String(e.evidence.instruction ?? (e.evidence.source_address !== undefined ? hex4(Number(e.evidence.source_address)) : ""));
  return { depth, id: e.from, label: nameOf(node), via, seen: e.origin === "runtime" ? "runtime" : "static", evidence };
}

function exitsOf(node: ResolvedNode): Array<{ at: string; kind: string; detail?: string }> {
  const raw = node.attrs.unresolved_exits;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is { at: string; kind: string; detail?: string } => !!x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string");
}

function nodesInRange(graph: Graph, range: ImpactRange): ResolvedNode[] {
  const rows = graph.store.db
    .prepare("SELECT DISTINCT id FROM nodes WHERE address BETWEEN ? AND ? AND kind IN ('routine','label','segment','data_block','payload') ORDER BY address, id")
    .all(range.start, range.end) as Array<{ id: string }>;
  return rows.map((r) => graph.resolve(r.id)).filter((n) => !n.dangling);
}

function writersInto(graph: Graph, range: ImpactRange): EdgeHit[] {
  const out: EdgeHit[] = [];
  for (let addr = range.start; addr <= range.end; addr += 1) {
    for (const n of graph.nodesAt(addr)) {
      if (n.platform) continue;
      for (const e of graph.edgesInto(n.id, ["WRITES"])) out.push(e);
    }
  }
  return out;
}

function staleClaims(graph: Graph, projectDir: string, range: ImpactRange): StaleClaim[] {
  const claims: StaleClaim[] = [];

  // the container: what CONTAINS any node of the range
  for (const n of nodesInRange(graph, range)) {
    for (const e of graph.edgesInto(n.id, ["CONTAINS"])) {
      if (claims.some((c) => c.id === e.from)) continue;
      claims.push({ kind: "container", id: e.from, title: e.fromNode.name ?? e.from, why: `contains ${nameOf(n)}` });
    }
  }

  // documents (847): a `covers` range that overlaps
  try {
    // listDocNodes is async only because it imports the store lazily; the rows
    // themselves are in this graph, so read them from it directly.
    const rows = graph.store.db.prepare("SELECT id, name, attrs FROM nodes WHERE kind = 'document' ORDER BY id").all() as Array<{ id: string; name: string | null; attrs: string }>;
    for (const row of rows) {
      let attrs: Record<string, unknown> = {};
      try { attrs = JSON.parse(row.attrs) as Record<string, unknown>; } catch { /* a document with no attrs covers nothing */ }
      const covers = Array.isArray(attrs.covers) ? (attrs.covers as Array<{ kind?: string; start?: number; end?: number }>) : [];
      for (const c of covers) {
        if (c.kind !== "range" || typeof c.start !== "number" || typeof c.end !== "number") continue;
        if (!overlaps(range, { start: c.start, end: c.end })) continue;
        claims.push({
          kind: "document", id: row.id, title: row.name ?? row.id,
          why: `covers ${hex4(c.start)}-${hex4(c.end)} — it describes what this range does, and may be wrong afterwards`,
        });
        break;
      }
    }
  } catch { /* a graph without the document nodes has no claims to stale */ }

  // findings with an overlapping address range
  try {
    for (const f of new KnowledgeRecords(projectDir).listFindings()) {
      const r = f.addressRange ?? f.evidence?.[0]?.addressRange;
      if (!r || typeof r.start !== "number") continue;
      const fr = { start: r.start, end: typeof r.end === "number" ? r.end : r.start };
      if (!overlaps(range, fr)) continue;
      claims.push({
        kind: "finding", id: f.id, title: f.title,
        why: `states something about ${hex4(fr.start)}-${hex4(fr.end)}${f.status ? ` (${f.status})` : ""}`,
      });
    }
  } catch { /* no project records */ }

  return claims;
}

/**
 * §2 — the registers and flags the change must preserve.
 *
 * With the bytes of the containing routine, this is §3.3's liveness read at the
 * changed range's exit. Without them it is the routine's computed signature
 * (826), which says what the routine hands back; and where there is neither, it
 * says so rather than answering "nothing".
 */
function preserveSet(
  graph: Graph,
  roots: ResolvedNode[],
  range: ImpactRange | null,
  options: ImpactOptions,
  notes: string[],
): { locs: LocSet; how: string } | null {
  if (!range) return null;
  const routine = roots.find((r) => r.kind === "routine") ?? roots[0];

  // The two answers compose, they do not compete.
  //
  // §3.3 is conservative where the graph ends, and a routine ends in an `rts`,
  // so liveness taken on its own says "everything is live" at every point inside
  // a routine — true, and useless. What the caller actually expects is 826's
  // computed signature, so THAT is the live-out the walk starts from, and
  // liveness carries it backwards to the end of the changed range. Without a
  // signature the conservative answer stands, and says so.
  const signature = signatureAnswer(graph, routine);
  if (options.prgPath) {
    try {
      const raw = readFileSync(options.prgPath);
      const load = raw[0]! | (raw[1]! << 8);
      const bytes = new Uint8Array(raw.subarray(2));
      const from = routine && !routine.dangling ? routine.address : range.start;
      const to = routine?.endAddress ?? range.end;
      const off = from - load;
      if (off >= 0 && off < bytes.length) {
        const slice = bytes.subarray(off, Math.min(bytes.length, to - load + 1));
        const cfg = buildCfg(slice, from);
        const live = liveness(cfg, signature?.locs);
        const last = [...cfg.insns].reverse().find((i) => i.address <= range.end);
        const at = last ? live.after.get(last.address) : undefined;
        if (at) {
          return {
            locs: at,
            how:
              `read backwards from ${hex4(range.end)} through ${routine ? nameOf(routine) : hex4(from)} (§3.3), ` +
              (signature
                ? `starting from what its caller expects at the return — ${signature.how}`
                : `and conservative at the return, because no signature says what the caller expects`),
          };
        }
      }
      notes.push(`the PRG at ${options.prgPath} does not cover ${hex4(range.start)}, so liveness fell back to the signature`);
    } catch (e) {
      notes.push(`the PRG could not be read for the liveness answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return signature;
}

/** 826's computed interface: what the routine hands back and what it promises to keep. */
function signatureAnswer(graph: Graph, routine: ResolvedNode | undefined): { locs: LocSet; how: string } | null {
  if (!routine || routine.dangling || routine.platform) return null;
  const sig = nodeCard(graph, routine).signature;
  if (!sig || (!sig.out.length && !sig.preserves.length)) return null;
  // 826 names memory cells in the same list as registers (`zp:$02`, `mem:$D020`);
  // only the nine bits of CPU state are locations liveness knows about.
  const locs = new Set(
    [...sig.out, ...sig.preserves]
      .map((s) => s.toUpperCase())
      .filter((s): s is Loc => (ALL_LOCS as readonly string[]).includes(s)),
  ) as LocSet;
  return {
    locs,
    how: `the routine's computed signature: it hands back ${sig.out.join(" ") || "nothing"} and preserves ${sig.preserves.join(" ") || "nothing"} (826)`,
  };
}

function dedupe(list: UnknownItem[]): void {
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const k = `${list[i]!.what}|${list[i]!.where}`;
    if (seen.has(k)) list.splice(i, 1);
    else seen.add(k);
  }
}

// ------------------------------------------------------------------- text

const DEPTH_TITLE: Record<1 | 2 | 3, string> = {
  1: "depth 1 — will break",
  2: "depth 2 — likely affected",
  3: "depth 3 — may need testing",
};

export function formatImpact(report: ImpactReport): string {
  const lines: string[] = [];
  const where = report.range ? `${hex4(report.range.start)}-${hex4(report.range.end)}` : "an address the graph does not know";
  lines.push(`change_impact: ${report.ref} → ${where}`);
  if (report.roots.length === 0) {
    // Not a return: a measurement (§4) and the documents and findings over a
    // range do not come from the graph, and dropping them because the graph has
    // no node there would hide the half of the answer that exists.
    lines.push(`  nothing in the graph resolves "${report.ref}", so the walk below has nothing to walk. graph_find is the door that says what the graph does have.`);
  } else {
    lines.push(`  ${report.roots.length} node(s): ${report.roots.map(nameOf).join(", ")}`);
  }
  lines.push("");

  for (const depth of [1, 2, 3] as const) {
    const items = report.items.filter((i) => i.depth === depth);
    lines.push(`${DEPTH_TITLE[depth]} (${items.length})`);
    if (items.length === 0) lines.push("  nothing");
    for (const i of items) {
      lines.push(`  ${i.label.padEnd(24)} ${i.via}${i.seen === "runtime" ? "  [seen in a trace]" : ""}${i.evidence ? `  ${i.evidence}` : ""}`);
    }
    lines.push("");
  }

  lines.push(`UNKNOWN — not low, not none (${report.unknown.length})`);
  if (report.unknown.length === 0) lines.push("  nothing: every edge in this walk resolved");
  for (const u of report.unknown) lines.push(`  ${u.what}\n      ${u.why}\n      at ${u.where}`);
  lines.push("");

  lines.push(`claims that may be false afterwards (${report.claims.length})`);
  if (report.claims.length === 0) lines.push("  nothing describes this range yet");
  for (const c of report.claims) lines.push(`  [${c.kind}] ${c.title} — ${c.why}`);
  lines.push("");

  if (report.preserve) {
    lines.push(`what the change must preserve: ${formatLocs(report.preserve.locs)}`);
    lines.push(`  ${report.preserve.how}`);
  } else {
    lines.push("what the change must preserve: not derived — pass the PRG the range lives in, or run the routine's signature (826), and this becomes an answer instead of a guess");
  }

  if (report.timing) {
    lines.push("");
    lines.push(`timing is a direction of impact too:`);
    lines.push(`  ${report.timing.lines}`);
    lines.push(`  ${report.timing.worstLine}`);
    if (report.timing.warning) lines.push(`  WARNING: ${report.timing.warning}`);
  }
  for (const n of report.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}
