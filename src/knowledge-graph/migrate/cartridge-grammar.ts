// Spec 909 D6 — a project written with `crt/<bank>` moves, once, to `crt/<cart>/<bank>`.
//
// Before 909 every cartridge-space node of a project lived in one context, so two cartridges shared their bank-0
// nodes. This renames each such node (and everything that points at it) to the cartridge it belongs to:
//
//   1. the cartridges the project's extracts describe are registered (the same sync an extract runs);
//   2. every legacy node id gets a cartridge from what the graph itself holds about where it came from —
//      the payload's source artifact, the evidence artifacts, the analysis run that wrote it — followed up to the
//      cartridge image (Spec 025 lineage, or the directory the image was extracted into);
//   3. a project with exactly ONE cartridge moves everything to it;
//   4. what is left is kept, under `crt/unplaced/<bank>`, and LISTED BY NAME — never merged into a real cartridge,
//      never guessed;
//   5. the manifest-derived chips and banks of every cartridge are re-derived from that cartridge's own manifest
//      (the caller does it: it needs the service) — which repairs the state the bug left, a second image's chips
//      sitting on the first image's nodes.
//
// Guarded by `meta.cart_grammar`: a graph that carries the stamp is never looked at again. Everything — nodes, edges,
// claims, annotations, questions, the evidence and ledger rows that name them — moves in ONE transaction, or nothing does.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { syncCartridges } from "../../project-knowledge/cartridge-registry.js";
import { readCrtHeader, sha256OfFile } from "../../project-knowledge/cartridge-identity.js";
import type { ArtifactRecord } from "../../project-knowledge/types.js";
import { cartOfArtifact, readCartridges, registerCartridge, type CartridgeRecord } from "../cartridges.js";
import { deriveCartridgeId, parseLegacyCrtId, UNPLACED_CART } from "../ids.js";
import { CART_GRAMMAR_STAMP, GRAPH_SCHEMA_VERSION } from "../schema.js";
import { GraphStore, graphPath, readProjectSlug } from "../store.js";
import { writeTx } from "../write-tx.js";
import { annotationId } from "./schema-822.js";

export const CART_GRAMMAR = CART_GRAMMAR_STAMP;
export const CART_MIGRATION_META = "cart_migration";
export const CART_REDERIVE_META = "cart_rederive_pending";

export interface CartridgeMigrationReport {
  at: string;
  /** legacy node ids renamed (a node with two layers counts once) */
  movedNodes: number;
  /** rows in `nodes` before and after — a rename changes neither */
  rowsBefore: number;
  rowsAfter: number;
  edgesRenamed: number;
  /** cartridge token -> how many node ids went to it */
  byCart: Record<string, number>;
  /** node ids that could not be placed, by name, now under crt/unplaced/<bank> */
  unplaced: Array<{ was: string; now: string }>;
  /** manifests whose chips are to be re-derived from their own extract */
  rederive: string[];
}

const LEGACY_ID = /[a-z0-9][a-z0-9-]*:crt\/[0-9a-f]{2,4}:[a-z_]+:[0-9a-f]{4}/gu;

function readArtifacts(projectDir: string): ArtifactRecord[] {
  const p = join(projectDir, "knowledge", "artifacts.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { items?: ArtifactRecord[] } | ArtifactRecord[];
    return Array.isArray(raw) ? raw : raw.items ?? [];
  } catch { return []; }
}

const checked = new Set<string>();

/** Test hook: forget which projects this process has already looked at. */
export function resetCartridgeGrammarCache(): void {
  checked.clear();
}

/**
 * Open a project's graph and bring it to the cartridge grammar, once. Returns the report when it moved anything (or
 * had to note something), undefined when there was nothing to do. A project with no graph, or one already stamped, is
 * a cheap read.
 */
