// Spec 804 §4 — one resolver: which name, from which layer, for a runtime address.
//
// Precedence user > build > derived. A payload name is shown only while its payload is
// RESIDENT — its code bytes near the address equal what the machine holds (§4.2). No
// match → no name, never a wrong one; two resident candidates with different names in the
// winning layer → no name, and the answer says `ambiguous`. Space is part of the key: a
// `drive8` address never looks at a C64 name.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { graphPath } from "../knowledge-graph/store.js";
import { loadNameLayers, type NameLayers } from "./layers.js";
import { COMPARE_MIN, PayloadBytes } from "./payload-bytes.js";
import {
  ORIGIN_RANK, ORIGIN_TAG, payloadKey, payloadLabel,
  type ByteSource, type MachineState, type NameEntry, type NameOrigin, type ResidencyEvidence,
  type ResolveRequest, type Resolution, type ResolvedName, type RuntimeSpace,
} from "./types.js";

const LAYERS: NameOrigin[] = ["user", "build", "derived"];

export interface ResolveContext {
  bytes: ByteSource;
  machine?: MachineState;
}

interface PairKey { entry: NameEntry; addr: number; space: RuntimeSpace; lens?: string }

export class SymbolResolver {
  private readonly bySpace = new Map<RuntimeSpace, NameEntry[]>();
  private readonly byName = new Map<string, NameEntry[]>();
  readonly bytes: PayloadBytes;

  constructor(readonly projectDir: string | undefined, readonly layers: NameLayers) {
    for (const e of layers.entries) {
      const list = this.bySpace.get(e.space) ?? [];
      list.push(e);
      this.bySpace.set(e.space, list);
      const named = this.byName.get(e.name) ?? [];
      named.push(e);
      this.byName.set(e.name, named);
    }
    for (const list of this.bySpace.values()) list.sort((a, b) => a.address - b.address);
    this.bytes = new PayloadBytes(projectDir ?? "", layers.relocations, layers.crtOwners);
  }

  static empty(): SymbolResolver {
    return new SymbolResolver(undefined, { entries: [], relocations: new Map(), crtOwners: new Map(), sources: { graph: false, graphNodes: 0, symbolFiles: [] } });
  }

  /** The project's resolver, reloaded when the graph or the artifact store changed. */
  static forProject(projectDir: string | undefined): SymbolResolver {
    if (!projectDir || !existsSync(join(projectDir, "knowledge"))) return SymbolResolver.empty();
    const stamp = [graphPath(projectDir), `${graphPath(projectDir)}-wal`, join(projectDir, "knowledge", "artifacts.json")]
      .map((p) => { try { return statSync(p).mtimeMs; } catch { return 0; } })
      .join(":");
    const hit = CACHE.get(projectDir);
    if (hit && hit.stamp === stamp) return hit.resolver;
    const resolver = new SymbolResolver(projectDir, loadNameLayers(projectDir));
    CACHE.set(projectDir, { stamp, resolver });
    return resolver;
  }

  get size(): number {
    return this.layers.entries.length;
  }

