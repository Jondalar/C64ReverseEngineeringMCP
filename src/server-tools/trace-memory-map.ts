// Spec 753 P3 — `trace_memory_map`: a page memory map reconstructed from the
// trace-store `bus_events` (writes/reads incl. the indirect EAs the
// instruction-decode path can't resolve) + `instructions` (executed = CODE).
//
// BEHAVIOUR capture, NOT grounding (Spec 752 §6): the map answers "what
// runs/writes where, what is free AT RUNTIME on THIS path" — it never claims
// "what a block IS" (that stays the extracted bytes + disasm, L1). The output
// carries a mandatory coverage banner so a hole is never mistaken for a proof.

export interface MemMapPageRow {
  page: number; writes: number; reads: number; mutations: number;
  firstClk: number; lastClk: number; writerPcs: number;
}
export interface MemMapStaticRange { from: number; to: number; label?: string }

export type MemRole = "code" | "code-write" | "data-w" | "data-w-mut" | "data-r" | "untouched";

export interface MemMapPage {
  page: number; role: MemRole;
  writes: number; reads: number; mutations: number; writerPcs: number;
  firstClk: number; lastClk: number;
  staticOccupied: boolean; staticLabel?: string;
  provablyFree: boolean; efLegal: boolean;
}
export interface MemMapRegion {
  fromPage: number; toPage: number; role: MemRole;
  writes: number; reads: number; mutations: number; writerPcs: number;
  staticLabel?: string;
}
export interface MemMapFreeHole { fromPage: number; toPage: number; pages: number; efLegal: boolean }

export interface MemMapResult {
  cpu: string;
  pages: MemMapPage[];           // 256, page 0..255
  regions: MemMapRegion[];
  freeHoles: MemMapFreeHole[];
  staticUntouched: MemMapPage[]; // static-owned but untouched this run (NOT provably free)
  totals: { codePages: number; writtenPages: number; readPages: number; untouchedPages: number; mutatedPages: number; freePages: number };
}

/** EF-legal RAM: $0000-$7FFF or $C000-$CFFF (a resident EAPI / relocated
 *  fastloader / save-overlay cache may only live here on an EasyFlash). */
export function isEfLegalPage(page: number): boolean {
  return page < 0x80 || (page >= 0xc0 && page <= 0xcf);
}

function roleOf(code: boolean, writes: number, reads: number, mutations: number): MemRole {
  if (code && writes > 0) return "code-write";
  if (code) return "code";
  if (writes > 0) return mutations > 0 ? "data-w-mut" : "data-w";
  if (reads > 0) return "data-r";
  return "untouched";
}

