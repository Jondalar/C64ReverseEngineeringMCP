// Spec 804 §4.1 — the three name layers, read from where each one lives.
//
//   user     the graph's HUMAN layer: routines, labels and labelled segments imported
//            from annotation files, data blocks, and user labels (ownerless `addr` nodes)
//   build    the assembler symbol files `assemble_source` registered (role build-symbols)
//   derived  the graph's GENERATED layer: the disassembler's own `W<HEX4>` names
//
// Nothing here is stored: the graph and the symbol files are the stores. A name is either
// bound to a PAYLOAD (it is shown only while that payload is in memory) or names an
// ADDRESS (a user label on an `addr` node, a build equate outside the build's output).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { GraphStore, graphPath } from "../knowledge-graph/store.js";
import type { Relocation } from "./payload-bytes.js";
import { findAnalysisFiles, ownerOfAnalysisFile } from "./payload-bytes.js";
import { parseSymbolFile } from "./sym-file.js";
import type { NameEntry, PayloadRef, RuntimeSpace } from "./types.js";

export const BUILD_SYMBOLS_ROLE = "build-symbols";

export interface NameLayers {
  entries: NameEntry[];
  relocations: Map<string, Relocation[]>;
  crtOwners: Map<number, string[]>;
  /** what was read, for the report */
  sources: { graph: boolean; graphNodes: number; symbolFiles: string[] };
}

interface NodeRow {
  id: string;
  layer: string;
  kind: string;
  space: string;
  owner: string | null;
  bank: number | null;
  run_owner: string | null;
  address: number;
  end_address: number | null;
  name: string | null;
  attrs: string;
}

function runtimeSpaceOf(graphSpace: string): RuntimeSpace {
  return graphSpace === "drv" ? "drive8" : "c64";
}

// The human layer names routines, labels, labelled segments, data blocks and addresses.
// The generated layer contributes only the disassembler's own names (W<HEX4> routines and
// labels, data blocks): its segment and entry nodes carry descriptors like
// `code_1000_1008`, which say what a range IS, not what it is called.
const HUMAN_KINDS = ["routine", "label", "segment", "data_block", "addr"];
const DERIVED_KINDS = ["routine", "label", "data_block"];
const NAMED_KINDS = [...new Set([...HUMAN_KINDS, ...DERIVED_KINDS])];

function readGraph(projectDir: string, out: NameLayers): void {
  if (!existsSync(graphPath(projectDir))) return;
  let store: GraphStore;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return; }
  try {
    out.sources.graph = true;
    const rows = store.db.prepare(
      `SELECT id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs FROM nodes
       WHERE name IS NOT NULL AND name <> '' AND kind IN (${NAMED_KINDS.map(() => "?").join(",")})
       ORDER BY address, layer, id`,
    ).all(...NAMED_KINDS) as unknown as NodeRow[];
    out.sources.graphNodes = rows.length;
    for (const r of rows) {
      if (!(r.layer === "human" ? HUMAN_KINDS : DERIVED_KINDS).includes(r.kind)) continue;
      let payload: PayloadRef | null = null;
      if (r.kind !== "addr") {
        if (r.space === "crt" && r.bank !== null) payload = { kind: "crt", bank: r.bank };
        else if (r.owner) payload = { kind: "analysis", owner: r.owner };
      }
      let segmentKind: string | undefined;
      if (r.kind === "segment") {
        try { segmentKind = (JSON.parse(r.attrs) as { segment_kind?: string }).segment_kind; } catch { segmentKind = undefined; }
      }
      const endAddress = r.end_address !== null && r.end_address > r.address ? r.end_address : null;
      out.entries.push({
        name: r.name!,
        origin: r.layer === "human" ? "user" : "derived",
        space: runtimeSpaceOf(r.space),
        address: r.address,
        endAddress,
        kind: r.kind,
        // A range is CODE (a routine's extent, a code segment) or DATA (a table, a
        // data segment). A listing names data by containment, code only exactly.
        range: endAddress === null ? null : (r.kind === "data_block" || (r.kind === "segment" && segmentKind !== undefined && segmentKind !== "code")) ? "data" : "code",
        payload,
        bank: r.space === "crt" ? r.bank : null,
        source: r.id,
      });
    }
    // Spec 842 D4 — where a payload's bytes are stored vs where they run.
    const relocRows = store.db.prepare(
      "SELECT DISTINCT owner, attrs FROM nodes WHERE owner IS NOT NULL AND attrs LIKE '%relocated_from%'",
    ).all() as unknown as Array<{ owner: string; attrs: string }>;
    for (const row of relocRows) {
      let attrs: { relocated_from?: { file_start?: number; file_end?: number; runtime_addr?: number } };
      try { attrs = JSON.parse(row.attrs); } catch { continue; }
      const r = attrs.relocated_from;
      if (!r || typeof r.file_start !== "number" || typeof r.file_end !== "number" || typeof r.runtime_addr !== "number") continue;
      const list = out.relocations.get(row.owner) ?? [];
      if (!list.some((w) => w.fileStart === r.file_start && w.runtimeAddr === r.runtime_addr)) {
        list.push({ fileStart: r.file_start, fileEnd: r.file_end, runtimeAddr: r.runtime_addr });
      }
      out.relocations.set(row.owner, list);
    }
    // A cartridge bank's code comes from every analysis seeded into it.
    const crtRows = store.db.prepare(
      "SELECT DISTINCT bank, run_owner FROM nodes WHERE space = 'crt' AND bank IS NOT NULL AND run_owner IS NOT NULL",
    ).all() as unknown as Array<{ bank: number; run_owner: string }>;
    for (const row of crtRows) {
      const list = out.crtOwners.get(row.bank) ?? [];
      if (!list.includes(row.run_owner)) list.push(row.run_owner);
      out.crtOwners.set(row.bank, list);
    }
  } finally {
    store.close();
  }
}

