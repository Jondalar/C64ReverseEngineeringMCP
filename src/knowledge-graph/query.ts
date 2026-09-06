// Spec 818 D8 — the query API. Ships with the store and is the acceptance
// instrument of every later slice: 819 fills callers/callees, 820 readers/
// writers, 821 adds origin=runtime rows, 822 the human layer. Nothing replaces
// this module; MCP tools over it are Spec 823.
//
// Two files, joined by a string (D7): a project edge may name a platform node
// (`c64:rom:ffd2`); the reader opens the platform store read-only and resolves
// the string. A platform id the platform file does not know is returned as a
// DANGLING reference, never dropped.

import { PlatformKb } from "../platform-kb/read.js";
import { isPlatformId, parseId, type Ctx } from "./ids.js";
import { CONTROL_FLOW_TYPES, type EdgeRow, type Layer, type NodeRow } from "./schema.js";
import { GraphStore } from "./store.js";

export type AddrSpec = string | number | { address: number; space?: string; owner?: string; bank?: number };

export interface ResolvedNode {
  id: string;
  kind: string;
  name: string | null;
  address: number;
  endAddress: number | null;
  space: string;
  owner: string | null;
  bank: number | null;
  attrs: Record<string, unknown>;
  origin?: string;
  confidence?: string;
  /** which layers exist for this id */
  layers: Layer[];
  /** a human row with no generated twin (818 D5) */
  orphaned: boolean;
  /** lives in the platform store */
  platform: boolean;
  /** named by an edge but present in neither file */
  dangling: boolean;
  symbol?: string | null;
}

export interface EdgeHit {
  from: string;
  type: string;
  to: string;
  evidenceKey: string;
  origin: string;
  confidence: string;
  layer: Layer;
  owner: string | null;
  evidence: Record<string, unknown>;
  fromNode: ResolvedNode;
  toNode: ResolvedNode;
}

export interface PathOptions {
  types?: readonly string[];
  maxDepth?: number;
}

function parseAddr(spec: AddrSpec): { address: number; space?: string; owner?: string; bank?: number } {
  if (typeof spec === "number") return { address: spec & 0xffff };
  if (typeof spec === "object") return { ...spec, address: spec.address & 0xffff };
  const text = spec.trim();
  const m = text.match(/^(?:\$|0x)?([0-9a-f]{1,4})$/iu);
  if (!m) throw new Error(`"${spec}" is not an address ($1DD2, 1dd2, 0x1DD2)`);
  return { address: parseInt(m[1]!, 16) };
}

function dangling(id: string): ResolvedNode {
  let address = 0;
  let kind = "?";
  let space = "?";
  try {
    const p = parseId(id);
    if (p.form !== "subsystem") address = p.address;
    kind = p.form === "subsystem" ? "subsystem" : p.kind;
    space = p.form === "project" ? p.ctx.space : p.form === "platform" ? p.kind : "sub";
  } catch { /* unparseable ids are still reported, as dangling */ }
  return { id, kind, name: null, address, endAddress: null, space, owner: null, bank: null, attrs: {}, layers: [], orphaned: false, platform: isPlatformId(id), dangling: true };
}

function mergeRows(rows: NodeRow[]): ResolvedNode | undefined {
  if (rows.length === 0) return undefined;
  const generated = rows.find((r) => r.layer === "generated");
  const human = rows.find((r) => r.layer === "human");
  const base = generated ?? human!;
  const attrs = { ...(JSON.parse(base.attrs) as Record<string, unknown>), ...(human ? (JSON.parse(human.attrs) as Record<string, unknown>) : {}) };
  return {
    id: base.id,
    kind: base.kind,
    name: human?.name ?? generated?.name ?? null,
    address: base.address,
    endAddress: human?.end_address ?? generated?.end_address ?? null,
    space: base.space,
    owner: base.owner,
    bank: base.bank,
    attrs,
    origin: base.origin,
    confidence: human ? human.confidence : base.confidence,
    layers: rows.map((r) => r.layer).sort() as Layer[],
    orphaned: Boolean(human && !generated),
    platform: false,
    dangling: false,
  };
}

export class Graph {
  private readonly nodesById;
  private readonly nodesAtAddr;
  private readonly edgesTo;
  private readonly edgesFrom;
  private readonly nodesByName;
  private readonly nodesByKind;

  constructor(readonly store: GraphStore, readonly platform: PlatformKb | undefined) {
    const db = store.db;
    this.nodesById = db.prepare("SELECT * FROM nodes WHERE id = ? ORDER BY layer");
    this.nodesAtAddr = db.prepare("SELECT * FROM nodes WHERE address = ? ORDER BY id, layer");
    this.edgesTo = db.prepare("SELECT * FROM edges WHERE to_id = ? ORDER BY from_id, type, evidence_key, layer");
    this.edgesFrom = db.prepare("SELECT * FROM edges WHERE from_id = ? ORDER BY to_id, type, evidence_key, layer");
    this.nodesByName = db.prepare("SELECT * FROM nodes WHERE name LIKE ? ORDER BY id, layer LIMIT 200");
    this.nodesByKind = db.prepare("SELECT * FROM nodes WHERE kind = ? AND (? IS NULL OR owner = ?) ORDER BY id, layer");
  }

