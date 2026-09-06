// Spec 821 §5 — the runtime queries, standalone functions over a `Graph`.
//
// Every row here has origin=runtime: it says what ONE run did, never what the
// code is. `unconfirmed` therefore says "not seen" and counts the runs that
// executed the routine, so the reader can tell "no run got there" from "runs got
// there and this instruction did not fire" (785 §2.1, 821 OQ4). `pointerTargets`
// collapses the D2 rows into contiguous spans so 115 000 `($12),y` writes read as
// one line. Nothing in this module writes.

import { RUNTIME_PRODUCER } from "./producers/runtime.js";
import type { EdgeHit, Graph, ResolvedNode } from "./query.js";
import type { EdgeRow, NodeRow } from "./schema.js";

export interface RunInfo {
  id: string;
  runId: string;
  name: string | null;
  attrs: Record<string, unknown>;
  edges: number;
}

export interface RuntimeObservation {
  runId: string;
  type: string;
  from: string;
  to: string;
  fromNode: ResolvedNode;
  toNode: ResolvedNode;
  pc: number | null;
  ea: number | null;
  spanEnd: number | null;
  count: number;
  mutations: number;
  flow: string | null;
  bankCtx: string | null;
  bankCtxConf: string | null;
  values: number[];
  viaZp: number | null;
  role: string | null;
  note: string | null;
  firstCycle: number | null;
  lastCycle: number | null;
  evidence: Record<string, unknown>;
}

export interface PointerSpan {
  start: number;
  end: number;
  /** accesses summed over the span */
  count: number;
  /** distinct addresses hit */
  distinct: number;
  reads: number;
  writes: number;
  pcs: number[];
}

export interface PointerTargets {
  runId: string;
  zp: number;
  rows: number;
  spans: PointerSpan[];
}

export interface Unconfirmed {
  routine: string;
  /** imported runs in the graph */
  runs: number;
  /** runs whose EXECUTES edge names this routine */
  executedIn: string[];
  /** static access edges out of the routine with no runtime row at their pc, in any run */
  notSeen: EdgeHit[];
  /** static access edges with at least one runtime row at their pc */
  confirmed: EdgeHit[];
}