/** The PRG a symbol file belongs to: `<stem>.vs` / `<stem>.sym` ↔ `<stem>.prg`. */
export function buildOutputFor(symbolPath: string): string {
  const stem = symbolPath.slice(0, symbolPath.length - extname(symbolPath).length);
  return `${stem}.prg`;
}

function readBuilds(projectDir: string, out: NameLayers): void {
  // Read-only on purpose: resolving a name must never create or migrate a project, so
  // this reads the artifact store rather than opening the knowledge service (whose
  // constructor prepares the project structure).
  const store = join(projectDir, "knowledge", "artifacts.json");
  if (!existsSync(store)) return;
  let artifacts: Array<{ path: string; role?: string }> = [];
  try {
    const parsed = JSON.parse(readFileSync(store, "utf8")) as { items?: Array<{ path: string; role?: string }> };
    artifacts = parsed.items ?? [];
  } catch { return; }
  const analyses = findAnalysisFiles(projectDir);
  for (const a of artifacts) {
    if (a.role !== BUILD_SYMBOLS_ROLE) continue;
    const path = resolve(projectDir, a.path);
    if (!existsSync(path)) continue;
    out.sources.symbolFiles.push(path);
    const prg = buildOutputFor(path);
    let range: { lo: number; hi: number } | undefined;
    if (existsSync(prg)) {
      const buf = readFileSync(prg);
      if (buf.length >= 3) {
        const lo = buf[0]! | (buf[1]! << 8);
        range = { lo, hi: lo + buf.length - 3 };
      }
    }
    // An analysed build output is compared by its code bytes; otherwise by its bytes.
    const owner = ownerOfAnalysisFile(join(dirname(prg), `${basename(prg).replace(/\.prg$/iu, "")}_analysis.json`));
    const payloadRef: PayloadRef | null = range
      ? (analyses.has(owner) ? { kind: "analysis", owner } : { kind: "prg", path: prg })
      : null;
    for (const s of parseSymbolFile(readFileSync(path, "utf8"))) {
      const inside = range !== undefined && s.space === "c64" && s.address >= range.lo && s.address <= range.hi;
      out.entries.push({
        name: s.name,
        origin: "build",
        space: s.space,
        address: s.address,
        endAddress: null,
        kind: "symbol",
        range: null,
        payload: inside ? payloadRef : null,
        bank: null,
        source: path,
      });
    }
  }
}

export function loadNameLayers(projectDir: string): NameLayers {
  const out: NameLayers = {
    entries: [],
    relocations: new Map(),
    crtOwners: new Map(),
    sources: { graph: false, graphNodes: 0, symbolFiles: [] },
  };
  readGraph(projectDir, out);
  readBuilds(projectDir, out);
  return out;
}