  /** Every name at or around an address, before residency. */
  candidatesAt(space: RuntimeSpace, addr: number, containment: "data" | "all" = "all"): { exact: NameEntry[]; containing: NameEntry[] } {
    const index = this.indexFor(space);
    const exact = index.exact.get(addr) ?? [];
    const containing: NameEntry[] = [];
    // ranged entries sorted by start; `maxEnd[i]` = the furthest end among 0..i, so the
    // backward scan stops as soon as nothing earlier can still reach `addr`.
    let lo = 0, hi = index.ranged.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (index.ranged[mid]!.address < addr) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0 && index.maxEnd[i]! >= addr; i--) {
      const e = index.ranged[i]!;
      if (e.endAddress! >= addr && (containment === "all" || e.range === "data")) containing.push(e);
    }
    return { exact, containing };
  }

  private readonly indexes = new Map<RuntimeSpace, { exact: Map<number, NameEntry[]>; ranged: NameEntry[]; maxEnd: number[] }>();

  private indexFor(space: RuntimeSpace): { exact: Map<number, NameEntry[]>; ranged: NameEntry[]; maxEnd: number[] } {
    let idx = this.indexes.get(space);
    if (idx) return idx;
    const exact = new Map<number, NameEntry[]>();
    const ranged: NameEntry[] = [];
    for (const e of this.bySpace.get(space) ?? []) {
      const list = exact.get(e.address) ?? [];
      list.push(e);
      exact.set(e.address, list);
      if (e.endAddress !== null) ranged.push(e);
    }
    ranged.sort((a, b) => a.address - b.address);
    const maxEnd: number[] = [];
    ranged.forEach((e, i) => { maxEnd.push(Math.max(i > 0 ? maxEnd[i - 1]! : -1, e.endAddress!)); });
    idx = { exact, ranged, maxEnd };
    this.indexes.set(space, idx);
    return idx;
  }

  /**
   * Every code-byte address a batch of requests would compare, by space — so a byte
   * source that must be PREPARED (a trace timeline) can be built for exactly those.
   */
  neededBytes(requests: ResolveRequest[]): Map<RuntimeSpace, number[]> {
    const sets = new Map<RuntimeSpace, Set<number>>();
    for (const r of requests) {
      const entries = (r.len ?? 1) > 1
        ? this.entriesIn(r.space, r.addr, Math.min(0xffff, r.addr + (r.len ?? 1) - 1)).map((e) => [e, e.address] as const)
        : (() => { const c = this.candidatesAt(r.space, r.addr, r.containment ?? "data"); return [...c.exact, ...c.containing].map((e) => [e, r.addr] as const); })();
      for (const [e, at] of entries) {
        if (!e.payload) continue;
        const set = sets.get(r.space) ?? new Set<number>();
        for (const a of this.bytes.comparisonSet(e.payload, at)) set.add(a);
        sets.set(r.space, set);
      }
    }
    return new Map([...sets].map(([s, set]) => [s, [...set].sort((a, b) => a - b)]));
  }

  private entriesIn(space: RuntimeSpace, lo: number, hi: number): NameEntry[] {
    const list = this.bySpace.get(space) ?? [];
    let a = 0, b = list.length;
    while (a < b) { const mid = (a + b) >> 1; if (list[mid]!.address < lo) a = mid + 1; else b = mid; }
    const out: NameEntry[] = [];
    for (let i = a; i < list.length && list[i]!.address <= hi; i++) out.push(list[i]!);
    return out;
  }

  /**
   * Residency for every (entry, address) pair at once: one memory read per (space, lens)
   * for all the code bytes involved.
   */
  private async residency(pairs: PairKey[], ctx: ResolveContext): Promise<Map<string, ResidencyEvidence>> {
    const out = new Map<string, ResidencyEvidence>();
    const plans: Array<{ key: string; label: string; space: RuntimeSpace; lens?: string; addrs: number[]; expected: Map<number, number> }> = [];
    const wanted = new Map<string, Set<number>>(); // `${space}|${lens}` → addresses
    const planned = new Set<string>();
    for (const p of pairs) {
      const ref = p.entry.payload;
      if (!ref) continue;
      const key = pairKey(p);
      if (out.has(key) || planned.has(key)) continue;
      planned.add(key);
      const label = payloadLabel(ref)!;
      if (ref.kind === "crt") {
        const bank = ctx.machine?.cartBank ?? null;
        if (bank === null || bank !== ref.bank) {
          out.set(key, { payload: label, resident: false, compared: 0, matched: 0, reason: bank === null ? "no cartridge bank mapped" : `bank ${bank} is mapped, not ${ref.bank}` });
          continue;
        }
      }
      const addrs = this.bytes.comparisonSet(ref, p.addr);
      if (addrs.length === 0) {
        out.set(key, { payload: label, resident: false, compared: 0, matched: 0, reason: "too few code bytes near the address to decide" });
        continue;
      }
      const code = this.bytes.codeBytes(ref);
      plans.push({ key, label, space: p.space, lens: p.lens, addrs, expected: code });
      const g = `${p.space}|${p.lens ?? ""}`;
      const set = wanted.get(g) ?? new Set<number>();
      for (const a of addrs) set.add(a);
      wanted.set(g, set);
    }
    const memory = new Map<string, Map<number, number>>();
    for (const [g, set] of wanted) {
      const [space, lens] = g.split("|") as [RuntimeSpace, string];
      memory.set(g, await ctx.bytes.read(space, lens || undefined, [...set].sort((a, b) => a - b)));
    }
    for (const plan of plans) {
      const live = memory.get(`${plan.space}|${plan.lens ?? ""}`)!;
      let compared = 0, matched = 0;
      for (const a of plan.addrs) {
        const v = live.get(a);
        if (v === undefined) continue;
        compared += 1;
        if (v === plan.expected.get(a)) matched += 1;
      }
      const resident = compared >= COMPARE_MIN && matched === compared;
      out.set(plan.key, {
        payload: plan.label, resident, compared, matched,
        ...(resident ? {} : { reason: compared < COMPARE_MIN ? "memory not readable there" : `${compared - matched} of ${compared} code bytes differ` }),
      });
    }
    return out;
  }

  private isResident(p: PairKey, ev: Map<string, ResidencyEvidence>): boolean {
    if (!p.entry.payload) return true; // an address name names the address, whoever is there
    return ev.get(pairKey(p))?.resident === true;
  }

  /** Resolve every request. One residency pass for the whole batch. */
  async resolve(requests: ResolveRequest[], ctx: ResolveContext): Promise<Resolution[]> {
    const plans = requests.map((r) => {
      if ((r.len ?? 1) > 1) {
        const hi = Math.min(0xffff, r.addr + (r.len ?? 1) - 1);
        return { r, exactByAddr: groupByAddress(this.entriesIn(r.space, r.addr, hi)), exact: [] as NameEntry[], containing: [] as NameEntry[] };
      }
      const c = this.candidatesAt(r.space, r.addr, r.containment ?? "data");
      return { r, exactByAddr: undefined, ...c };
    });
    const pairs: PairKey[] = [];
    for (const p of plans) {
      if (p.exactByAddr) {
        for (const [a, list] of p.exactByAddr) for (const e of list) pairs.push({ entry: e, addr: a, space: p.r.space, lens: p.r.lens });
      } else {
        for (const e of [...p.exact, ...p.containing]) pairs.push({ entry: e, addr: p.r.addr, space: p.r.space, lens: p.r.lens });
      }
    }
    const ev = await this.residency(pairs, ctx);
    const evidenceFor = (entries: NameEntry[], addr: number, r: ResolveRequest): ResidencyEvidence[] => {
      const seen = new Set<string>();
      const list: ResidencyEvidence[] = [];
      for (const e of entries) {
        if (!e.payload) continue;
        const k = pairKey({ entry: e, addr, space: r.space, lens: r.lens });
        if (seen.has(k)) continue;
        seen.add(k);
        const x = ev.get(k);
        if (x) list.push(x);
      }
      return list;
    };
    return plans.map((p) => {
      const r = p.r;
      if (p.exactByAddr) {
        const inside: ResolvedName[] = [];
        const evidence: ResidencyEvidence[] = [];
        for (const [a, list] of [...p.exactByAddr].sort((x, y) => x[0] - y[0])) {
          const pick = pickLayer(list.filter((e) => this.isResident({ entry: e, addr: a, space: r.space, lens: r.lens }, ev)));
          if (pick && pick.length === 1) inside.push(toResolved(pick[0]!, a - r.addr));
          evidence.push(...evidenceFor(list, a, r));
        }
        return { space: r.space, addr: r.addr, inside, evidence: dedupeEvidence(evidence) };
      }
      const resident = (list: NameEntry[]) => list.filter((e) => this.isResident({ entry: e, addr: r.addr, space: r.space, lens: r.lens }, ev));
      const exact = resident(p.exact);
      const containing = resident(p.containing);
      const evidence = dedupeEvidence(evidenceFor([...p.exact, ...p.containing], r.addr, r));
      for (const layer of LAYERS) {
        const ex = exact.filter((e) => e.origin === layer);
        if (ex.length > 0) return finish(r, ex, 0, evidence);
        const inRange = containing.filter((e) => e.origin === layer);
        if (inRange.length > 0) {
          const smallest = Math.min(...inRange.map((e) => (e.endAddress ?? e.address) - e.address));
          const tight = inRange.filter((e) => (e.endAddress ?? e.address) - e.address === smallest);
          return finish(r, tight, -1, evidence);
        }
      }
      return { space: r.space, addr: r.addr, evidence };
    });
  }

  /**
   * Spec 877 D5 — the name a STATIC listing may print for an address, synchronously.
   *
   * A listing is a document about bytes on disk, not a snapshot of a machine, so there
   * is nothing to compare code bytes against and residency (§4.2) has no answer here —
   * every candidate counts, whichever payload it belongs to. Everything else is the
   * live path's rule unchanged: layer precedence user > build > derived, kind rank
   * inside the winning layer, and two DIFFERENT names of the same kind mean no name.
   *
   * EXACT hits only. A containing range would resolve to `table+$A3`, which is a
   * reading of an address and not something an equate can define.
   */
  staticNameAt(space: RuntimeSpace, addr: number): Resolution {
    const r: ResolveRequest = { space, addr };
    const { exact } = this.candidatesAt(space, addr, "data");
    for (const layer of LAYERS) {
      const inLayer = exact.filter((e) => e.origin === layer);
      if (inLayer.length > 0) return finish(r, inLayer, 0, []);
    }
    return { space, addr, evidence: [] };
  }

  /**
   * Name → address for the monitor's input (§2): the name's resident entries in the
   * winning layer must agree on ONE address, or there is no answer.
   */
  async lookupName(name: string, space: RuntimeSpace, ctx: ResolveContext): Promise<{ address: number; entry: NameEntry } | { ambiguous: number[] } | undefined> {
    const all = (this.byName.get(name) ?? []).filter((e) => e.space === space);
    if (all.length === 0) return undefined;
    const pairs = all.map((e) => ({ entry: e, addr: e.address, space }));
    const ev = await this.residency(pairs, ctx);
    const resident = pairs.filter((p) => this.isResident(p, ev)).map((p) => p.entry);
    for (const layer of LAYERS) {
      const inLayer = resident.filter((e) => e.origin === layer);
      if (inLayer.length === 0) continue;
      const addrs = [...new Set(inLayer.map((e) => e.address))];
      if (addrs.length === 1) return { address: addrs[0]!, entry: inLayer[0]! };
      return { ambiguous: addrs.sort((a, b) => a - b) };
    }
    return undefined;
  }
}