export function buildMemoryMap(input: {
  cpu: string;
  pageRows: MemMapPageRow[];
  codePages: Set<number>;
  staticRanges?: MemMapStaticRange[];
}): MemMapResult {
  const byPage = new Map<number, MemMapPageRow>();
  for (const r of input.pageRows) byPage.set(r.page & 0xff, r);
  const statics = input.staticRanges ?? [];
  const staticAt = (page: number): MemMapStaticRange | undefined => {
    const lo = page << 8, hi = lo | 0xff;
    return statics.find((s) => s.from <= hi && s.to >= lo);
  };

  const pages: MemMapPage[] = [];
  for (let p = 0; p < 256; p++) {
    const r = byPage.get(p);
    const writes = r?.writes ?? 0, reads = r?.reads ?? 0, mutations = r?.mutations ?? 0;
    const code = input.codePages.has(p);
    const role = roleOf(code, writes, reads, mutations);
    const st = staticAt(p);
    const untouched = role === "untouched";
    pages.push({
      page: p, role, writes, reads, mutations, writerPcs: r?.writerPcs ?? 0,
      firstClk: r?.firstClk ?? 0, lastClk: r?.lastClk ?? 0,
      staticOccupied: !!st, staticLabel: st?.label,
      provablyFree: untouched && !st, efLegal: isEfLegalPage(p),
    });
  }

  // contiguous runs of same role AND same static owner → regions (split on the
  // static boundary so the `static` column names only the pages it really owns).
  const regions: MemMapRegion[] = [];
  for (let p = 0; p < 256; ) {
    const role = pages[p]!.role; const label = pages[p]!.staticLabel; let q = p;
    let writes = 0, reads = 0, mutations = 0, writerPcs = 0;
    while (q < 256 && pages[q]!.role === role && pages[q]!.staticLabel === label) {
      writes += pages[q]!.writes; reads += pages[q]!.reads; mutations += pages[q]!.mutations;
      writerPcs = Math.max(writerPcs, pages[q]!.writerPcs);
      q++;
    }
    regions.push({ fromPage: p, toPage: q - 1, role, writes, reads, mutations, writerPcs, staticLabel: label });
    p = q;
  }

  // provably-free contiguous runs → free holes
  const freeHoles: MemMapFreeHole[] = [];
  for (let p = 0; p < 256; ) {
    if (!pages[p]!.provablyFree) { p++; continue; }
    let q = p; while (q < 256 && pages[q]!.provablyFree) q++;
    const efLegal = pages.slice(p, q).every((pg) => pg.efLegal);
    freeHoles.push({ fromPage: p, toPage: q - 1, pages: q - p, efLegal });
    p = q;
  }

  const staticUntouched = pages.filter((pg) => pg.staticOccupied && pg.role === "untouched");
  const totals = {
    codePages: pages.filter((p) => p.role === "code" || p.role === "code-write").length,
    writtenPages: pages.filter((p) => p.role === "data-w" || p.role === "data-w-mut" || p.role === "code-write").length,
    readPages: pages.filter((p) => p.role === "data-r").length,
    untouchedPages: pages.filter((p) => p.role === "untouched").length,
    mutatedPages: pages.filter((p) => p.mutations > 0).length,
    freePages: pages.filter((p) => p.provablyFree).length,
  };
  return { cpu: input.cpu, pages, regions, freeHoles, staticUntouched, totals };
}

// --- shared store-query path (tool + finalize sidecar + gate use ONE path) ---

/** `cpu` MUST be a validated literal ('c64' | 'drive8') — callers gate it. */
export function memMapAggSql(cpu: string): string {
  return `SELECT (addr>>8) AS page, ` +
    `COUNT(*) FILTER (WHERE kind='write') AS writes, ` +
    `COUNT(*) FILTER (WHERE kind='read') AS reads, ` +
    `COUNT(*) FILTER (WHERE kind='write' AND old_value IS NOT NULL AND old_value <> value) AS mutations, ` +
    `MIN(clock) AS first_clk, MAX(clock) AS last_clk, ` +
    `COUNT(DISTINCT pc) FILTER (WHERE kind='write') AS writer_pcs ` +
    `FROM bus_events WHERE cpu='${cpu}' AND kind IN ('write','read') AND addr IS NOT NULL GROUP BY page ORDER BY page`;
}
export function memMapCodeSql(cpu: string): string {
  return `SELECT DISTINCT (pc>>8) AS page FROM instructions WHERE cpu='${cpu}' AND pc IS NOT NULL`;
}

export function buildMemoryMapFromQueryRows(
  aggRows: unknown[][], codeRows: unknown[][], opts: { cpu: string; staticRanges?: MemMapStaticRange[] },
): MemMapResult {
  const N = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const pageRows: MemMapPageRow[] = aggRows.map((r) => ({
    page: N(r[0]), writes: N(r[1]), reads: N(r[2]), mutations: N(r[3]),
    firstClk: N(r[4]), lastClk: N(r[5]), writerPcs: N(r[6]),
  }));
  const codePages = new Set<number>(codeRows.map((r) => N(r[0]) & 0xff));
  return buildMemoryMap({ cpu: opts.cpu, pageRows, codePages, staticRanges: opts.staticRanges });
}

/** Build the rendered map text from a store via a query runner (daemon-routed
 *  safeQuery, or a local duckdb conn). Returns null when the trace captured no
 *  memory accesses (no mem-row domain) — callers skip the sidecar / report none. */