function toHit(graph: Graph, row: EdgeRow): EdgeHit {
  return {
    from: row.from_id, type: row.type, to: row.to_id, evidenceKey: row.evidence_key, origin: row.origin, confidence: row.confidence,
    layer: row.layer, owner: row.owner, evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    fromNode: graph.resolve(row.from_id), toNode: graph.resolve(row.to_id),
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function observation(hit: EdgeHit): RuntimeObservation {
  const ev = hit.evidence;
  return {
    runId: str(ev.run_id) ?? hit.owner ?? "", type: hit.type, from: hit.from, to: hit.to, fromNode: hit.fromNode, toNode: hit.toNode,
    pc: num(ev.pc), ea: num(ev.ea), spanEnd: num(ev.span_end), count: num(ev.count) ?? 0, mutations: num(ev.mutations) ?? 0,
    flow: str(ev.flow), bankCtx: str(ev.bank_ctx), bankCtxConf: str(ev.bank_ctx_conf), values: Array.isArray(ev.values) ? (ev.values as number[]) : [],
    viaZp: num(ev.via_zp), role: str(ev.role), note: str(ev.note), firstCycle: num(ev.first_cycle), lastCycle: num(ev.last_cycle), evidence: ev,
  };
}

function parseZp(zp: number | string): number {
  if (typeof zp === "number") return zp & 0xff;
  const m = zp.trim().match(/^(?:\$|0x)?([0-9a-f]{1,4})$/iu);
  if (!m) throw new Error(`"${zp}" is not a zero-page address ($20, 20, 0x20)`);
  return parseInt(m[1]!, 16) & 0xff;
}

// ------------------------------------------------------------------ runs

/** The imported runs (821 D6 run nodes), newest first by cycle_start then id. */
export function runs(graph: Graph): RunInfo[] {
  const rows = graph.store.db.prepare("SELECT * FROM nodes WHERE kind = 'run' AND producer = ? ORDER BY id").all(RUNTIME_PRODUCER) as unknown as NodeRow[];
  const countStmt = graph.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE producer = ? AND owner = ?");
  return rows.map((r) => {
    const attrs = JSON.parse(r.attrs) as Record<string, unknown>;
    const runId = str(attrs.run_id) ?? r.name ?? r.id;
    const n = Number((countStmt.get(RUNTIME_PRODUCER, runId) as { n: number }).n);
    return { id: r.id, runId, name: r.name, attrs, edges: n };
  });
}

// ------------------------------------------------------------------ observations

/**
 * Every runtime edge touching a node — a routine id, a platform id, or an address
 * (`"$D018"`, `0xd018`) — grouped by run. Into AND out of: a routine's
 * observations are the accesses it made; an address's are the accesses made to it.
 */
export function runtimeObservations(graph: Graph, ref: string | number, options: { run?: string } = {}): { nodes: string[]; byRun: Record<string, RuntimeObservation[]> } {
  const nodes = typeof ref === "number" ? graph.nodesAt(ref) : graph.find(ref);
  const byRun: Record<string, RuntimeObservation[]> = {};
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const e of [...graph.edgesInto(n.id), ...graph.edgesOutOf(n.id)]) {
      if (e.origin !== "runtime") continue;
      const key = `${e.from}|${e.type}|${e.to}|${e.evidenceKey}|${e.layer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const o = observation(e);
      if (options.run && o.runId !== options.run) continue;
      (byRun[o.runId] ??= []).push(o);
    }
  }
  for (const list of Object.values(byRun)) list.sort((a, b) => (a.pc ?? 0) - (b.pc ?? 0) || (a.ea ?? 0) - (b.ea ?? 0) || a.type.localeCompare(b.type));
  return { nodes: nodes.map((n) => n.id), byRun };
}

/** Runtime edges whose `note` is set — opcode mismatch, no static edge, collapsed: back to the code. */
export function unexplained(graph: Graph, runId?: string): RuntimeObservation[] {
  const rows = graph.store.db.prepare(
    "SELECT * FROM edges WHERE producer = ? AND json_extract(evidence, '$.note') IS NOT NULL AND (? IS NULL OR owner = ?) ORDER BY owner, from_id, type, to_id, evidence_key",
  ).all(RUNTIME_PRODUCER, runId ?? null, runId ?? null) as unknown as EdgeRow[];
  return rows.map((r) => observation(toHit(graph, r)));
}

/** D7 — the interrupt handlers each run entered, with entry counts. */
export function irqHandlers(graph: Graph, options: { run?: string } = {}): EdgeHit[] {
  const rows = graph.store.db.prepare(
    "SELECT * FROM edges WHERE producer = ? AND type IN ('HANDLES_IRQ','HANDLES_NMI') AND (? IS NULL OR owner = ?) ORDER BY owner, type, to_id",
  ).all(RUNTIME_PRODUCER, options.run ?? null, options.run ?? null) as unknown as EdgeRow[];
  return rows.map((r) => toHit(graph, r));
}

/** The runs that retired instructions inside a routine (EXECUTES), with step counts. */
export function executions(graph: Graph, routineId: string): EdgeHit[] {
  return graph.edgesInto(routineId, ["EXECUTES"]).filter((e) => e.origin === "runtime");
}

// ------------------------------------------------------------------ observed arguments (826 D6)

export interface ObservedArgs {
  /** the jsr site, `$1002` */
  site: string;
  run: string;
  from: string;
  to: string;
  /** retires of this jsr in the run */
  count: number;
  /** register → value → count, `{ A: { "$01": 2 }, C: { "0": 2 } }`; a capped register carries `"…": rest` */
  args: Record<string, Record<string, number>>;
}

/** A callee ref: an id, an address (`"$1100"`, `0x1100`) or a name — the nodes it names. */
function calleeNodes(graph: Graph, ref: string | number): ResolvedNode[] {
  if (typeof ref === "number") return graph.nodesAt(ref);
  const text = ref.trim();
  if (text.includes(":")) {
    const n = graph.resolve(text);
    return n.dangling ? [] : [n];
  }
  return graph.find(text);
}

const hex4u = (n: number) => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * 826 D6 — what the runs actually passed: the runtime CALLS rows INTO the callee,
 * one per (jsr site, run), each with the register values the retiring jsr carried.
 * Runtime rows only; a static PASSES edge is the other half (the card joins them).
 */
export function observedArgs(graph: Graph, calleeRef: string | number, options: { run?: string } = {}): ObservedArgs[] {
  const out: ObservedArgs[] = [];
  const seen = new Set<string>();
  for (const n of calleeNodes(graph, calleeRef)) {
    for (const e of graph.edgesInto(n.id, ["CALLS"])) {
      if (e.origin !== "runtime") continue;
      const key = `${e.from}|${e.evidenceKey}|${e.owner ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const run = str(e.evidence.run_id) ?? e.owner ?? "";
      if (options.run && run !== options.run) continue;
      const raw = e.evidence.args_observed;
      const args: Record<string, Record<string, number>> = {};
      if (raw && typeof raw === "object") {
        for (const [reg, vals] of Object.entries(raw as Record<string, unknown>)) {
          if (!vals || typeof vals !== "object") continue;
          const rec: Record<string, number> = {};
          for (const [v, c] of Object.entries(vals as Record<string, unknown>)) if (typeof c === "number") rec[v] = c;
          args[reg] = rec;
        }
      }
      const pc = num(e.evidence.pc);
      out.push({ site: pc === null ? e.evidenceKey : hex4u(pc), run, from: e.from, to: e.to, count: num(e.evidence.count) ?? 0, args });
    }
  }
  return out.sort((a, b) => a.run.localeCompare(b.run) || a.site.localeCompare(b.site));
}

/** All sites and runs merged: register → value → count. Empty registers are dropped. */
export function observedDomain(graph: Graph, calleeRef: string | number, options: { run?: string } = {}): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const site of observedArgs(graph, calleeRef, options)) {
    for (const [reg, vals] of Object.entries(site.args)) {
      const rec = out[reg] ?? {};
      for (const [v, c] of Object.entries(vals)) rec[v] = (rec[v] ?? 0) + c;
      if (Object.keys(rec).length) out[reg] = rec;
    }
  }
  return out;
}

