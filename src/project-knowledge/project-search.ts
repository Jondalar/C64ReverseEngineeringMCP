// Spec 740.1 — Project Wiki + Knowledge Retrieval MVP; Spec 740.3 — the search sees the graph.
//
// A deterministic, project-local search index over the curated wiki (every Markdown file
// in every `docs/` directory, found by Spec 847's scanner, plus CLAUDE.md and
// knowledge/notes.md), the structured knowledge (findings / entities / relations / open
// questions from the graph — Spec 822 D10 — and the graph's HUMAN layer: the routines and
// labels annotation files and the doors named, the model's boundaries and the declared
// documents — 740.3 D1), flows / artifacts / artifact-versions from JSON, selected views,
// and ASM/TASS section headers. NO embeddings, NO vector DB, NO network. The cache is a
// navigation aid; the raw sources stay authoritative.
//
// The index indexes SMALL records (markdown sections, one record per structured item, ASM
// section headers) — never whole large files as a single blob, and never raw disk/cart
// bytes or raw *_analysis.json. The generated layer of the graph is NOT read beyond what
// the record projection already carries: those are the thousands of mechanical nodes
// `graph_find` serves, and this index holds what someone learned.
//
// 740.3 D4 — the cache knows when it is old. It records a fingerprint of what it read
// (graph.sqlite and its -wal, every document, every listing, every JSON store and view);
// the read path compares before answering and rebuilds on a mismatch, saying so.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, type Dirent } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { ensureCutover } from "../knowledge-graph/cutover.js";
import { KnowledgeRecords, GraphStore } from "../knowledge-graph/records.js";
import { scanDocs, listDocFiles, type ScannedDoc } from "../docs/scan.js";
import { parseFrontmatter, type Frontmatter } from "../docs/frontmatter.js";
import { readDocNodes } from "../docs/register.js";
import { liveRenderCounts, renderDrift, formatRenderDrift, type RenderCounts } from "../docs/render-drift.js";
import { readBoundaries } from "../model/store.js";

export type ProjectSearchKind =
  | "finding" | "open_question" | "entity" | "relation" | "flow"
  | "artifact" | "artifact_version" | "doc_section" | "wiki_page"
  | "activity_log_entry" | "asm_section" | "view" | "trace_mark"
  // 740.3 D1 — the human layer of the graph, each under its own kind.
  | "routine" | "label" | "model" | "document";

/** The kinds whose address range is a DECLARATION of extent — a query address inside it counts. */
const RANGE_KINDS = new Set<string>(["model", "document", "routine"]);

export interface ProjectSearchRecord {
  id: string;
  kind: ProjectSearchKind;
  title: string;
  summary: string;
  snippet: string;
  tags: string[];
  addressRange?: { start: number; end: number };
  /** Every range the record covers when there is more than one (a document's `covers`). */
  ranges?: Array<{ start: number; end: number }>;
  artifactIds: string[];
  entityIds: string[];
  relationIds: string[];
  sourcePath: string;
  sourceAnchor?: string;
  updatedAt?: string;
  rankHints?: {
    curated?: boolean;
    currentArtifactVersion?: boolean;
    manual?: boolean;
    generated?: boolean;
    internal?: boolean;
    stale?: boolean;
  };
  /** Said in every hit's `why` — why this record ranks where it does (a stale render's drift). */
  caveats?: string[];
  // Derived, kept in the cache so search is pure string work.
  addrTokens: string[]; // normalized "$fc00"→"fc00", "T18/S11"→"t18/s11", "track 36"→"track 36"
}

export interface ProjectSearchIndex {
  version: number;
  builtAt?: string;
  projectDir: string;
  counts: Record<string, number>;
  sourcesRead: string[];
  warnings: string[];
  /** 740.3 D4 — what the index read, as `size:mtimeMs` per project-relative path. */
  fingerprint?: Record<string, string>;
  records: ProjectSearchRecord[];
}

/** 2 = Spec 740.3: the human layer, documents at any depth, renders as copies, a fingerprint. */
export const PROJECT_SEARCH_INDEX_VERSION = 2;
export const CACHE_RELPATH = join("knowledge", ".cache", "project-search-index.json");
const GRAPH = join("knowledge", "graph.sqlite");
const GRAPH_WAL = `${GRAPH}-wal`;

// ── token / address helpers ────────────────────────────────────────────────

const HEX_RE = /\$([0-9a-fA-F]{2,4})\b/g;
const TS_RE = /\bT(\d{1,2})\s*\/?\s*S(\d{1,2})\b/gi;
const TRACK_RE = /\btrack\s+(\d{1,2})\b/gi;

export function extractAddrTokens(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(text)) !== null) out.add(m[1].toLowerCase());
  TS_RE.lastIndex = 0;
  while ((m = TS_RE.exec(text)) !== null) { out.add(`t${m[1]}/s${m[2]}`.toLowerCase()); out.add(`track ${m[1]}`); }
  TRACK_RE.lastIndex = 0;
  while ((m = TRACK_RE.exec(text)) !== null) out.add(`track ${m[1]}`);
  return Array.from(out);
}

/** The hex address tokens of a query as numbers ("fc00" → 0xFC00); track/sector tokens are not addresses. */
function numericAddrs(tokens: string[]): number[] {
  return tokens.filter((t) => /^[0-9a-f]{2,4}$/.test(t)).map((t) => parseInt(t, 16));
}

function firstAddressRange(text: string): { start: number; end: number } | undefined {
  const range = text.match(/\$([0-9a-fA-F]{2,4})\s*[-–]\s*\$([0-9a-fA-F]{2,4})/);
  if (range) return { start: parseInt(range[1], 16), end: parseInt(range[2], 16) };
  const single = text.match(/\$([0-9a-fA-F]{2,4})\b/);
  if (single) { const v = parseInt(single[1], 16); return { start: v, end: v }; }
  return undefined;
}

const STOP = new Set(["the", "a", "an", "is", "are", "of", "in", "to", "and", "or", "for", "where", "which", "what", "does", "do", "on", "at", "by", "with", "from"]);
export function queryTokens(q: string): string[] {
  return q.toLowerCase().replace(/[^a-z0-9$/_-]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

function clip(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

const hex4 = (n: number): string => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
const fmtRange = (r: { start: number; end: number }): string => (r.start === r.end ? hex4(r.start) : `${hex4(r.start)}-${hex4(r.end)}`);
const uniqStrings = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))];

// ── source readers ─────────────────────────────────────────────────────────