  static open(projectDir: string, options: { platformDb?: string; writable?: boolean } = {}): Graph {
    const store = GraphStore.open(projectDir, { readOnly: !options.writable });
    let platform: PlatformKb | undefined;
    try {
      platform = new PlatformKb(options.platformDb);
    } catch {
      platform = undefined; // platform ids will resolve as dangling — visible, not silent
    }
    return new Graph(store, platform);
  }

  close(): void {
    this.store.close();
    this.platform?.close();
  }

  // ------------------------------------------------------------ resolution

  resolve(id: string): ResolvedNode {
    if (isPlatformId(id)) {
      const p = this.platform?.byId(id);
      if (!p) return dangling(id);
      return {
        id: p.id, kind: p.kind, name: p.symbol ? `${p.symbol} ${p.name}` : p.name, symbol: p.symbol, address: p.address, endAddress: null,
        space: p.kind === "io" ? "io" : p.kind === "rom" ? "rom" : "ram", owner: null, bank: null, attrs: { source: p.source },
        origin: "imported", confidence: "certain", layers: ["generated"], orphaned: false, platform: true, dangling: false,
      };
    }
    const rows = this.nodesById.all(id) as unknown as NodeRow[];
    return mergeRows(rows) ?? dangling(id);
  }

  /** Every node at an address, across contexts and both files. The ambiguity is visible. */
  nodesAt(spec: AddrSpec): ResolvedNode[] {
    const a = parseAddr(spec);
    const rows = this.nodesAtAddr.all(a.address) as unknown as NodeRow[];
    const byId = new Map<string, NodeRow[]>();
    for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    let out = [...byId.values()].map((rs) => mergeRows(rs)!);
    if (a.space) out = out.filter((n) => n.space === a.space);
    if (a.owner) out = out.filter((n) => n.owner === a.owner);
    if (a.bank !== undefined) out = out.filter((n) => n.bank === a.bank);
    if (!a.space || a.space === "io" || a.space === "rom" || a.space === "ram") {
      for (const platform of ["c64", "c1541"] as const) {
        const p = this.platform?.node(platform, a.address);
        if (p && (!a.space || this.resolve(p.id).space === a.space)) out.push(this.resolve(p.id));
      }
    }
    return out;
  }

  private hit(row: EdgeRow): EdgeHit {
    return {
      from: row.from_id, type: row.type, to: row.to_id, evidenceKey: row.evidence_key, origin: row.origin, confidence: row.confidence,
      layer: row.layer, owner: row.owner, evidence: JSON.parse(row.evidence) as Record<string, unknown>,
      fromNode: this.resolve(row.from_id), toNode: this.resolve(row.to_id),
    };
  }

  edgesInto(id: string, types?: readonly string[]): EdgeHit[] {
    return (this.edgesTo.all(id) as unknown as EdgeRow[]).filter((e) => !types || types.includes(e.type)).map((e) => this.hit(e));
  }

  edgesOutOf(id: string, types?: readonly string[]): EdgeHit[] {
    return (this.edgesFrom.all(id) as unknown as EdgeRow[]).filter((e) => !types || types.includes(e.type)).map((e) => this.hit(e));
  }

  // ------------------------------------------------------------ 818 D8 verbs

  callers(id: string): EdgeHit[] {
    return this.edgesInto(id, ["CALLS", "CALLS_ROM"]);
  }

  callees(id: string): EdgeHit[] {
    return this.edgesOutOf(id, ["CALLS", "CALLS_ROM"]);
  }

  readers(spec: AddrSpec): EdgeHit[] {
    return this.nodesAt(spec).flatMap((n) => this.edgesInto(n.id, ["READS"]));
  }

  writers(spec: AddrSpec): EdgeHit[] {
    return this.nodesAt(spec).flatMap((n) => this.edgesInto(n.id, ["WRITES"]));
  }

  references(spec: AddrSpec): { into: EdgeHit[]; outof: EdgeHit[] } {
    const nodes = this.nodesAt(spec);
    return { into: nodes.flatMap((n) => this.edgesInto(n.id)), outof: nodes.flatMap((n) => this.edgesOutOf(n.id)) };
  }