export function ensureCartridgeGrammar(projectDir: string): CartridgeMigrationReport | undefined {
  if (checked.has(projectDir)) return undefined;
  const path = graphPath(projectDir);
  if (!existsSync(path) || !existsSync(join(projectDir, "knowledge", "project.json"))) return undefined;
  let probe: GraphStore;
  try { probe = GraphStore.open(projectDir, { readOnly: true }); } catch { return undefined; }
  let stamped: boolean;
  try { stamped = probe.getMeta("cart_grammar") === CART_GRAMMAR; } finally { probe.close(); }
  if (stamped) { checked.add(projectDir); return undefined; }
  const store = GraphStore.open(projectDir);
  try {
    const report = migrateCartridgeGrammar(store, projectDir);
    checked.add(projectDir);
    return report;
  } finally {
    store.close();
  }
}

interface Candidate { artifactIds: string[]; stems: string[] }

export function migrateCartridgeGrammar(store: GraphStore, projectDir: string): CartridgeMigrationReport | undefined {
  const db = store.db;
  const slug = readProjectSlug(projectDir);
  const artifacts = readArtifacts(projectDir);
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  const has822 = tables.has("evidence") && tables.has("claims") && tables.has("annotations") && tables.has("questions") && tables.has("migration_log");

  // ---- which legacy ids are there, anywhere
  const legacyNodes = (db.prepare("SELECT id FROM nodes WHERE space = 'crt'").all() as Array<{ id: string }>)
    .map((r) => r.id).filter((id) => parseLegacyCrtId(id) !== undefined);
  const legacyIds = new Set<string>(legacyNodes);
  const scan = (sql: string, ...cols: string[]) => {
    for (const r of db.prepare(sql).all() as Array<Record<string, string | null>>) {
      for (const c of cols) for (const m of String(r[c] ?? "").matchAll(LEGACY_ID)) if (parseLegacyCrtId(m[0]) !== undefined) legacyIds.add(m[0]);
    }
  };
  scan("SELECT from_id, to_id FROM edges WHERE from_id LIKE '%:crt/%' OR to_id LIKE '%:crt/%'", "from_id", "to_id");
  if (has822) {
    scan("SELECT node_id FROM claims WHERE node_id LIKE '%:crt/%'", "node_id");
    scan("SELECT node_id FROM annotations WHERE node_id LIKE '%:crt/%'", "node_id");
    scan("SELECT node_id FROM questions WHERE node_id LIKE '%:crt/%'", "node_id");
  }

  const stampOnly = (): undefined => {
    writeTx(db, () => {
      store.setMeta("cart_grammar", CART_GRAMMAR);
      store.setMeta("schema_version", String(GRAPH_SCHEMA_VERSION));
    });
    return undefined;
  };
  if (legacyIds.size === 0) return stampOnly();

  const rowsBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n);

  // ---- 1. the cartridges the extracts describe
  syncCartridges(store, slug, artifacts);
  let carts = readCartridges(db);
  // A project whose manifests never said which image they came from (a record the old manifest-role bug mislabelled, an
  // extract whose link was lost) still HAS its images. If it holds exactly ONE cartridge image, every cartridge-space
  // node can only be that cartridge's; with several, nothing says which, and nothing is guessed.
  if (carts.length === 0) {
    const images = new Map<string, ArtifactRecord>();
    for (const a of artifacts) if (a.role === "cartridge-image" || a.kind === "crt") images.set(a.lineageRoot ?? a.id, a);
    if (images.size === 1) {
      const image = [...images.values()][0]!;
      const there = existsSync(image.path);
      const header = there ? readCrtHeader(image.path) : {};
      registerCartridge(store, slug, {
        image: { id: image.id, path: image.path, title: image.title, lineageRoot: image.lineageRoot },
        hardwareType: header.hardwareType, imageName: header.name, imageSha256: there ? sha256OfFile(image.path) : undefined,
      });
      carts = readCartridges(db);
    }
  }
  const byManifest = new Map<string, CartridgeRecord>();
  for (const c of carts) for (const m of c.manifestArtifactIds) byManifest.set(m, c);

  // ---- 2. where did each legacy id come from
  // Two cartridges each have a `bank_00_8000`: a stem names ONE analysis only when it is the only one.
  const artByStem = new Map<string, ArtifactRecord[]>();
  for (const a of artifacts) {
    const m = (a.path ?? "").match(/([^/\\]+)_analysis\.json$/u);
    if (m) { const k = m[1]!.toLowerCase(); artByStem.set(k, [...(artByStem.get(k) ?? []), a]); }
  }
  const cartsOfStem = (stem: string): Set<string> => {
    const out = new Set<string>();
    for (const a of [...(artByStem.get(stem) ?? []), ...(artByStem.get(stem.replace(/_disasm$/u, "")) ?? [])]) {
      const h = cartOfArtifact(artifacts, carts, a.id, a.path);
      if (h) out.add(h.cart);
    }
    return out;
  };
  // Which banks each cartridge's own manifest says it has: a bank only ONE cartridge has can only be that one's.
  const banksOf = new Map<string, Set<number>>();
  for (const c of carts) {
    const set = new Set<number>();
    for (const mid of c.manifestArtifactIds) {
      const art = artifacts.find((a) => a.id === mid);
      if (!art || !existsSync(art.path)) continue;
      try {
        const man = JSON.parse(readFileSync(art.path, "utf8")) as { chips?: Array<{ bank?: number }> };
        for (const chip of man.chips ?? []) if (typeof chip.bank === "number") set.add(chip.bank);
      } catch { /* an unreadable manifest says nothing */ }
    }
    banksOf.set(c.cart, set);
  }
  const stemOfAnnotations = (sourcePath: string): string => basename(sourcePath).replace(/_annotations\.json$/u, "").replace(/_disasm$/u, "").toLowerCase();
  const candidates = new Map<string, Candidate>();
  const cand = (id: string): Candidate => { let c = candidates.get(id); if (!c) { c = { artifactIds: [], stems: [] }; candidates.set(id, c); } return c; };
  const attrIds = (attrs: string): string[] => {
    try {
      const a = JSON.parse(attrs) as { payload?: { source_artifact_id?: string }; artifact_ids?: string[] };
      return [a.payload?.source_artifact_id, ...(a.artifact_ids ?? [])].filter((x): x is string => typeof x === "string");
    } catch { return []; }
  };
  const sourcePathOf = (attrs: string): string | undefined => { try { return (JSON.parse(attrs) as { source_path?: string }).source_path; } catch { return undefined; } };
  const rows = db.prepare("SELECT id, layer, attrs, run_owner FROM nodes WHERE space = 'crt'").all() as Array<{ id: string; layer: string; attrs: string; run_owner: string | null }>;
  // The payload's own source comes first: it names the BYTES the node stands for.
  for (const r of rows) {
    if (parseLegacyCrtId(r.id) === undefined) continue;
    const c = cand(r.id);
    const payload = (() => { try { return (JSON.parse(r.attrs) as { payload?: { source_artifact_id?: string } }).payload?.source_artifact_id; } catch { return undefined; } })();
    if (payload) c.artifactIds.unshift(payload);
    c.artifactIds.push(...attrIds(r.attrs));
    if (r.run_owner) c.stems.push(r.run_owner.toLowerCase());
    const sp = sourcePathOf(r.attrs);
    if (sp) c.stems.push(stemOfAnnotations(sp));
  }
  if (has822) {
    for (const e of db.prepare("SELECT target_key, artifact_id FROM evidence WHERE target_table = 'nodes' AND target_key LIKE '%:crt/%' AND artifact_id IS NOT NULL ORDER BY captured_at").all() as Array<{ target_key: string; artifact_id: string }>) {
      if (legacyIds.has(e.target_key)) cand(e.target_key).artifactIds.push(e.artifact_id);
    }
  }
  // An edge's owner is the analysis run that wrote it: it says which cartridge a shared `addr` node was used from.
  const edgeOwnersOf = new Map<string, Set<string>>();
  for (const e of db.prepare("SELECT from_id, to_id, owner FROM edges WHERE owner IS NOT NULL AND (from_id LIKE '%:crt/%' OR to_id LIKE '%:crt/%')").all() as Array<{ from_id: string; to_id: string; owner: string }>) {
    for (const id of [e.from_id, e.to_id]) if (legacyIds.has(id)) { const s = edgeOwnersOf.get(id) ?? new Set(); s.add(e.owner.toLowerCase()); edgeOwnersOf.set(id, s); }
  }
  for (const [id, owners] of edgeOwnersOf) cand(id).stems.push(...owners);

  const cartOf = (c: Candidate): string | undefined => {
    const hits: string[] = [];
    for (const a of c.artifactIds) {
      const h = cartOfArtifact(artifacts, carts, a);
      if (h) hits.push(h.cart);
    }
    if (hits.length > 0) return hits[0];
    const stemHits = new Set<string>();
    for (const s of c.stems) for (const cart of cartsOfStem(s)) stemHits.add(cart);
    return stemHits.size === 1 ? [...stemHits][0] : undefined;
  };
  const cartOfBank = (bank: number): string | undefined => {
    const having = carts.filter((c) => banksOf.get(c.cart)?.has(bank));
    return having.length === 1 ? having[0]!.cart : undefined;
  };

  // ---- 3./4. the decision, one per id
  const only = carts.length === 1 ? carts[0]!.cart : undefined;
  const target = new Map<string, string>();
  const unplaced: Array<{ was: string; now: string }> = [];
  const byCart: Record<string, number> = {};
  const newId = (id: string, cart: string): string => {
    const p = parseLegacyCrtId(id)!;
    return `${p.slug}:crt/${cart}/${p.bank.toString(16).padStart(2, "0")}:${p.kind}:${p.address.toString(16).padStart(4, "0")}`;
  };
  for (const id of [...legacyIds].sort()) {
    const cart = cartOf(candidates.get(id) ?? { artifactIds: [], stems: [] }) ?? only ?? cartOfBank(parseLegacyCrtId(id)!.bank);
    if (cart === undefined) {
      const now = newId(id, UNPLACED_CART);
      target.set(id, now);
      unplaced.push({ was: id, now });
      byCart[UNPLACED_CART] = (byCart[UNPLACED_CART] ?? 0) + 1;
    } else {
      target.set(id, newId(id, cart));
      byCart[cart] = (byCart[cart] ?? 0) + 1;
    }
  }
  const remap = (text: string | null): string | null => (text === null ? null : text.replace(LEGACY_ID, (m) => target.get(m) ?? m));

  let edgesRenamed = 0;
  let report!: CartridgeMigrationReport;
  writeTx(db, () => {
    // the cartridge node of what could not be placed — a place of its own, role "other", marked as what it is
    if (unplaced.length > 0) {
      store.upsertGenerated({
        id: deriveCartridgeId(slug, UNPLACED_CART), kind: "cartridge", name: UNPLACED_CART,
        attrs: { cartridge: { image_name: "(unplaced — cartridge-space nodes of a project written before cartridges had identities)", image_file: "" }, unplaced: true },
        origin: "static", confidence: "certain", evidence: [],
      }, "909");
    }
    // nodes
    const updNode = db.prepare("UPDATE nodes SET id = ? WHERE id = ?");
    for (const [from, to] of target) {
      if (!legacyNodes.includes(from)) continue;
      updNode.run(to, from);
    }
    // node json that names another legacy id
    for (const r of db.prepare("SELECT id, layer, attrs, evidence FROM nodes WHERE attrs LIKE '%:crt/%' OR evidence LIKE '%:crt/%'").all() as Array<{ id: string; layer: string; attrs: string; evidence: string }>) {
      const a = remap(r.attrs)!, e = remap(r.evidence)!;
      if (a !== r.attrs || e !== r.evidence) db.prepare("UPDATE nodes SET attrs = ?, evidence = ? WHERE id = ? AND layer = ?").run(a, e, r.id, r.layer);
    }
    // edges
    for (const r of db.prepare("SELECT from_id, type, to_id, layer, evidence_key, evidence FROM edges WHERE from_id LIKE '%:crt/%' OR to_id LIKE '%:crt/%' OR evidence LIKE '%:crt/%'").all() as Array<{ from_id: string; type: string; to_id: string; layer: string; evidence_key: string; evidence: string }>) {
      const f = target.get(r.from_id) ?? r.from_id, t = target.get(r.to_id) ?? r.to_id, ev = remap(r.evidence)!, ek = remap(r.evidence_key)!;
      if (f === r.from_id && t === r.to_id && ev === r.evidence && ek === r.evidence_key) continue;
      db.prepare("UPDATE edges SET from_id = ?, to_id = ?, evidence = ?, evidence_key = ? WHERE from_id = ? AND type = ? AND to_id = ? AND layer = ? AND evidence_key = ?")
        .run(f, t, ev, ek, r.from_id, r.type, r.to_id, r.layer, r.evidence_key);
      edgesRenamed += 1;
    }
    if (has822) {
      const evTarget = db.prepare("UPDATE evidence SET target_key = ? WHERE target_table = ? AND target_key = ?");
      // claims
      for (const r of db.prepare("SELECT node_id, claim, layer, attrs FROM claims WHERE node_id LIKE '%:crt/%' OR attrs LIKE '%:crt/%'").all() as Array<{ node_id: string; claim: string; layer: string; attrs: string }>) {
        const to = target.get(r.node_id) ?? r.node_id;
        db.prepare("UPDATE claims SET node_id = ?, attrs = ? WHERE node_id = ? AND claim = ? AND layer = ?").run(to, remap(r.attrs), r.node_id, r.claim, r.layer);
        if (to !== r.node_id) evTarget.run(`${to}|${r.claim}`, "claims", `${r.node_id}|${r.claim}`);
      }
      // annotations: the id is a hash of (node, kind, title) and follows the node
      for (const r of db.prepare("SELECT id, node_id, kind, title, attrs FROM annotations WHERE node_id LIKE '%:crt/%' OR attrs LIKE '%:crt/%'").all() as Array<{ id: string; node_id: string | null; kind: string; title: string; attrs: string }>) {
        const to = r.node_id ? target.get(r.node_id) ?? r.node_id : r.node_id;
        const follows = r.node_id !== null && r.id === annotationId(r.node_id, r.kind, r.title);
        const id = follows && to ? annotationId(to, r.kind, r.title) : r.id;
        db.prepare("UPDATE annotations SET id = ?, node_id = ?, attrs = ? WHERE id = ?").run(id, to, remap(r.attrs), r.id);
        if (id !== r.id) {
          evTarget.run(id, "annotations", r.id);
          db.prepare("UPDATE migration_log SET target_id = ? WHERE target_table = 'annotations' AND target_id = ?").run(id, r.id);
        }
      }
      for (const r of db.prepare("SELECT id, node_id, attrs FROM questions WHERE node_id LIKE '%:crt/%' OR attrs LIKE '%:crt/%'").all() as Array<{ id: string; node_id: string | null; attrs: string }>) {
        db.prepare("UPDATE questions SET node_id = ?, attrs = ? WHERE id = ?").run(r.node_id ? target.get(r.node_id) ?? r.node_id : r.node_id, remap(r.attrs), r.id);
      }
      // the evidence rows of the nodes, edges and ledger entries that named a legacy id
      for (const [from, to] of target) {
        evTarget.run(to, "nodes", from);
        db.prepare("UPDATE migration_log SET target_id = ? WHERE target_table = 'nodes' AND target_id = ?").run(to, from);
      }
      for (const r of db.prepare("SELECT target_key FROM evidence WHERE target_table = 'edges' AND target_key LIKE '%:crt/%'").all() as Array<{ target_key: string }>) {
        const k = remap(r.target_key)!;
        if (k !== r.target_key) evTarget.run(k, "edges", r.target_key);
      }
      for (const r of db.prepare("SELECT target_key, attrs FROM evidence WHERE attrs LIKE '%:crt/%'").all() as Array<{ target_key: string; attrs: string }>) {
        db.prepare("UPDATE evidence SET attrs = ? WHERE target_key = ? AND attrs = ?").run(remap(r.attrs), r.target_key, r.attrs);
      }
    }
    // annotation files imported earlier remembered `crt` + bank; the cartridge they were filed under goes with them
    for (const m of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'annotations_imported.%'").all() as Array<{ key: string; value: string }>) {
      try {
        const v = JSON.parse(m.value) as { ctxSpace?: { space?: string; bank?: number; cart?: string }; path?: string };
        if (v.ctxSpace?.space !== "crt" || v.ctxSpace.cart !== undefined) continue;
        const stem = m.key.slice("annotations_imported.".length).replace(/_disasm$/u, "").toLowerCase();
        const fromStem = cartsOfStem(stem);
        const cart = (fromStem.size === 1 ? [...fromStem][0] : undefined) ?? only ?? UNPLACED_CART;
        v.ctxSpace.cart = cart;
        store.setMeta(m.key, JSON.stringify(v));
      } catch { /* a meta row that is not JSON is not ours */ }
    }
    const rederive = carts.flatMap((c) => c.manifestArtifactIds);
    const rowsAfter = Number((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n);
    report = {
      at: new Date().toISOString(), movedNodes: legacyNodes.length, rowsBefore, rowsAfter, edgesRenamed, byCart, unplaced, rederive,
    };
    store.setMeta(CART_MIGRATION_META, JSON.stringify(report));
    store.setMeta(CART_REDERIVE_META, JSON.stringify(rederive));
    store.setMeta("cart_grammar", CART_GRAMMAR);
    store.setMeta("schema_version", String(GRAPH_SCHEMA_VERSION));
  });
  return report;
}