const CACHE = new Map<string, { stamp: string; resolver: SymbolResolver }>();

function pairKey(p: PairKey): string {
  return `${p.entry.payload ? payloadKey(p.entry.payload) : "-"}@${p.space}/${p.lens ?? "cpu"}/${p.addr}`;
}

function groupByAddress(entries: NameEntry[]): Map<number, NameEntry[]> {
  const m = new Map<number, NameEntry[]>();
  for (const e of entries) {
    const list = m.get(e.address) ?? [];
    list.push(e);
    m.set(e.address, list);
  }
  return m;
}

/** The highest-precedence layer's entries, collapsed to distinct names. */
function pickLayer(entries: NameEntry[]): NameEntry[] | undefined {
  for (const layer of LAYERS) {
    const layerEntries = entries.filter((e) => e.origin === layer);
    if (layerEntries.length === 0) continue;
    const best = Math.min(...layerEntries.map((e) => KIND_RANK[e.kind] ?? 9));
    const inLayer = layerEntries.filter((e) => (KIND_RANK[e.kind] ?? 9) === best);
    const byName = new Map<string, NameEntry>();
    for (const e of inLayer) if (!byName.has(e.name)) byName.set(e.name, e);
    return [...byName.values()];
  }
  return undefined;
}

function toResolved(e: NameEntry, offset: number): ResolvedName {
  return { name: e.name, origin: e.origin, tag: ORIGIN_TAG[e.origin], kind: e.kind, address: e.address, offset, payload: payloadLabel(e.payload) };
}