  /** "$D018" | "d018" | exact id | name substring — both layers merged. */
  find(q: string): ResolvedNode[] {
    const text = q.trim();
    if (!text) return [];
    if (/^(?:\$|0x)[0-9a-f]{1,4}$/iu.test(text) || /^[0-9a-f]{4}$/iu.test(text)) return this.nodesAt(text);
    if (text.includes(":")) {
      const n = this.resolve(text);
      return n.dangling ? [] : [n];
    }
    const rows = this.nodesByName.all(`%${text}%`) as unknown as NodeRow[];
    const byId = new Map<string, NodeRow[]>();
    for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    const out = [...byId.values()].map((rs) => mergeRows(rs)!);
    for (const platform of ["c64", "c1541"] as const) {
      for (const p of this.platform?.search(platform, text, 10) ?? []) out.push(this.resolve(p.id));
    }
    return out;
  }

  /** BFS over edges of the given types (default: control flow), `from` → `to`. */
  path(from: string, to: string, options: PathOptions = {}): EdgeHit[] | undefined {
    const types = options.types ?? CONTROL_FLOW_TYPES;
    const maxDepth = options.maxDepth ?? 12;
    const prev = new Map<string, EdgeHit>();
    const seen = new Set<string>([from]);
    let frontier = [from];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.edgesOutOf(id, types)) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          prev.set(e.to, e);
          if (e.to === to) {
            const out: EdgeHit[] = [];
            let cur = to;
            while (cur !== from) { const p = prev.get(cur)!; out.unshift(p); cur = p.from; }
            return out;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return undefined;
  }

  // ------------------------------------------------------------ 819 D8 verbs

  routines(owner?: string): ResolvedNode[] {
    return this.byKind("routine", owner);
  }

  labels(routineId: string): ResolvedNode[] {
    return this.edgesOutOf(routineId, ["CONTAINS"]).map((e) => e.toNode);
  }

  containerOf(id: string): ResolvedNode[] {
    return this.edgesInto(id, ["CONTAINS"]).map((e) => e.fromNode);
  }

  entryPoints(owner?: string): ResolvedNode[] {
    return this.routines(owner).filter((r) => r.attrs.entry_source !== undefined);
  }

  romCalls(owner?: string): EdgeHit[] {
    const rows = this.store.db.prepare("SELECT * FROM edges WHERE type = 'CALLS_ROM' AND (? IS NULL OR owner = ?) ORDER BY to_id, from_id, evidence_key").all(owner ?? null, owner ?? null) as unknown as EdgeRow[];
    return rows.map((e) => this.hit(e));
  }

  // ------------------------------------------------------------ 820 D5 verbs

  /** Every ZP address a routine touches, grouped by role, with counts. */
  zpUsage(routineId: string): Array<{ address: number; id: string; role: string; count: number }> {
    const tally = new Map<string, { address: number; id: string; role: string; count: number }>();
    for (const e of this.edgesOutOf(routineId, ["USES_ZP"])) {
      const role = String(e.evidence.role ?? "direct");
      const k = `${e.to}|${role}`;
      const cur = tally.get(k) ?? { address: e.toNode.address, id: e.to, role, count: 0 };
      cur.count += 1;
      tally.set(k, cur);
    }
    return [...tally.values()].sort((a, b) => a.address - b.address || a.role.localeCompare(b.role));
  }

  /** Routines touching a hardware register, READS/WRITES split, provenance shown. */
  usesHardware(spec: AddrSpec): Array<{ routine: string; reads: number; writes: number; provenance: Set<string> }> {
    const out = new Map<string, { routine: string; reads: number; writes: number; provenance: Set<string> }>();
    for (const n of this.nodesAt(spec)) {
      for (const e of this.edgesInto(n.id, ["READS", "WRITES"])) {
        const cur = out.get(e.from) ?? { routine: e.from, reads: 0, writes: 0, provenance: new Set<string>() };
        if (e.type === "READS") cur.reads += 1; else cur.writes += 1;
        cur.provenance.add(String(e.evidence.provenance ?? e.origin));
        out.set(e.from, cur);
      }
    }
    return [...out.values()].sort((a, b) => a.routine.localeCompare(b.routine));
  }

  /** The unknowns, listed as unknowns: *_INDIRECT edges of a routine, or through a ZP pointer. */
  indirectAccesses(idOrZp: string): EdgeHit[] {
    const types = ["READS_INDIRECT", "WRITES_INDIRECT"];
    if (/^(?:\$|0x)?[0-9a-f]{1,4}$/iu.test(idOrZp)) {
      return this.nodesAt(idOrZp).flatMap((n) => this.edgesInto(n.id, types));
    }
    return this.edgesOutOf(idOrZp, types);
  }

  private byKind(kind: string, owner?: string): ResolvedNode[] {
    const rows = this.nodesByKind.all(kind, owner ?? null, owner ?? null) as unknown as NodeRow[];
    const byId = new Map<string, NodeRow[]>();
    for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    return [...byId.values()].map((rs) => mergeRows(rs)!);
  }
}

export type { Ctx };