/** What the open of this project did to its cartridge nodes, for the answer that opens it (project_status, agent_onboard). */
export function readCartridgeMigration(projectDir: string): CartridgeMigrationReport | undefined {
  if (!existsSync(graphPath(projectDir))) return undefined;
  const store = GraphStore.open(projectDir, { readOnly: true });
  try {
    const raw = store.getMeta(CART_MIGRATION_META);
    return raw ? JSON.parse(raw) as CartridgeMigrationReport : undefined;
  } catch { return undefined; } finally { store.close(); }
}

export function formatCartridgeMigration(r: CartridgeMigrationReport): string[] {
  const moved = Object.entries(r.byCart).map(([c, n]) => `${n} to ${c}`).join(", ");
  const lines = [`Cartridge nodes moved to the cartridge grammar (${r.at.slice(0, 10)}): ${r.movedNodes} node ids renamed (${moved || "none"}), ${r.edgesRenamed} edges followed; ${r.rowsBefore} node rows before, ${r.rowsAfter} after.`];
  if (r.unplaced.length > 0) {
    lines.push(`  NOT PLACED — nothing says which cartridge they belong to, so they are kept under crt/${UNPLACED_CART}/<bank> and not guessed (${r.unplaced.length}):`);
    for (const u of r.unplaced.slice(0, 40)) lines.push(`    ${u.was}  ->  ${u.now}`);
    if (r.unplaced.length > 40) lines.push(`    … and ${r.unplaced.length - 40} more`);
  }
  return lines;
}