// ------------------------------------------------------------------ pointer targets

/**
 * "What did `$20/$21` actually point at" — the runtime READS/WRITES made THROUGH
 * the pointer pair at `zp` (`via_zp` on the row: the `(zp),y` / `(zp,x)` base the
 * retiring instruction named), per run, distinct effective addresses collapsed
 * into contiguous spans. Collapsed rows (OQ1) contribute their whole span.
 */
export function pointerTargets(graph: Graph, zp: number | string, options: { run?: string } = {}): PointerTargets[] {
  const base = parseZp(zp);
  const rows = graph.store.db.prepare(
    "SELECT * FROM edges WHERE producer = ? AND type IN ('READS','WRITES') AND json_extract(evidence, '$.via_zp') = ? AND (? IS NULL OR owner = ?) ORDER BY owner, from_id, type, to_id, evidence_key",
  ).all(RUNTIME_PRODUCER, base, options.run ?? null, options.run ?? null) as unknown as EdgeRow[];
  const perRun = new Map<string, { rows: number; hits: Map<number, { reads: number; writes: number; pcs: Set<number> }> }>();
  for (const r of rows) {
    const ev = JSON.parse(r.evidence) as Record<string, unknown>;
    const runId = str(ev.run_id) ?? r.owner ?? "";
    const ea = num(ev.ea);
    if (ea === null) continue;
    const end = num(ev.span_end) ?? ea;
    const count = num(ev.count) ?? 0;
    const pc = num(ev.pc) ?? -1;
    const bucket = perRun.get(runId) ?? { rows: 0, hits: new Map() };
    bucket.rows += 1;
    const width = end - ea + 1;
    for (let a = ea; a <= end; a += 1) {
      const h = bucket.hits.get(a) ?? { reads: 0, writes: 0, pcs: new Set<number>() };
      // a collapsed span carries one count for the whole span; spread it evenly so sums stay exact
      const share = a === end ? count - Math.floor(count / width) * (width - 1) : Math.floor(count / width);
      if (r.type === "WRITES") h.writes += share; else h.reads += share;
      if (pc >= 0) h.pcs.add(pc);
      bucket.hits.set(a, h);
    }
    perRun.set(runId, bucket);
  }
  const out: PointerTargets[] = [];
  for (const [runId, bucket] of [...perRun.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const addrs = [...bucket.hits.keys()].sort((a, b) => a - b);
    const spans: PointerSpan[] = [];
    let cur: PointerSpan | undefined;
    for (const a of addrs) {
      const h = bucket.hits.get(a)!;
      if (cur && a === cur.end + 1) {
        cur.end = a;
        cur.count += h.reads + h.writes;
        cur.distinct += 1;
        cur.reads += h.reads;
        cur.writes += h.writes;
        for (const pc of h.pcs) if (!cur.pcs.includes(pc)) cur.pcs.push(pc);
      } else {
        cur = { start: a, end: a, count: h.reads + h.writes, distinct: 1, reads: h.reads, writes: h.writes, pcs: [...h.pcs] };
        spans.push(cur);
      }
    }
    for (const s of spans) s.pcs.sort((x, y) => x - y);
    out.push({ runId, zp: base, rows: bucket.rows, spans });
  }
  return out;
}

// ------------------------------------------------------------------ unconfirmed

/**
 * Static access edges out of a routine that no imported run has a runtime row for
 * — "not seen", never "unused" (785 §2.1). `executedIn` lists the runs that
 * retired instructions in the routine, so an empty list means no run got there.
 */
export function unconfirmed(graph: Graph, routineId: string): Unconfirmed {
  const staticTypes = new Set(["READS", "WRITES", "READS_INDIRECT", "WRITES_INDIRECT", "USES_ZP", "USES_HARDWARE", "REFERENCES_DATA"]);
  const staticEdges = graph.edgesOutOf(routineId).filter((e) => e.origin === "static" && staticTypes.has(e.type));
  const runtimePcs = new Set<number>();
  for (const e of graph.edgesOutOf(routineId)) {
    if (e.origin !== "runtime") continue;
    const pc = num(e.evidence.pc);
    if (pc !== null) runtimePcs.add(pc);
  }
  const pcOf = (e: EdgeHit): number | null => num(e.evidence.pc) ?? num(e.evidence.source_address);
  const notSeen = staticEdges.filter((e) => { const pc = pcOf(e); return pc === null || !runtimePcs.has(pc); });
  const confirmed = staticEdges.filter((e) => { const pc = pcOf(e); return pc !== null && runtimePcs.has(pc); });
  const executedIn = executions(graph, routineId).map((e) => str(e.evidence.run_id) ?? e.owner ?? "").filter(Boolean).sort();
  return { routine: routineId, runs: runs(graph).length, executedIn, notSeen, confirmed };
}
