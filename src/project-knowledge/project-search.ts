// Spec 740.1 — Project Wiki + Knowledge Retrieval MVP.
//
// A deterministic, project-local search index over the curated wiki (docs/*.md,
// knowledge/notes.md, CLAUDE.md), the structured knowledge stores
// (findings/entities/relations/flows/open-questions/artifacts/artifact-versions),
// selected views, and ASM/TASS section headers. NO embeddings, NO vector DB, NO
// network. The cache is a navigation aid; the raw sources stay authoritative.
//
// The index indexes SMALL records (markdown sections, one record per structured
// item, ASM section headers) — never whole large files as a single blob, and
// never raw disk/cart bytes or raw *_analysis.json.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

export type ProjectSearchKind =
  | "finding" | "open_question" | "entity" | "relation" | "flow"
  | "artifact" | "artifact_version" | "doc_section" | "wiki_page"
  | "activity_log_entry" | "asm_section" | "view" | "trace_mark";

export interface ProjectSearchRecord {
  id: string;
  kind: ProjectSearchKind;
  title: string;
  summary: string;
  snippet: string;
  tags: string[];
  addressRange?: { start: number; end: number };
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
  records: ProjectSearchRecord[];
}

export const PROJECT_SEARCH_INDEX_VERSION = 1;
export const CACHE_RELPATH = join("knowledge", ".cache", "project-search-index.json");

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