/**
 * Within one layer, a routine outranks a label, a label a data block, and so on down to a
 * labelled segment (the 826.0 RESOLVES_TO order, extended): a routine and the segment it
 * opens are two names for one address, not an ambiguity. Ambiguous is two DIFFERENT names
 * of the same kind.
 */
const KIND_RANK: Record<string, number> = { routine: 0, label: 1, symbol: 2, data_block: 3, segment: 4, addr: 5 };

function finish(r: ResolveRequest, all: NameEntry[], offset: number, evidence: ResidencyEvidence[]): Resolution {
  const best = Math.min(...all.map((e) => KIND_RANK[e.kind] ?? 9));
  const entries = all.filter((e) => (KIND_RANK[e.kind] ?? 9) === best);
  const distinct = new Map<string, NameEntry>();
  for (const e of entries) if (!distinct.has(e.name)) distinct.set(e.name, e);
  if (distinct.size === 1) {
    const e = [...distinct.values()][0]!;
    return { space: r.space, addr: r.addr, name: toResolved(e, offset < 0 ? r.addr - e.address : offset), evidence };
  }
  return {
    space: r.space, addr: r.addr, evidence,
    ambiguous: [...distinct.values()]
      .sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, origin: e.origin, payload: payloadLabel(e.payload) })),
  };
}

function dedupeEvidence(list: ResidencyEvidence[]): ResidencyEvidence[] {
  const seen = new Set<string>();
  return list.filter((e) => { const k = `${e.payload}|${e.resident}|${e.compared}|${e.matched}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** `name[u]`, `name+$05[u]` — the one text form of a resolved name. */
export function formatName(n: ResolvedName): string {
  const off = n.offset > 0 ? `+$${n.offset.toString(16).padStart(2, "0")}` : "";
  return `${n.name}${off}${n.tag}`;
}