function readJsonStore(path: string): any[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

function addrRangeOf(rec: any): { start: number; end: number } | undefined {
  if (rec?.addressRange && typeof rec.addressRange.start === "number") return { start: rec.addressRange.start, end: rec.addressRange.end ?? rec.addressRange.start };
  const ev = Array.isArray(rec?.evidence) ? rec.evidence.find((e: any) => e?.addressRange) : undefined;
  if (ev?.addressRange && typeof ev.addressRange.start === "number") return { start: ev.addressRange.start, end: ev.addressRange.end ?? ev.addressRange.start };
  return undefined;
}

function tokensForRecord(title: string, summary: string, snippet: string, addr?: { start: number; end: number }): string[] {
  const toks = extractAddrTokens(`${title} ${summary} ${snippet}`);
  if (addr) { toks.push(addr.start.toString(16)); if (addr.end !== addr.start) toks.push(addr.end.toString(16)); }
  return Array.from(new Set(toks));
}

interface MarkdownOptions {
  kind: ProjectSearchKind;
  rankHints: NonNullable<ProjectSearchRecord["rankHints"]>;
  /** The document's own declaration (847), when it has one. */
  frontmatter?: Frontmatter;
  caveats?: string[];
}

// Markdown → section records. Splits on # … #### headings. A declared document (740.3
// D2) indexes its sections under its declared title, carries its `covers`, and never
// indexes its frontmatter block as prose.
function indexMarkdown(absPath: string, relPath: string, opts: MarkdownOptions): ProjectSearchRecord[] {
  // parseFrontmatter normalises CRLF: a doc written on Windows ends its lines in \r\n,
  // and `(.*)$` below cannot match across the \r — every heading would vanish into one
  // section. Its body is the text with any `---` block removed.
  const text = parseFrontmatter(readFileSync(absPath, "utf8")).body;
  const lines = text.split(/\r?\n/);
  const fm = opts.frontmatter;
  const docTitle = fm?.title ?? basename(relPath);
  const covers = (fm?.covers ?? []).filter((c): c is { kind: "range"; start: number; end: number } => c.kind === "range")
    .map((c) => ({ start: c.start, end: c.end }));
  const tags = uniqStrings([...tagsFromPath(relPath), ...(fm ? ["document", fm.kind] : [])]);
  const out: ProjectSearchRecord[] = [];
  const slugs = new Map<string, number>();
  let heading = docTitle;
  let bodyLines: string[] = [];
  const flush = () => {
    if (!heading && bodyLines.length === 0) return;
    const body = bodyLines.join("\n").trim();
    if (!heading && !body) return;
    const own = firstAddressRange(`${heading} ${body}`);
    // A section with neither text nor an address of its own says nothing — the covers
    // fallback below must not keep an empty lead-in alive.
    if (!body && !own) return;
    const base = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "section";
    // A declared title is usually also the first heading; two sections, one id, would
    // make one of them unreachable by id. The first keeps the bare slug.
    const seen = slugs.get(base) ?? 0;
    slugs.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen + 1}`;
    const title = heading === docTitle ? docTitle : `${docTitle} — ${heading}`;
    const summary = clip(body, 160);
    const snippet = clip(body, 240);
    out.push({
      id: `doc:${relPath}#${slug}`,
      kind: opts.kind, title, summary, snippet,
      tags,
      addressRange: own ?? covers[0],
      ...(covers.length > 0 ? { ranges: covers } : {}),
      artifactIds: [], entityIds: [], relationIds: [],
      sourcePath: relPath, sourceAnchor: heading,
      rankHints: { ...opts.rankHints },
      ...(opts.caveats && opts.caveats.length > 0 ? { caveats: opts.caveats } : {}),
      addrTokens: tokensForRecord(heading, body, "", own),
    });
  };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); bodyLines = []; }
    else bodyLines.push(line);
  }
  flush();
  return out.filter((r) => r.summary.length > 0 || r.addressRange);
}

function tagsFromPath(relPath: string): string[] {
  const base = basename(relPath, extname(relPath)).toLowerCase();
  const tags = [base.replace(/[^a-z0-9]+/g, "-")];
  if (/loader/.test(base)) tags.push("loader");
  if (/cartograph|cart/.test(base)) tags.push("cartography");
  if (/disk/.test(base)) tags.push("disk");
  if (/sequence|swimlane|flow/.test(base)) tags.push("flow");
  if (/glossary/.test(base)) tags.push("glossary");
  return Array.from(new Set(tags));
}

