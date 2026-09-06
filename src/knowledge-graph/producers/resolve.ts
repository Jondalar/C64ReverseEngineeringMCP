// Spec 826.0 T2 / T4 — the RESOLVES_TO pass.
//
// 818 puts the owner into a routine's id on purpose: two artifacts can carry
// different code at one address. The price is that a `jsr $FC00` from artifact
// A lands on the ownerless `slug:ram:addr:fc00` when the routine at $FC00 was
// seeded from artifact B — `graph_path` stops at the artifact boundary and
// "who calls the fastloader" loses every cross-artifact call (WL1, 2026-09-06).
//
// This pass runs after every seed and after every annotation import, over the
// WHOLE project: for each ownerless `addr` node, the routines / labels / data
// blocks any owner has at the same (space, bank, address). Exactly one → a
// `RESOLVES_TO` edge, `inferred`. Several → nothing, and the ambiguity is
// recorded in meta (`resolve.ambiguous`) so it is visible, not silent. The
// query layer follows the edge (query.ts edgesInto / edgesOutOf) and names the
// hop in `evidence.via`.
//
// Replacement unit = (producer "826r", owner NULL): the pass replaces itself.

import { GraphStore } from "../store.js";

export const RESOLVE_PRODUCER = "826r";

export interface ResolveResult {
  addrNodes: number;
  resolved: number;
  ambiguous: number;
  ms: number;
}

interface AddrRow { id: string; space: string; bank: number | null; address: number }
interface CandRow { id: string; kind: string; layer: string }

/** Runs on an open store; pass `inTransaction` when the caller already holds one (the annotation importer does). */
export function resolveAddressesIn(store: GraphStore, options: { inTransaction?: boolean } = {}): ResolveResult {
  const t0 = process.hrtime.bigint();
  const db = store.db;
  const addrs = db.prepare("SELECT DISTINCT id, space, bank, address FROM nodes WHERE kind = 'addr' ORDER BY id").all() as unknown as AddrRow[];
  const candidates = db.prepare(
    "SELECT DISTINCT id, kind, layer FROM nodes WHERE address = ? AND space = ? AND kind IN ('routine', 'label', 'data_block') AND (? IS NULL OR bank IS NULL OR bank = ?) ORDER BY id",
  );
  // 826.0 T4 — an address INSIDE a named table (`lda $FDF5` into
  // zone_sector_interleave_tbl $FDD4-$FDFF) belongs to that data block: the
  // reference lands on the name, with the offset said. Only ranged data
  // blocks; a routine's extent is not an alias (a jump into its middle is a
  // label, 819's business).
  const ranged = db.prepare("SELECT DISTINCT id, kind, layer, space, bank, address, end_address FROM nodes WHERE kind = 'data_block' AND end_address IS NOT NULL AND end_address > address ORDER BY id")
    .all() as unknown as Array<CandRow & { space: string; bank: number | null; address: number; end_address: number }>;
  const containing = (a: AddrRow) => ranged
    .filter((d) => d.space === a.space && d.address < a.address && a.address <= d.end_address && (a.bank === null || d.bank === null || d.bank === a.bank))
    .sort((x, y) => (x.end_address - x.address) - (y.end_address - y.address) || x.id.localeCompare(y.id));
  const del = db.prepare("DELETE FROM edges WHERE producer = ? AND owner IS NULL");
  const ins = db.prepare(
    "INSERT OR IGNORE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, 'RESOLVES_TO', ?, 'generated', '', 'static', 'inferred', ?, NULL, ?)",
  );
  const ambiguous: Array<{ id: string; candidates: string[] }> = [];
  let resolved = 0;
  const run = () => {
    del.run(RESOLVE_PRODUCER);
    for (const a of addrs) {
      const rows = candidates.all(a.address, a.space, a.bank, a.bank) as unknown as CandRow[];
      const all = [...new Set(rows.map((r) => r.id))].filter((id) => id !== a.id);
      // Precedence by kind: a jsr into $2000 means the ROUTINE there even when a
      // human label sits on the same address; a named table (data_block, 826.0
      // T4) outranks the label at its first byte. Ambiguous only within the
      // highest kind present.
      const kindOf = (id: string) => rows.find((r) => r.id === id)!.kind;
      let ids: string[] = [];
      for (const kind of ["routine", "data_block", "label"]) {
        ids = all.filter((id) => kindOf(id) === kind);
        if (ids.length > 0) break;
      }
      if (ids.length === 1) {
        const target = ids[0]!;
        const cand = rows.find((r) => r.id === target)!;
        ins.run(a.id, target, RESOLVE_PRODUCER, JSON.stringify({ rule: "826.0-T2", candidates: all.length, kind: cand.kind, layer: cand.layer }));
        resolved += 1;
      } else if (ids.length > 1) {
        ambiguous.push({ id: a.id, candidates: all });
      } else {
        // nothing AT the address: the smallest data block that CONTAINS it (T4)
        const uniq = containing(a);
        if (uniq.length >= 1) {
          const d = uniq[0]!;
          const tight = uniq.filter((r) => r.address === d.address);
          if (tight.length === 1) {
            ins.run(a.id, d.id, RESOLVE_PRODUCER, JSON.stringify({ rule: "826.0-T4", candidates: uniq.length, kind: d.kind, layer: d.layer, offset: a.address - d.address }));
            resolved += 1;
          } else {
            ambiguous.push({ id: a.id, candidates: uniq.map((r) => r.id) });
          }
        }
      }
    }
    store.setMeta("resolve.ambiguous", JSON.stringify(ambiguous));
    store.recordProducer(RESOLVE_PRODUCER);
  };
  if (options.inTransaction) run();
  else {
    db.exec("BEGIN");
    try { run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { addrNodes: addrs.length, resolved, ambiguous: ambiguous.length, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/** Opens the project's graph writable, runs the pass, closes. */
export function resolveAddresses(projectDir: string): ResolveResult {
  const store = GraphStore.open(projectDir);
  try { return resolveAddressesIn(store); } finally { store.close(); }
}

/** The ambiguous addr nodes the last pass recorded — several owners, no edge. */
export function ambiguousAddresses(store: GraphStore): Array<{ id: string; candidates: string[] }> {
  const raw = store.getMeta("resolve.ambiguous");
  if (!raw) return [];
  try { return JSON.parse(raw) as Array<{ id: string; candidates: string[] }>; } catch { return []; }
}