export async function buildMemoryMapText(
  runQuery: (sql: string) => Promise<unknown[][]>,
  opts: { cpu?: string; staticRanges?: MemMapStaticRange[]; runLabel?: string } = {},
): Promise<{ text: string; map: MemMapResult } | null> {
  const cpu = opts.cpu ?? "c64";
  const aggRows = await runQuery(memMapAggSql(cpu));
  if (!aggRows || aggRows.length === 0) return null;
  const codeRows = await runQuery(memMapCodeSql(cpu));
  const map = buildMemoryMapFromQueryRows(aggRows, codeRows, { cpu, staticRanges: opts.staticRanges });
  return { text: renderMemoryMap(map, { runLabel: opts.runLabel }), map };
}

const ROLE_CHAR: Record<MemRole, string> = {
  "code": "C", "code-write": "c", "data-w": "W", "data-w-mut": "M", "data-r": "R", "untouched": ".",
};
function pageChar(pg: MemMapPage): string {
  if (pg.role === "untouched") return pg.staticOccupied ? "#" : ".";
  return ROLE_CHAR[pg.role];
}
const hx = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
const pageAddr = (p: number) => "$" + hx(p, 2) + "00";

export function renderMemoryMap(m: MemMapResult, opts: { runLabel?: string } = {}): string {
  const L: string[] = [];
  L.push(`# trace_memory_map — cpu=${m.cpu}${opts.runLabel ? `  run=${opts.runLabel}` : ""}`);
  L.push("");
  L.push("⚠ COVERAGE = THIS RUN ONLY. A trace is ONE path. \"untouched\" ≠ \"free\":");
  L.push("  untested paths (other levels, battles, utils/save) may use a hole. Reconcile");
  L.push("  with the static module load-map / analysis-json before treating a hole as free.");
  L.push("  This is runtime BEHAVIOUR (Spec 753), NOT identity grounding (Spec 752 L1).");
  L.push("");
  L.push(`totals: code=${m.totals.codePages}p  written=${m.totals.writtenPages}p  read-only=${m.totals.readPages}p  ` +
         `untouched=${m.totals.untouchedPages}p  mutated=${m.totals.mutatedPages}p  provably-free=${m.totals.freePages}p`);
  L.push("");
  // ASCII page grid (rows = high nibble, cols = page low byte)
  L.push("page map (each cell = one $XX00 page; C=code c=code+write W=write M=write+mutated R=read-only .=free #=static-owned-untouched):");
  L.push("      " + Array.from({ length: 16 }, (_, c) => hx(c, 1)).join(" "));
  for (let hi = 0; hi < 16; hi++) {
    const cells: string[] = [];
    for (let lo = 0; lo < 16; lo++) cells.push(pageChar(m.pages[(hi << 4) | lo]!));
    L.push(`$${hx(hi, 1)}x00 ${cells.join(" ")}`);
  }
  L.push("");
  // region table
  L.push("regions:");
  L.push("range\trole\tpages\twrites\treads\tmut\twriterPCs\tstatic");
  for (const r of m.regions) {
    const range = `${pageAddr(r.fromPage)}-${"$" + hx(r.toPage, 2) + "FF"}`;
    L.push(`${range}\t${r.role}\t${r.toPage - r.fromPage + 1}\t${r.writes}\t${r.reads}\t${r.mutations}\t${r.writerPcs}\t${r.staticLabel ?? "-"}`);
  }
  L.push("");
  // free holes
  L.push(`free holes (provably free = untouched this run AND not static-occupied) — ${m.freeHoles.length}:`);
  if (m.freeHoles.length === 0) L.push("  (none)");
  for (const h of m.freeHoles) {
    const range = `${pageAddr(h.fromPage)}-${"$" + hx(h.toPage, 2) + "FF"}`;
    L.push(`  ${range}  ${h.pages} page(s)${h.efLegal ? "  [EF-legal RAM]" : ""}`);
  }
  if (m.staticUntouched.length > 0) {
    L.push("");
    L.push(`static-owned but UNTOUCHED this run (NOT provably free — owner may use it on another path):`);
    for (const pg of m.staticUntouched) L.push(`  ${pageAddr(pg.page)}  owner=${pg.staticLabel ?? "?"}`);
  }
  return L.join("\n");
}