// Markdown → section records. Splits on ## / # headings.
function indexMarkdown(absPath: string, relPath: string, kind: ProjectSearchKind, curated: boolean): ProjectSearchRecord[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const out: ProjectSearchRecord[] = [];
  let heading = basename(relPath);
  let bodyLines: string[] = [];
  const flush = () => {
    if (!heading && bodyLines.length === 0) return;
    const body = bodyLines.join("\n").trim();
    if (!heading && !body) return;
    const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "section";
    const addr = firstAddressRange(`${heading} ${body}`);
    const title = `${basename(relPath)} — ${heading}`;
    const summary = clip(body, 160);
    const snippet = clip(body, 240);
    out.push({
      id: `doc:${relPath}#${slug}`,
      kind, title, summary, snippet,
      tags: tagsFromPath(relPath),
      addressRange: addr,
      artifactIds: [], entityIds: [], relationIds: [],
      sourcePath: relPath, sourceAnchor: heading,
      rankHints: { curated },
      addrTokens: tokensForRecord(heading, body, "", addr),
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
  const lines = text.split("\n");
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
  return s.replace(/\.(asm|tass|prg|d64|g64|crt|sym|json|md)$/i, "").replace(/_(disasm|semantic|notes|curated|final|src|source)$/i, "");
}
export function subjectStem(pathOrTitle: string): string { return strip(basename(pathOrTitle || "")); }

// ── index builder ────────────────────────────────────────────────────────────

export function buildProjectSearchIndex(projectDir: string): ProjectSearchIndex {
  const records: ProjectSearchRecord[] = [];
  const sourcesRead: string[] = [];
  const warnings: string[] = [];
  const root = projectDir;
  const rel = (p: string) => relative(root, p);

  const tryRead = (relPath: string, fn: (abs: string, rel: string) => ProjectSearchRecord[]) => {
    const abs = join(root, relPath);
    if (!existsSync(abs)) return;
    try { const recs = fn(abs, relPath); records.push(...recs); sourcesRead.push(relPath); }
    catch (e) { warnings.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // 1) curated markdown wiki
  tryRead(join("docs", "index.md"), (a, r) => indexMarkdown(a, r, "wiki_page", true));
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      tryRead(join("docs", f), (a, r) => indexMarkdown(a, r, "doc_section", true));
    }
  }
  tryRead("CLAUDE.md", (a, r) => indexMarkdown(a, r, "doc_section", true));
  tryRead(join("knowledge", "notes.md"), (a, r) => indexMarkdown(a, r, "doc_section", true));
  tryRead(join("knowledge", "activity-log.md"), (a, r) => indexActivityLog(a, r));

  // 2) structured stores
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
        tags: ["artifact-version", g.subjectId.toLowerCase()],
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

  storeRec(join("knowledge", "findings.json"), "finding", (f) => ({ id: f.id, title: f.title ?? f.id, summary: f.summary ?? "", rankHints: { manual: true } }));
  storeRec(join("knowledge", "open-questions.json"), "open_question", (q) => ({ id: q.id, title: q.title ?? q.id, summary: q.summary ?? "", rankHints: { manual: true } }));
  storeRec(join("knowledge", "entities.json"), "entity", (e) => ({ id: e.id, title: e.name ?? e.id, summary: e.summary ?? e.description ?? "", artifactIds: e.artifactIds ?? [], entityIds: [e.id], rankHints: { manual: true, internal: e.internal === true } }));
  storeRec(join("knowledge", "relations.json"), "relation", (rl) => ({ id: rl.id, title: rl.title ?? `${rl.kind}: ${rl.sourceEntityId} → ${rl.targetEntityId}`, summary: rl.summary ?? "", entityIds: [rl.sourceEntityId, rl.targetEntityId].filter(Boolean), relationIds: [rl.id], rankHints: { manual: true } }));
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

  // 3) views
  const viewsDir = join(root, "views");
  if (existsSync(viewsDir)) {
    for (const f of readdirSync(viewsDir)) {
      if (!f.endsWith(".json")) continue;
      tryRead(join("views", f), (a, r) => indexView(a, r));
    }
  }

  // 4) ASM/TASS section headers (bounded, from artifacts/generated-src + analysis trees)
  for (const dir of ["artifacts", "analysis"]) {
    walkAsm(join(root, dir), root, (relPath) => tryRead(relPath, (a, r) => indexAsm(a, r)));
  }

  const counts: Record<string, number> = {};
  for (const rec of records) counts[rec.kind] = (counts[rec.kind] ?? 0) + 1;

  return { version: PROJECT_SEARCH_INDEX_VERSION, projectDir: root, counts, sourcesRead, warnings, records };
}

function walkAsm(dir: string, root: string, onFile: (relPath: string) => void, depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  let asmCount = 0;
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { walkAsm(abs, root, onFile, depth + 1); continue; }
    if (/\.(asm|tass)$/i.test(name) && asmCount < 200) { asmCount++; onFile(relative(root, abs)); }
  }
}

// ── cache I/O ────────────────────────────────────────────────────────────────

export function writeIndexCache(projectDir: string, index: ProjectSearchIndex, nowIso?: string): string {
  const cacheAbs = join(projectDir, CACHE_RELPATH);
  mkdirSync(join(projectDir, "knowledge", ".cache"), { recursive: true });
  writeFileSync(cacheAbs, JSON.stringify({ ...index, builtAt: nowIso }, null, 2));
  return cacheAbs;
}

export function loadIndexCache(projectDir: string): ProjectSearchIndex | undefined {
  const cacheAbs = join(projectDir, CACHE_RELPATH);
  if (!existsSync(cacheAbs)) return undefined;
  try {
    const idx = JSON.parse(readFileSync(cacheAbs, "utf8")) as ProjectSearchIndex;
    if (idx.version !== PROJECT_SEARCH_INDEX_VERSION || !Array.isArray(idx.records)) return undefined;
    return idx;
  } catch { return undefined; }
}

export function loadOrBuildIndex(projectDir: string): ProjectSearchIndex {
  return loadIndexCache(projectDir) ?? buildProjectSearchIndex(projectDir);
}

// ── search ────────────────────────────────────────────────────────────────────

export interface SearchFilters { kind?: string; tag?: string; address?: string; artifactId?: string; entityId?: string; }
export interface SearchHit {
  id: string; kind: string; title: string; snippet: string; sourcePath: string; sourceAnchor?: string;
  tags: string[]; addressRange?: { start: number; end: number }; artifactIds: string[]; entityIds: string[]; why: string[]; score: number;
}

const KIND_BONUS: Record<string, number> = {
  // wiki pages + curated docs + manual findings are the same "curated" tier
  // (Spec 740 §9.4); findings edge just above docs so payload facts surface
  // alongside the prose that describes them.
  wiki_page: 90, finding: 75, doc_section: 70, asm_section: 40, entity: 45, relation: 35, flow: 35,
  open_question: 30, artifact_version: 30, artifact: 20, view: 20, activity_log_entry: 10, trace_mark: 30,
};

export function scoreRecord(rec: ProjectSearchRecord, q: { addr: string[]; text: string[]; raw: string }): { score: number; why: string[] } | undefined {
  let score = 0; const why: string[] = [];
  const recAddr = new Set(rec.addrTokens);
  for (const a of q.addr) {
    if (recAddr.has(a)) { score += /^track |\/s/.test(a) ? 900 : 1000; why.push(/^track |\/s/.test(a) ? `exact ${a}` : `exact address $${a.toUpperCase()}`); }
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
  const meaningful = why.some((w) => /exact|id match|tag:|text match|current/.test(w));
  if (!meaningful) return undefined;
  return { score, why };
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
  if (filters.address) { const at = extractAddrTokens(filters.address); pool = pool.filter((r) => at.some((a) => r.addrTokens.includes(a))); }

  const scored: SearchHit[] = [];
  for (const rec of pool) {
    const s = scoreRecord(rec, q);
    if (!s) continue;
    scored.push({
      id: rec.id, kind: rec.kind, title: rec.title, snippet: rec.snippet || rec.title, sourcePath: rec.sourcePath, sourceAnchor: rec.sourceAnchor,
      tags: rec.tags, addressRange: rec.addressRange, artifactIds: rec.artifactIds, entityIds: rec.entityIds, why: s.why, score: s.score,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.slice(0, Math.max(1, Math.min(limit, 50)));
}

// ── related ───────────────────────────────────────────────────────────────────

export interface RelatedGroup { group: string; items: Array<Pick<SearchHit, "id" | "kind" | "title" | "snippet" | "sourcePath" | "why">>; }
export interface RelatedResult { seed: { id: string; kind: string; title: string } | { query: string }; groups: RelatedGroup[]; }

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
    bucket.push({ id: rec.id, kind: rec.kind, title: rec.title, snippet: rec.snippet || rec.title, sourcePath: rec.sourcePath, why: [why] });
    groups.set(group, bucket);
  };

  for (const rec of index.records) {
    if (seedIds.has(rec.id)) continue;
    const sharedArtifact = rec.artifactIds.some((a) => seedArtifactIds.has(a)) || (seedSubject && rec.kind === "artifact" && subjectStem(rec.title).toLowerCase() === seedSubject.toLowerCase());
    const sharedEntity = rec.entityIds.some((e) => seedEntityIds.has(e));
    const sharedTag = rec.tags.some((t) => seedTags.has(String(t).toLowerCase()));
    const addrOverlap = rec.addrTokens.some((a) => seedAddrTokens.has(a));
    if (rec.kind === "artifact_version" && seedSubject && (rec.id.toLowerCase() === `artifact_version:${seedSubject.toLowerCase()}` || rec.tags.includes(seedSubject.toLowerCase()))) add("versions", rec, "artifact version group");
    else if (rec.kind === "artifact" && sharedArtifact) add("versions", rec, "same subject / artifact");
    else if (rec.kind === "finding" && (sharedArtifact || sharedEntity || addrOverlap || sharedTag)) add("findings", rec, sharedArtifact ? "shared artifact" : sharedEntity ? "shared entity" : addrOverlap ? "address overlap" : "shared tag");
    else if (rec.kind === "entity" && (sharedEntity || sharedArtifact || sharedTag)) add("entities", rec, sharedEntity ? "linked entity" : sharedArtifact ? "shared artifact" : "shared tag");
    else if (rec.kind === "relation" && sharedEntity) add("relations", rec, "relation edge");
    else if ((rec.kind === "doc_section" || rec.kind === "wiki_page") && (addrOverlap || sharedTag)) add("docs", rec, addrOverlap ? "address overlap" : "shared tag");
    else if (rec.kind === "view" && (sharedEntity || addrOverlap)) add("views", rec, addrOverlap ? "address overlap" : "shared entity");
    else if (addrOverlap && seedAddrTokens.size > 0) add("address_overlap", rec, "address overlap");
  }

  return {
    seed: seedRec ? { id: seedRec.id, kind: seedRec.kind, title: seedRec.title } : seedSubject ? { id: `artifact_version:${seedSubject}`, kind: "artifact_version", title: `subject ${seedSubject}` } : { query: raw },
    groups: Array.from(groups.entries()).map(([group, items]) => ({ group, items })),
  };
}