// activity-log.md → one record per "## [ISO] kind | title" entry.
function indexActivityLog(absPath: string, relPath: string): ProjectSearchRecord[] {
  const text = readFileSync(absPath, "utf8");
  const out: ProjectSearchRecord[] = [];
  const re = /^##\s*\[([^\]]+)\]\s*([^|]+?)\s*\|\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [_, ts, kind, title] = m;
    out.push({
      id: `activity:${ts.trim()}:${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      kind: "activity_log_entry",
      title: `${kind.trim()} | ${title.trim()}`,
      summary: title.trim(), snippet: clip(title.trim(), 200),
      tags: [kind.trim().toLowerCase()],
      artifactIds: [], entityIds: [], relationIds: [],
      sourcePath: relPath, updatedAt: ts.trim(),
      rankHints: { curated: true },
      addrTokens: extractAddrTokens(title),
    });
  }
  return out;
}

// ASM/TASS → section headers / labels-with-comments. NOT the whole file.
function indexAsm(absPath: string, relPath: string): ProjectSearchRecord[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/); // a hand-edited listing may be CRLF; the comment match anchors on $
  const out: ProjectSearchRecord[] = [];
  const CAP = 40;
  for (let i = 0; i < lines.length && out.length < CAP; i++) {
    const line = lines[i];
    const pc = line.match(/^\s*(?:\.pc\s*=|\*\s*=|\.pseudopc|\.logical)\s*(\$[0-9a-fA-F]+)/);
    const lbl = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/);
    const comment = line.match(/^\s*(?:\/\/|;)\s*(.{6,})$/);
    if (!pc && !lbl && !comment) continue;
    // attach the trailing comment on the same/adjacent line as context
    const ctx = (line.replace(/^[^/;]*(\/\/|;)/, "$1").trim()) || (lines[i + 1] || "").trim();
    const title = pc ? `${basename(relPath)} @ ${pc[1]}` : lbl ? `${basename(relPath)}: ${lbl[1]}` : `${basename(relPath)} — note`;
    const addr = firstAddressRange(line);
    const summary = clip(`${line.trim()} ${ctx}`, 160);
    out.push({
      id: `asm:${relPath}:${i + 1}`,
      kind: "asm_section",
      title, summary, snippet: clip(line.trim(), 200),
      tags: ["asm", basename(relPath, extname(relPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-")],
      addressRange: addr,
      artifactIds: [], entityIds: [], relationIds: [],
      sourcePath: relPath, sourceAnchor: `L${i + 1}`,
      rankHints: { curated: /semantic|curated|final/.test(relPath) },
      addrTokens: tokensForRecord(title, summary, "", addr),
    });
  }
  return out;
}

// views/*.json → small records (memory-map regions, disk files, flow nodes).
function indexView(absPath: string, relPath: string): ProjectSearchRecord[] {
  const out: ProjectSearchRecord[] = [];
  let view: any;
  try { view = JSON.parse(readFileSync(absPath, "utf8")); } catch { return out; }
  const push = (id: string, title: string, summary: string, addr: any, entityIds: string[], tags: string[]) => {
    const a = (typeof addr?.start === "number") ? { start: addr.start, end: addr.end ?? addr.start } : undefined;
    out.push({
      id, kind: "view", title, summary: clip(summary, 160), snippet: clip(summary, 200),
      tags, addressRange: a, artifactIds: [], entityIds, relationIds: [],
      sourcePath: relPath, rankHints: { generated: true }, addrTokens: tokensForRecord(title, summary, "", a),
    });
  };
  for (const r of (view.regions ?? []).slice(0, 200)) {
    push(`view:region:${r.id ?? r.start}`, `region ${r.title ?? r.kind ?? "?"}`, r.summary ?? r.title ?? "", { start: r.start, end: r.end }, r.entityId ? [r.entityId] : [], ["memory-map", r.kind].filter(Boolean));
  }
  for (const f of (view.files ?? (view.disks?.flatMap?.((d: any) => d.files ?? []) ?? [])).slice(0, 300)) {
    const ts = (typeof f.track === "number" && typeof f.sector === "number") ? ` T${f.track}/S${f.sector}` : "";
    push(`view:file:${f.id ?? f.title}`, `disk file ${f.title ?? f.id}${ts}`, `${f.title ?? ""} ${f.notes ?? f.loaderHint ?? ""}${ts}`, f.loadAddress != null ? { start: f.loadAddress } : undefined, f.entityId ? [f.entityId] : [], ["disk", f.type].filter(Boolean));
  }
  for (const n of (view.nodes ?? []).slice(0, 200)) {
    push(`view:node:${n.id}`, `flow ${n.title ?? n.label ?? n.id}`, n.summary ?? n.title ?? n.label ?? "", undefined, n.entityId ? [n.entityId] : [], ["flow"]);
  }
  return out;
}

// ── structured store → records ──────────────────────────────────────────────

function strip(s: string): string {
  return s.replace(/\.(asm|tas|tass|prg|d64|g64|crt|sym|json|md)$/i, "").replace(/_(disasm|semantic|notes|curated|final|src|source)$/i, "");
}
export function subjectStem(pathOrTitle: string): string { return strip(basename(pathOrTitle || "")); }

// ── what the index reads (shared by the build and the fingerprint) ────────────

/** Single files the index reads when they exist. Documents under `docs/` come from the scanner. */
const FIXED_SOURCES = [
  "CLAUDE.md",
  join("knowledge", "notes.md"),
  join("knowledge", "activity-log.md"),
  join("knowledge", "artifact-versions.json"),
  join("knowledge", "flows.json"),
  join("knowledge", "artifacts.json"),
];

function listViews(root: string): string[] {
  const viewsDir = join(root, "views");
  if (!existsSync(viewsDir)) return [];
  try { return readdirSync(viewsDir).filter((f) => f.endsWith(".json")).map((f) => join("views", f)); } catch { return []; }
}

/** 740.3 D5 — one listing per disassembly, from the artifact and analysis trees. */
function listListings(root: string): string[] {
  const out: string[] = [];
  for (const dir of ["artifacts", "analysis"]) walkAsm(join(root, dir), root, (relPath) => out.push(relPath));
  return out;
}

const LISTING_PREFERENCE = ["asm", "tas", "tass"];

/**
 * The renderer writes `.asm` (KickAssembler) beside `.tas` (64tass) since 2026-09-06, and
 * `.tass` before that. Both dialects of one disassembly are the same listing; indexing
 * both doubled every hit in an old project and skipped `.tas` in a new one. So per
 * directory and stem: `.asm` when present, else `.tas`, else `.tass`.
 */
function walkAsm(dir: string, root: string, onFile: (relPath: string) => void, depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const byStem = new Map<string, Map<string, string>>(); // stem → ext → file name
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { isDir = statSync(abs).isDirectory(); } catch { continue; } }
    if (isDir) { walkAsm(abs, root, onFile, depth + 1); continue; }
    const m = /^(.*)\.(asm|tas|tass)$/i.exec(entry.name);
    if (!m) continue;
    const exts = byStem.get(m[1]) ?? new Map<string, string>();
    exts.set(m[2].toLowerCase(), entry.name);
    byStem.set(m[1], exts);
  }
  let asmCount = 0;
  for (const exts of byStem.values()) {
    if (asmCount >= 200) break;
    const ext = LISTING_PREFERENCE.find((e) => exts.has(e));
    if (!ext) continue;
    asmCount++;
    onFile(relative(root, join(dir, exts.get(ext)!)));
  }
}

/**
 * 740.3 D4 — what the index read, stamped `size:mtimeMs` per project-relative path: the
 * graph and its write-ahead log, every document the scanner finds, every listing, every
 * JSON store and view. Only `stat` — the check runs on every search, so it must cost
 * nothing near a rebuild. An empty `-wal` is absent: it comes and goes as readers open
 * the graph and says nothing about its content.
 */
export function computeIndexFingerprint(projectDir: string): Record<string, string> {
  const fp: Record<string, string> = {};
  const stamp = (rel: string, skipEmpty = false) => {
    try {
      const st = statSync(join(projectDir, rel));
      if (!st.isFile() || (skipEmpty && st.size === 0)) return;
      fp[rel] = `${st.size}:${st.mtimeMs}`;
    } catch { /* absent — absence is the missing key */ }
  };
  stamp(GRAPH);
  stamp(GRAPH_WAL, true);
  for (const abs of listDocFiles(projectDir)) stamp(relative(projectDir, abs));
  for (const rel of FIXED_SOURCES) stamp(rel);
  for (const rel of listViews(projectDir)) stamp(rel);
  for (const rel of listListings(projectDir)) stamp(rel);
  return fp;
}

/** What changed between two fingerprints, in words — undefined when nothing did. */
export function describeFingerprintChange(before: Record<string, string>, after: Record<string, string>): string | undefined {
  let graph = false, docs = 0, listings = 0, other = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (key === GRAPH || key === GRAPH_WAL) graph = true;
    else if (/\.md$/i.test(key)) docs++;
    else if (/\.(asm|tas|tass)$/i.test(key)) listings++;
    else other++;
  }
  const parts: string[] = [];
  if (graph) parts.push("the graph");
  if (docs) parts.push(`${docs} document${docs === 1 ? "" : "s"}`);
  if (listings) parts.push(`${listings} listing${listings === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} knowledge file${other === 1 ? "" : "s"}`);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ── the human layer of the graph (740.3 D1) ─────────────────────────────────────

interface HumanLayer {
  routines: ProjectSearchRecord[];
  labels: ProjectSearchRecord[];
  models: ProjectSearchRecord[];
  documents: ProjectSearchRecord[];
}

/**
 * Routines, labels, model boundaries and documents — each a record of its own kind.
 *
 * They were not invisible before 740.3: the entity projection (822.2) lists every
 * human-layer node, so a routine the session named came back as an `entity` — ranked
 * as one, with no extent, a container and a document placed at $0000 (their ranges live
 * in attrs), and a named data table three times over (label, segment, data block). The
 * ids produced here are withheld from the entity projection, and what the entity record
 * knew (artifacts, tags, summary) is folded into the new record rather than lost.
 */
function readHumanLayer(
  root: string,
  graph: KnowledgeRecords,
  entityById: Map<string, any>,
  scannedByPath: Map<string, ScannedDoc>,
  live: RenderCounts,
  warnings: string[],
): HumanLayer {
  const out: HumanLayer = { routines: [], labels: [], models: [], documents: [] };
  const seen = new Set<string>();
  const entityBits = (id: string) => {
    const e = entityById.get(id);
    return {
      artifactIds: (e?.artifactIds ?? []) as string[],
      tags: (e?.tags ?? []) as string[],
      summary: typeof e?.summary === "string" ? e.summary as string : "",
      updatedAt: e?.updatedAt as string | undefined,
    };
  };
  const record = (
    kind: ProjectSearchKind, id: string, title: string, summary: string,
    range: { start: number; end: number } | undefined, extra: Partial<ProjectSearchRecord> = {},
  ): ProjectSearchRecord => ({
    id, kind, title,
    summary: clip(summary, 400),
    snippet: clip(summary, 240),
    tags: extra.tags ?? [],
    addressRange: range,
    artifactIds: extra.artifactIds ?? [],
    entityIds: extra.entityIds ?? [id],
    relationIds: [],
    sourcePath: extra.sourcePath ?? GRAPH,
    updatedAt: extra.updatedAt,
    rankHints: extra.rankHints ?? { manual: true },
    ...(extra.ranges ? { ranges: extra.ranges } : {}),
    ...(extra.caveats && extra.caveats.length > 0 ? { caveats: extra.caveats } : {}),
    addrTokens: tokensForRecord(title, summary, "", range),
  });

  let store: GraphStore | undefined;
  if (existsSync(join(root, GRAPH))) {
    try { store = GraphStore.open(root, { readOnly: true }); } catch (e) { warnings.push(`${GRAPH} (human layer): ${e instanceof Error ? e.message : String(e)}`); }
  }
  try {
    // ---- routines: the annotation files' and the door's, with the derived extent
    const comments = new Map<string, string>();
    if (store) {
      try {
        const rows = store.db.prepare(
          "SELECT node_id, body FROM annotations WHERE kind = 'routine' AND node_id IS NOT NULL AND body IS NOT NULL ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, updated_at DESC",
        ).all() as Array<{ node_id: string; body: string }>;
        for (const r of rows) if (!comments.has(r.node_id)) comments.set(r.node_id, r.body);
      } catch { /* a graph without the 822 prose table: no comments, not an error */ }
    }
    try {
      for (const r of graph.listRoutineNodes()) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const e = entityBits(r.id);
        const range = { start: r.address, end: r.endAddress ?? r.address };
        const name = r.name ?? `routine_${hex4(r.address).slice(1)}`;
        const comment = comments.get(r.id) ?? e.summary;
        out.routines.push(record("routine", r.id, name,
          `routine ${fmtRange(range)}${r.owner ? ` in ${r.owner}` : ""}${comment ? ` — ${comment}` : ""}`, range,
          { tags: uniqStrings(["routine", r.owner, ...e.tags]), artifactIds: e.artifactIds, sourcePath: r.sourcePath ?? GRAPH, updatedAt: e.updatedAt }));
      }
    } catch (err) { warnings.push(`${GRAPH} (routines): ${err instanceof Error ? err.message : String(err)}`); }

    // ---- labels: the annotation files' label nodes, then the user labels folded in
    if (store) {
      try {
        const rows = store.db.prepare(
          "SELECT id, name, address, end_address, owner, attrs FROM nodes WHERE layer = 'human' AND kind = 'label' ORDER BY address, id",
        ).all() as Array<{ id: string; name: string | null; address: number; end_address: number | null; owner: string | null; attrs: string }>;
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          let a: Record<string, unknown> = {};
          try { a = JSON.parse(r.attrs) as Record<string, unknown>; } catch { /* keep empty */ }
          const e = entityBits(r.id);
          const range = { start: r.address, end: r.end_address ?? r.address };
          const name = r.name ?? `L${hex4(r.address).slice(1)}`;
          const note = (typeof a.comment === "string" ? a.comment : typeof a.note === "string" ? a.note : "") || e.summary;
          out.labels.push(record("label", r.id, name,
            `label ${fmtRange(range)}${r.owner ? ` in ${r.owner}` : ""}${note ? ` — ${note}` : ""}`, range,
            { tags: uniqStrings(["label", r.owner, ...e.tags]), artifactIds: e.artifactIds, sourcePath: typeof a.source_path === "string" ? a.source_path : GRAPH, updatedAt: e.updatedAt }));
        }
      } catch (err) { warnings.push(`${GRAPH} (labels): ${err instanceof Error ? err.message : String(err)}`); }
    }
    try {
      for (const l of graph.listUserLabels()) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        const e = entityBits(l.id);
        const range = l.addressRange ? { start: l.addressRange.start, end: l.addressRange.end ?? l.addressRange.start } : undefined;
        out.labels.push(record("label", l.id, l.label,
          `user label${range ? ` ${fmtRange(range)}` : ` on ${l.targetKind}${l.targetId ? ` ${l.targetId}` : ""}`}${l.note ? ` — ${l.note}` : ""}`, range,
          { tags: uniqStrings(["label", "user-label", ...e.tags]), artifactIds: e.artifactIds, updatedAt: l.updatedAt }));
      }
    } catch (err) { warnings.push(`${GRAPH} (user labels): ${err instanceof Error ? err.message : String(err)}`); }

    if (store) {
      // ---- the model: a boundary's range lives in attrs, not in the node's address
      try {
        for (const b of readBoundaries(store.db)) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          const range = { start: b.start, end: b.end };
          const where = `${b.space !== "ram" ? `${b.space} ` : ""}${fmtRange(range)}${b.owner ? ` in ${b.owner}` : ""}${b.bank !== null ? ` bank ${b.bank}` : ""}`;
          out.models.push(record("model", b.id, b.name,
            `${b.level} ${where} — ${b.description}${b.evidence.length ? ` (evidence: ${b.evidence.join("; ")})` : ""}`, range,
            { tags: uniqStrings(["model", b.level, b.owner]) }));
        }
      } catch (err) { warnings.push(`${GRAPH} (model): ${err instanceof Error ? err.message : String(err)}`); }

      // ---- documents: the declaration, its coverage, and what kind of document it is
      try {
        for (const d of readDocNodes(store.db)) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          const ranges = d.covers.filter((c) => c.kind === "range" && typeof c.start === "number")
            .map((c) => ({ start: c.start!, end: c.end ?? c.start! }));
          const refs = d.covers.filter((c) => c.kind === "artifact" && c.ref).map((c) => c.ref!);
          const coverText = [...ranges.map(fmtRange), ...refs.map((r) => `artifact:${r}`)].join(", ");
          const caveats: string[] = [];
          let rankHints: NonNullable<ProjectSearchRecord["rankHints"]> = { curated: true };
          if (d.placeholder) { rankHints = { stale: true }; caveats.push("placeholder: cited by another document, not in this project"); }
          else if (d.status === "superseded") { rankHints = { curated: true, stale: true }; caveats.push("superseded document"); }
          if (d.docKind === "generated") {
            rankHints = { ...rankHints, curated: false, generated: true };
            const g = scannedByPath.get(d.path)?.frontmatter?.generated;
            const drift = g ? renderDrift(g, live) : [];
            if (drift.length > 0) { rankHints.stale = true; caveats.push(`stale render: ${formatRenderDrift(drift, g!.at)}`); }
            else caveats.push("generated render — a copy of the graph");
          }
          out.documents.push(record("document", d.id, d.title,
            `${d.docKind} document ${d.path}, ${d.status}${coverText ? `; covers ${coverText}` : ""}${d.method ? `; method: ${d.method}` : ""}`,
            ranges[0],
            { tags: uniqStrings(["document", d.docKind, d.status, d.placeholder ? "placeholder" : undefined, ...refs.map((r) => r.toLowerCase())]),
              sourcePath: d.path, rankHints, caveats, ...(ranges.length > 1 ? { ranges } : {}) }));
        }
      } catch (err) { warnings.push(`${GRAPH} (documents): ${err instanceof Error ? err.message : String(err)}`); }
    }
  } finally {
    store?.close();
  }
  return out;
}

// ── index builder ────────────────────────────────────────────────────────────

export function buildProjectSearchIndex(projectDir: string): ProjectSearchIndex {
  const records: ProjectSearchRecord[] = [];
  const sourcesRead: string[] = [];
  const warnings: string[] = [];
  const root = projectDir;

  const tryRead = (relPath: string, fn: (abs: string, rel: string) => ProjectSearchRecord[]) => {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return;
    try { const recs = fn(abs, relPath); records.push(...recs); sourcesRead.push(relPath); }
    catch (e) { warnings.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // 1) the graph. Read first: a render's staleness (D3) is measured against it.
  //
  // Spec 822 D10 — findings, open questions, entities and relations are read from the
  // graph (knowledge/graph.sqlite), projected into the record shape this index has always
  // taken; human rows rank `manual`, generated rows `generated`. A project still carrying
  // the legacy JSON is cut over first (Spec 822.2).
  try { ensureCutover(root); } catch (e) { warnings.push(`${GRAPH}: cut-over failed: ${e instanceof Error ? e.message : String(e)}`); }
  const graph = new KnowledgeRecords(root);
  const listOf = <T>(what: string, fn: () => T[]): T[] => {
    try { return fn(); } catch (e) { warnings.push(`${GRAPH} (${what}): ${e instanceof Error ? e.message : String(e)}`); return []; }
  };
  const findings = listOf("findings", () => graph.listFindings());
  const questions = listOf("open questions", () => graph.listOpenQuestions());
  const entities = listOf("entities", () => graph.listEntities());
  const relations = listOf("relations", () => graph.listRelations());
  // The counts render_docs stamps (847 D4), over the same lists — before any record is
  // withheld from the entity projection below, because the render counted them all.
  const live = liveRenderCounts(findings.length, entities.length, questions.length);

  // 2) documents — Spec 847's scanner, so the search and the critic read the same files (D2).
  let scanned: ScannedDoc[] = [];
  try { scanned = scanDocs(root); } catch (e) { warnings.push(`docs: ${e instanceof Error ? e.message : String(e)}`); }
  const scannedByPath = new Map(scanned.map((d) => [d.path, d]));

  // 3) the human layer (D1), each under its own kind, then the rest of the projection.
  const entityById = new Map<string, any>(entities.map((e) => [e.id, e]));
  const human = readHumanLayer(root, graph, entityById, scannedByPath, live, warnings);
  const humanIds = new Set<string>();
  for (const recs of [human.routines, human.labels, human.models, human.documents]) {
    for (const r of recs) { humanIds.add(r.id); records.push(r); }
  }
  if (humanIds.size > 0 && !sourcesRead.includes(GRAPH)) sourcesRead.push(GRAPH);

  const generated = (rec: { tags?: string[]; id?: string }) => (rec.tags ?? []).some((t) => t === "analysis-import" || t === "manifest-import" || t === "inventory-import") || String(rec.id ?? "").startsWith("claim:");
  const graphRec = (
    kind: ProjectSearchKind, items: any[],
    map: (rec: any) => Partial<ProjectSearchRecord> & { id: string; title: string },
  ) => {
    try {
      for (const rec of items) {
        const base = map(rec);
        const summary = clip(base.summary ?? "", 200);
        const addr = base.addressRange ?? addrRangeOf(rec);
        records.push({
          kind, summary, snippet: clip(base.summary ?? summary, 240),
          tags: base.tags ?? rec.tags ?? [],
          addressRange: addr,
          artifactIds: base.artifactIds ?? rec.artifactIds ?? [],
          entityIds: base.entityIds ?? rec.entityIds ?? [],
          relationIds: base.relationIds ?? rec.relationIds ?? [],
          sourcePath: GRAPH, updatedAt: rec.updatedAt,
          rankHints: base.rankHints,
          addrTokens: tokensForRecord(base.title, summary, "", addr),
          ...base,
        } as ProjectSearchRecord);
      }
      if (!sourcesRead.includes(GRAPH)) sourcesRead.push(GRAPH);
    } catch (e) { warnings.push(`${GRAPH} (${kind}): ${e instanceof Error ? e.message : String(e)}`); }
  };
  graphRec("finding", findings, (f) => ({ id: f.id, title: f.title ?? f.id, summary: f.summary ?? "", rankHints: generated(f) ? { generated: true } : { manual: true } }));
  graphRec("open_question", questions, (q) => ({ id: q.id, title: q.title ?? q.id, summary: q.description ?? "", rankHints: q.source === "static-analysis" || q.source === "heuristic-phase1" ? { generated: true } : { manual: true } }));
  graphRec("entity", entities.filter((e) => !humanIds.has(e.id)), (e) => ({ id: e.id, title: e.name ?? e.id, summary: e.summary ?? "", artifactIds: e.artifactIds ?? [], entityIds: [e.id], rankHints: { ...(generated(e) ? { generated: true } : { manual: true }), internal: e.internal === true } }));
  graphRec("relation", relations, (rl) => ({ id: rl.id, title: rl.title ?? `${rl.kind}: ${rl.sourceEntityId} → ${rl.targetEntityId}`, summary: rl.summary ?? "", entityIds: [rl.sourceEntityId, rl.targetEntityId].filter(Boolean), relationIds: [rl.id], rankHints: { manual: true } }));

  // 4) the wiki: every scanned document (D2), then the files outside any docs/ directory.
  for (const d of scanned) {
    const fm = d.frontmatter;
    const caveats: string[] = [];
    let rankHints: NonNullable<ProjectSearchRecord["rankHints"]> = { curated: true };
    // D3 — a render is a copy: it ranks `generated`, never curated, and when the graph
    // has moved on since it was written it is also `stale`, with both numbers in its why.
    if (fm?.kind === "generated") {
      rankHints = { generated: true };
      const drift = fm.generated ? renderDrift(fm.generated, live) : [];
      if (drift.length > 0) { rankHints.stale = true; caveats.push(`stale render: ${formatRenderDrift(drift, fm.generated!.at)}`); }
      else caveats.push("generated render — a copy of the graph");
    }
    if (fm?.status === "superseded") { rankHints.stale = true; caveats.push("superseded document"); }
    const kind: ProjectSearchKind = d.path === join("docs", "index.md") ? "wiki_page" : "doc_section";
    tryRead(d.path, (a, r) => indexMarkdown(a, r, { kind, rankHints, frontmatter: fm, caveats }));
  }
  tryRead("CLAUDE.md", (a, r) => indexMarkdown(a, r, { kind: "doc_section", rankHints: { curated: true } }));
  tryRead(join("knowledge", "notes.md"), (a, r) => indexMarkdown(a, r, { kind: "doc_section", rankHints: { curated: true } }));
  tryRead(join("knowledge", "activity-log.md"), (a, r) => indexActivityLog(a, r));

  // 5) structured JSON stores
  const versionByArtifact = new Map<string, { current: boolean; stale: boolean; subject: string }>();
  tryRead(join("knowledge", "artifact-versions.json"), (a, r) => {
    const groups = readJsonStore(a);
    const out: ProjectSearchRecord[] = [];
    for (const g of groups) {
      const memberIds: string[] = (g.versions ?? []).map((v: any) => v.artifactId);
      for (const v of g.versions ?? []) versionByArtifact.set(v.artifactId, { current: v.artifactId === g.currentArtifactId, stale: v.status === "stale" || v.status === "missing", subject: g.subjectId });
      out.push({
        id: `artifact_version:${g.subjectId}`,
        kind: "artifact_version",
        title: `versions of ${g.subjectId}`,
        summary: `${(g.versions ?? []).length} version(s); current=${g.currentArtifactId} (${g.currentSource})`,
        snippet: clip(`subject ${g.subjectId}: ${(g.versions ?? []).map((v: any) => `${v.role}/${v.format}`).join(", ")}`, 200),
        // Both keys: the subject (the directory plus the stem) and the bare
        // stem, because a person searching types a filename, not a path.
        tags: ["artifact-version", g.subjectId.toLowerCase(), subjectStem(g.subjectId).toLowerCase()],
        artifactIds: memberIds, entityIds: [], relationIds: [],
        sourcePath: r, updatedAt: g.updatedAt,
        rankHints: { currentArtifactVersion: true, curated: g.currentSource === "manual" },
        addrTokens: extractAddrTokens(g.subjectId),
      });
    }
    return out;
  });

  const storeRec = (
    relPath: string, kind: ProjectSearchKind,
    map: (rec: any) => Partial<ProjectSearchRecord> & { id: string; title: string },
  ) => tryRead(relPath, (a, r) => readJsonStore(a).map((rec) => {
    const base = map(rec);
    const summary = clip(base.summary ?? "", 200);
    const addr = base.addressRange ?? addrRangeOf(rec);
    return {
      kind, summary, snippet: clip(base.summary ?? summary, 240),
      tags: base.tags ?? rec.tags ?? [],
      addressRange: addr,
      artifactIds: base.artifactIds ?? rec.artifactIds ?? [],
      entityIds: base.entityIds ?? rec.entityIds ?? [],
      relationIds: base.relationIds ?? rec.relationIds ?? [],
      sourcePath: r, updatedAt: rec.updatedAt,
      rankHints: base.rankHints,
      addrTokens: tokensForRecord(base.title, summary, "", addr),
      ...base,
    } as ProjectSearchRecord;
  }));

  storeRec(join("knowledge", "flows.json"), "flow", (fl) => ({ id: fl.id, title: fl.title ?? fl.id, summary: fl.summary ?? "", rankHints: { manual: true } }));
  storeRec(join("knowledge", "artifacts.json"), "artifact", (art) => {
    const vinfo = versionByArtifact.get(art.id);
    return {
      id: art.id, title: art.title ?? basename(art.path ?? art.relativePath ?? art.id),
      summary: art.description ?? `${art.kind ?? ""} ${art.role ?? ""} ${art.relativePath ?? art.path ?? ""}`.trim(),
      artifactIds: [art.id],
      tags: [...(art.tags ?? []), art.kind, art.role].filter(Boolean),
      rankHints: {
        generated: /generated/.test(art.scope ?? "") || /generated-source/.test(art.kind ?? ""),
        currentArtifactVersion: vinfo?.current === true,
        stale: vinfo?.stale === true,
        internal: art.internal === true,
        curated: art.role === "semantic" || art.role === "curated",
      },
    };
  });

  // 6) views
  for (const rel of listViews(root)) tryRead(rel, (a, r) => indexView(a, r));

  // 7) ASM/TASS section headers — one dialect per disassembly (D5)
  for (const rel of listListings(root)) tryRead(rel, (a, r) => indexAsm(a, r));

  const counts: Record<string, number> = {};
  for (const rec of records) counts[rec.kind] = (counts[rec.kind] ?? 0) + 1;

  // D4 — stamped AFTER the reads: the graph connections above are closed by now, and a
  // checkpoint on close may itself touch graph.sqlite. Stamping first would record a
  // state the build's own reads then changed, and the next search would rebuild for it.
  const fingerprint = computeIndexFingerprint(root);
  return { version: PROJECT_SEARCH_INDEX_VERSION, projectDir: root, counts, sourcesRead, warnings, fingerprint, records };
}

// ── cache I/O ────────────────────────────────────────────────────────────────

export function writeIndexCache(projectDir: string, index: ProjectSearchIndex, nowIso?: string): string {
  const cacheAbs = join(projectDir, CACHE_RELPATH);
  mkdirSync(join(projectDir, "knowledge", ".cache"), { recursive: true });
  writeFileSync(cacheAbs, JSON.stringify({ ...index, builtAt: nowIso }, null, 2));
  return cacheAbs;
}

function readIndexCacheRaw(projectDir: string): Partial<ProjectSearchIndex> | undefined {
  const cacheAbs = join(projectDir, CACHE_RELPATH);
  if (!existsSync(cacheAbs)) return undefined;
  try { return JSON.parse(readFileSync(cacheAbs, "utf8")) as Partial<ProjectSearchIndex>; } catch { return undefined; }
}

/** The cache as written, when it is of this index version — whether or not it is current. */
export function loadIndexCache(projectDir: string): ProjectSearchIndex | undefined {
  const idx = readIndexCacheRaw(projectDir);
  if (!idx || idx.version !== PROJECT_SEARCH_INDEX_VERSION || !Array.isArray(idx.records)) return undefined;
  return idx as ProjectSearchIndex;
}

export interface FreshIndex {
  index: ProjectSearchIndex;
  /** Set when this call built the index — one line saying why. */
  rebuilt?: string;
}

/**
 * 740.3 D4 — the index as of now. The cache is returned when its fingerprint still
 * matches the project; otherwise the index is rebuilt, the cache rewritten, and `rebuilt`
 * says so in one line (`index rebuilt: the graph changed since <builtAt>`). The check
 * sits at the read, where staleness costs something — not a hook in every `save_*`.
 */
export function loadFreshIndex(projectDir: string, nowIso: string = new Date().toISOString()): FreshIndex {
  const cached = readIndexCacheRaw(projectDir);
  let reason: string | undefined;
  if (!cached || !Array.isArray(cached.records)) {
    reason = "index built: there was no cache yet";
  } else if (cached.version !== PROJECT_SEARCH_INDEX_VERSION) {
    reason = `index rebuilt: the cache was written by index version ${cached.version ?? "?"}, this is version ${PROJECT_SEARCH_INDEX_VERSION}`;
  } else if (!cached.fingerprint) {
    reason = "index rebuilt: the cache records no fingerprint of what it read";
  } else {
    const change = describeFingerprintChange(cached.fingerprint, computeIndexFingerprint(projectDir));
    if (change) reason = `index rebuilt: ${change} changed since ${cached.builtAt ?? "the cache was written"}`;
  }
  if (!reason) return { index: cached as ProjectSearchIndex };

  const index = { ...buildProjectSearchIndex(projectDir), builtAt: nowIso };
  try { writeIndexCache(projectDir, index, nowIso); }
  catch (e) { reason += ` (the cache could not be written: ${e instanceof Error ? e.message : String(e)})`; }
  return { index, rebuilt: reason };
}

// ── search ────────────────────────────────────────────────────────────────────

export interface SearchFilters { kind?: string; tag?: string; address?: string; artifactId?: string; entityId?: string; }
export interface SearchHit {
  id: string; kind: string; title: string; snippet: string;
  /** The record's whole summary, for `full_text` — the snippet is clipped at ~200 chars
   *  and the clip lands consistently before the addresses a caller searched for. */
  summary: string;
  sourcePath: string; sourceAnchor?: string;
  tags: string[]; addressRange?: { start: number; end: number }; artifactIds: string[]; entityIds: string[]; why: string[]; score: number;
}

const KIND_BONUS: Record<string, number> = {
  // wiki pages + curated docs + manual findings are the same "curated" tier
  // (Spec 740 §9.4); findings edge just above docs so payload facts surface
  // alongside the prose that describes them. 740.3 D1: a declared document sits
  // beside its sections, a model boundary above an entity, a named routine or label
  // below a finding (the finding says what it DOES; the name only says what it is).
  wiki_page: 90, finding: 75, doc_section: 70, document: 70, model: 65, routine: 60, label: 55,
  asm_section: 40, entity: 45, relation: 35, flow: 35,
  open_question: 30, artifact_version: 30, artifact: 20, view: 20, activity_log_entry: 10, trace_mark: 30,
};

function rangesOf(rec: ProjectSearchRecord): Array<{ start: number; end: number }> {
  return rec.ranges ?? (rec.addressRange ? [rec.addressRange] : []);
}

/** The first range of a declared-extent record that holds `address`, if any. */
function containing(rec: ProjectSearchRecord, address: number): { start: number; end: number } | undefined {
  if (!RANGE_KINDS.has(rec.kind)) return undefined;
  return rangesOf(rec).find((r) => r.start <= address && address <= r.end);
}

export function scoreRecord(rec: ProjectSearchRecord, q: { addr: string[]; text: string[]; raw: string }): { score: number; why: string[] } | undefined {
  let score = 0; const why: string[] = [];
  const recAddr = new Set(rec.addrTokens);
  for (const a of q.addr) {
    if (recAddr.has(a)) { score += /^track |\/s/.test(a) ? 900 : 1000; why.push(/^track |\/s/.test(a) ? `exact ${a}` : `exact address $${a.toUpperCase()}`); }
  }
  // 740.3 D6 — a container, a document's `covers` and a routine's extent DECLARE a range:
  // an address inside it is about that record even when neither end is the address asked.
  for (const address of numericAddrs(q.addr)) {
    if (recAddr.has(address.toString(16))) continue;
    const r = containing(rec, address);
    if (r) { score += 600; why.push(`${hex4(address)} inside ${fmtRange(r)}`); }
  }
  const idLower = rec.id.toLowerCase();
  if (q.raw.length > 3 && (idLower === q.raw || idLower.includes(q.raw))) { score += 800; why.push("id match"); }
  if (rec.title.toLowerCase() === q.raw) { score += 700; why.push("exact title"); }
  const tagSet = new Set(rec.tags.map((t) => String(t).toLowerCase()));
  for (const t of q.text) if (tagSet.has(t)) { score += 200; why.push(`tag: ${t}`); }

  const h = rec.rankHints ?? {};
  if (h.currentArtifactVersion) { score += 120; why.push("current/best version"); }
  if (h.curated || h.manual) score += 100;
  if (h.generated) score -= 40;
  if (h.internal) score -= 200;
  if (h.stale) { score -= 150; }
  score += KIND_BONUS[rec.kind] ?? 0;

  const hay = `${rec.title} ${rec.summary} ${rec.snippet} ${rec.tags.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const t of q.text) if (hay.includes(t)) hits++;
  if (hits > 0) { score += hits * 45; why.push(`text match: ${hits} term(s)`); }

  // Need at least one positive signal beyond kind bonus / curation.
  const meaningful = why.some((w) => /exact|inside|id match|tag:|text match|current/.test(w));
  if (!meaningful) return undefined;
  // What ranks this record where it is, said every time it is shown (a stale render's drift).
  for (const c of rec.caveats ?? []) why.push(c);
  return { score, why };
}

/** Does the record touch one of these address tokens — exactly, or inside a declared range? */
function touches(rec: ProjectSearchRecord, tokens: string[]): boolean {
  if (tokens.some((a) => rec.addrTokens.includes(a))) return true;
  return numericAddrs(tokens).some((address) => containing(rec, address) !== undefined);
}

export function searchIndex(index: ProjectSearchIndex, query: string, filters: SearchFilters = {}, limit = 10): SearchHit[] {
  const addr = extractAddrTokens(query);
  const text = queryTokens(query);
  const raw = query.trim().toLowerCase();
  const q = { addr, text, raw };

  let pool = index.records;
  if (filters.kind) pool = pool.filter((r) => r.kind === filters.kind);
  if (filters.tag) pool = pool.filter((r) => r.tags.some((t) => String(t).toLowerCase() === filters.tag!.toLowerCase()));
  if (filters.artifactId) pool = pool.filter((r) => r.artifactIds.includes(filters.artifactId!));
  if (filters.entityId) pool = pool.filter((r) => r.entityIds.includes(filters.entityId!));
  if (filters.address) { const at = extractAddrTokens(filters.address); pool = pool.filter((r) => touches(r, at)); }

  const scored: SearchHit[] = [];
  for (const rec of pool) {
    const s = scoreRecord(rec, q);
    if (!s) continue;
    scored.push({
      id: rec.id, kind: rec.kind, title: rec.title, snippet: rec.snippet || rec.title,
      summary: rec.summary || rec.snippet || rec.title,
      sourcePath: rec.sourcePath, sourceAnchor: rec.sourceAnchor,
      tags: rec.tags, addressRange: rec.addressRange, artifactIds: rec.artifactIds, entityIds: rec.entityIds, why: s.why, score: s.score,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.slice(0, Math.max(1, Math.min(limit, 50)));
}

// ── related ───────────────────────────────────────────────────────────────────

export interface RelatedGroup { group: string; items: Array<Pick<SearchHit, "id" | "kind" | "title" | "snippet" | "sourcePath" | "why">>; }
export interface RelatedResult { seed: { id: string; kind: string; title: string } | { query: string }; groups: RelatedGroup[]; }

/** The group each 740.3 kind lands in — D6. */
const HUMAN_GROUP: Record<string, string> = { routine: "routines", label: "labels", model: "model", document: "documents" };

export function findRelated(index: ProjectSearchIndex, idOrQuery: string, limit = 8): RelatedResult {
  const recById = new Map(index.records.map((r) => [r.id, r]));
  const raw = idOrQuery.trim();
  const lower = raw.toLowerCase();

  // Resolve a seed: exact id, else address, else subject stem, else top search hit.
  let seedRec = recById.get(raw);
  const seedArtifactIds = new Set<string>();
  const seedEntityIds = new Set<string>();
  const seedAddrTokens = new Set<string>(extractAddrTokens(raw));
  let seedSubject: string | undefined;
  let seedTags = new Set<string>();

  if (!seedRec) {
    // subject stem (e.g. "02_2.0"): collect all artifacts/version-groups with that stem
    const stem = subjectStem(raw).toLowerCase();
    const stemMatches = index.records.filter((r) =>
      (r.kind === "artifact" && (subjectStem(r.title).toLowerCase() === stem || r.title.toLowerCase().startsWith(`${stem}_`) || r.title.toLowerCase().startsWith(`${stem}.`))) ||
      (r.kind === "artifact_version" && r.id.toLowerCase() === `artifact_version:${lower}`) ||
      (r.kind === "artifact_version" && r.tags.includes(lower)));
    if (stemMatches.length > 0) { seedSubject = raw; for (const r of stemMatches) { r.artifactIds.forEach((a) => seedArtifactIds.add(a)); r.entityIds.forEach((e) => seedEntityIds.add(e)); r.tags.forEach((t) => seedTags.add(String(t).toLowerCase())); } }
  }

  if (seedRec) {
    seedRec.artifactIds.forEach((a) => seedArtifactIds.add(a));
    seedRec.entityIds.forEach((e) => seedEntityIds.add(e));
    if (seedRec.kind === "entity") seedEntityIds.add(seedRec.id);
    seedRec.tags.forEach((t) => seedTags.add(String(t).toLowerCase()));
    seedRec.addrTokens.forEach((a) => seedAddrTokens.add(a));
    seedSubject = subjectStem(seedRec.title);
  } else if (!seedSubject && seedAddrTokens.size === 0) {
    // fall back to best search hit as seed
    const hit = searchIndex(index, raw, {}, 1)[0];
    if (hit) { seedRec = recById.get(hit.id); if (seedRec) { seedRec.artifactIds.forEach((a) => seedArtifactIds.add(a)); seedRec.entityIds.forEach((e) => seedEntityIds.add(e)); seedRec.tags.forEach((t) => seedTags.add(String(t).toLowerCase())); seedRec.addrTokens.forEach((a) => seedAddrTokens.add(a)); seedSubject = subjectStem(seedRec.title); } }
  }
  // The 740.3 kinds tag themselves with their kind ("routine", "label", …); sharing that
  // tag says nothing, and would make every routine related to every other one.
  if (seedRec && HUMAN_GROUP[seedRec.kind]) seedTags = new Set([...seedTags].filter((t) => t !== seedRec!.kind && t !== "document" && t !== "model"));

  // D6 — the seed as address RANGES: the addresses asked for, plus the extent a model
  // boundary, a document or a routine declares. A seed of $C000 then reaches the
  // container around it, the routine at it and the document that declares it.
  const seedRanges: Array<{ start: number; end: number }> = numericAddrs(extractAddrTokens(raw)).map((a) => ({ start: a, end: a }));
  if (seedRec && RANGE_KINDS.has(seedRec.kind)) seedRanges.push(...rangesOf(seedRec));
  const rangeRelation = (rec: ProjectSearchRecord): string | undefined => {
    if (seedRanges.length === 0) return undefined;
    // A record's own range counts when it declares one, or when the seed does.
    if (!RANGE_KINDS.has(rec.kind) && !(seedRec && RANGE_KINDS.has(seedRec.kind))) return undefined;
    for (const r of rangesOf(rec)) {
      for (const s of seedRanges) {
        if (r.start > s.end || s.start > r.end) continue;
        if (s.start === s.end) return r.start === r.end ? `at ${hex4(s.start)}` : `${fmtRange(r)} holds ${hex4(s.start)}`;
        return r.start >= s.start && r.end <= s.end ? `inside ${fmtRange(s)}` : `overlaps ${fmtRange(s)}`;
      }
    }
    return undefined;
  };

  // 2-hop expansion: entities frequently link UP to a payload's artifacts
  // (e.g. entry_C000 → 02_2.0 artifact) while the payload artifact itself has
  // no entityIds. Pull those linking entities into the seed so findings that
  // reference them surface (findings → entity → artifact ← seed).
  if (seedArtifactIds.size > 0) {
    for (const rec of index.records) {
      if (rec.kind === "entity" && rec.artifactIds.some((a) => seedArtifactIds.has(a))) {
        rec.entityIds.forEach((e) => seedEntityIds.add(e));
        seedEntityIds.add(rec.id);
      }
    }
  }

  const seedIds = new Set<string>([seedRec?.id ?? "", `artifact_version:${seedSubject ?? ""}`]);
  const groups = new Map<string, RelatedResult["groups"][number]["items"]>();
  const add = (group: string, rec: ProjectSearchRecord, why: string) => {
    if (seedIds.has(rec.id)) return;
    const bucket = groups.get(group) ?? [];
    if (bucket.find((b) => b.id === rec.id)) return;
    if (bucket.length >= limit) return;
    bucket.push({ id: rec.id, kind: rec.kind, title: rec.title, snippet: rec.snippet || rec.title, sourcePath: rec.sourcePath, why: [why, ...(rec.caveats ?? [])] });
    groups.set(group, bucket);
  };

  for (const rec of index.records) {
    if (seedIds.has(rec.id)) continue;
    const sharedArtifact = rec.artifactIds.some((a) => seedArtifactIds.has(a)) || (seedSubject && rec.kind === "artifact" && subjectStem(rec.title).toLowerCase() === seedSubject.toLowerCase());
    const sharedEntity = rec.entityIds.some((e) => seedEntityIds.has(e));
    const sharedTag = rec.tags.some((t) => seedTags.has(String(t).toLowerCase()));
    const addrOverlap = rec.addrTokens.some((a) => seedAddrTokens.has(a));
    const inRange = rangeRelation(rec);
    const addrWhy = addrOverlap ? "address overlap" : inRange;
    const human = HUMAN_GROUP[rec.kind];
    if (rec.kind === "artifact_version" && seedSubject && (rec.id.toLowerCase() === `artifact_version:${seedSubject.toLowerCase()}` || rec.tags.includes(seedSubject.toLowerCase()))) add("versions", rec, "artifact version group");
    else if (rec.kind === "artifact" && sharedArtifact) add("versions", rec, "same subject / artifact");
    else if (rec.kind === "finding" && (sharedArtifact || sharedEntity || addrWhy || sharedTag)) add("findings", rec, sharedArtifact ? "shared artifact" : sharedEntity ? "shared entity" : addrWhy ? addrWhy : "shared tag");
    else if (rec.kind === "entity" && (sharedEntity || sharedArtifact || sharedTag)) add("entities", rec, sharedEntity ? "linked entity" : sharedArtifact ? "shared artifact" : "shared tag");
    else if (human && (addrWhy || sharedEntity || sharedArtifact)) add(human, rec, addrWhy ?? (sharedEntity ? "linked entity" : "shared artifact"));
    else if (rec.kind === "relation" && sharedEntity) add("relations", rec, "relation edge");
    else if ((rec.kind === "doc_section" || rec.kind === "wiki_page") && (addrWhy || sharedTag)) add("docs", rec, addrWhy ?? "shared tag");
    else if (rec.kind === "view" && (sharedEntity || addrOverlap)) add("views", rec, addrOverlap ? "address overlap" : "shared entity");
    else if (addrWhy && (seedAddrTokens.size > 0 || seedRanges.length > 0)) add("address_overlap", rec, addrWhy);
  }

  return {
    seed: seedRec ? { id: seedRec.id, kind: seedRec.kind, title: seedRec.title } : seedSubject ? { id: `artifact_version:${seedSubject}`, kind: "artifact_version", title: `subject ${seedSubject}` } : { query: raw },
    groups: Array.from(groups.entries()).map(([group, items]) => ({ group, items })),
  };
}
