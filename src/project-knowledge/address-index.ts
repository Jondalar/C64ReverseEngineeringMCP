// Spec 759 P1 — project address-knowledge index.
//
// A project-level, cached aggregate of every analyzed artifact's effective
// segments (kind + label, annotation-overlaid per Spec 751), keyed by absolute
// address. `resolveCrossArtifact(addr)` answers "which artifact owns this
// address, and what is it called there" — the one map shared by phase-1
// cross-file resolution (Spec 759 §3.3) AND the Spec 754 monitor inspect/xref.
//
// Deterministic (no embeddings). Cached under knowledge/.cache, invalidated when
// any _analysis.json is newer than the cache (rebuild-on-read, OQ3 lean).

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { loadEffectiveSegments } from "./effective-segments.js";

export interface AddressIndexEntry {
  owner: string;   // artifact stem, e.g. "block2_engine_0200"
  start: number;   // absolute, 16-bit
  end: number;
  kind: string;
  label?: string;
}

export interface CrossArtifactHit {
  owner: string;
  label?: string;
  kind: string;
  start: number;
  end: number;
}

const CACHE_RELPATH = join("knowledge", ".cache", "address-index.json");

/** Depth-bounded walk for `*_analysis.json` (mirrors the monitor inspect walk). */
function findAnalysisJsons(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || out.length > 256) return;
    let ents: import("node:fs").Dirent[];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith("_analysis.json")) out.push(p);
    }
  };
  walk(projectDir, 0);
  return out;
}

/** Build the index fresh from every analyzed artifact's effective segments. */
export function buildAddressIndex(projectDir: string): AddressIndexEntry[] {
  const entries: AddressIndexEntry[] = [];
  for (const p of findAnalysisJsons(projectDir)) {
    const stem = basename(p).replace(/_analysis\.json$/, "");
    const annPath = join(dirname(p), `${stem}_annotations.json`);
    let segs;
    try { segs = loadEffectiveSegments(p, existsSync(annPath) ? annPath : undefined).segments; } catch { continue; }
    for (const g of segs) {
      entries.push({ owner: stem, start: g.start & 0xffff, end: g.end & 0xffff, kind: g.kind, label: g.label });
    }
  }
  return entries;
}

/** Cached load — rebuilds when any `_analysis.json` is newer than the cache. */
export function loadAddressIndex(projectDir: string): AddressIndexEntry[] {
  const cachePath = join(projectDir, CACHE_RELPATH);
  const jsons = findAnalysisJsons(projectDir);
  const newest = jsons.reduce((m, p) => { try { return Math.max(m, statSync(p).mtimeMs); } catch { return m; } }, 0);
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { builtMs: number; entries: AddressIndexEntry[] };
      if (cached.builtMs >= newest) return cached.entries;
    }
  } catch { /* fall through to rebuild */ }
  const entries = buildAddressIndex(projectDir);
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ builtMs: Date.now(), entries }));
  } catch { /* cache is best-effort */ }
  return entries;
}

/**
 * Resolve an absolute address to the owning artifact + label/kind. Returns all
 * covering segments (more than one = an overlap/banking ambiguity the caller
 * surfaces, OQ2); tightest segment first. `excludeOwner` drops the querying
 * artifact so only CROSS-file owners are returned.
 */
export function resolveCrossArtifact(
  projectDir: string,
  addr: number,
  opts?: { excludeOwner?: string },
): CrossArtifactHit[] {
  const a = addr & 0xffff;
  return loadAddressIndex(projectDir)
    .filter((e) => a >= e.start && a <= e.end && (!opts?.excludeOwner || e.owner !== opts.excludeOwner))
    .sort((x, y) => (x.end - x.start) - (y.end - y.start))
    .map((e) => ({ owner: e.owner, label: e.label, kind: e.kind, start: e.start, end: e.end }));
}

// --- cross-artifact xref index (Spec 759 §3.3 / P1b) ---------------------
// Today the monitor `xref` only sees the file that OWNS the address, so a
// cross-file caller (block3 → engine $0200) is invisible. This aggregates the
// xrefs of EVERY artifact, so "who references $0200" spans the whole project.

export interface XrefEntry { owner: string; source: number; target: number; type: string; operandText?: string; }

const XREF_CACHE_RELPATH = join("knowledge", ".cache", "xref-index.json");

export function buildXrefIndex(projectDir: string): XrefEntry[] {
  const out: XrefEntry[] = [];
  for (const p of findAnalysisJsons(projectDir)) {
    const stem = basename(p).replace(/_analysis\.json$/, "");
    let report: { codeAnalysis?: { xrefs?: unknown[] }; probableCodeAnalysis?: { xrefs?: unknown[] } };
    try { report = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const xrefs = [...(report.codeAnalysis?.xrefs ?? []), ...(report.probableCodeAnalysis?.xrefs ?? [])] as Array<{ sourceAddress?: number; targetAddress?: number; type?: string; operandText?: string }>;
    for (const x of xrefs) {
      if (typeof x.sourceAddress !== "number" || typeof x.targetAddress !== "number") continue;
      out.push({ owner: stem, source: x.sourceAddress & 0xffff, target: x.targetAddress & 0xffff, type: x.type ?? "ref", operandText: x.operandText });
    }
  }
  return out;
}

export function loadXrefIndex(projectDir: string): XrefEntry[] {
  const cachePath = join(projectDir, XREF_CACHE_RELPATH);
  const jsons = findAnalysisJsons(projectDir);
  const newest = jsons.reduce((m, p) => { try { return Math.max(m, statSync(p).mtimeMs); } catch { return m; } }, 0);
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { builtMs: number; xrefs: XrefEntry[] };
      if (cached.builtMs >= newest) return cached.xrefs;
    }
  } catch { /* rebuild */ }
  const xrefs = buildXrefIndex(projectDir);
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ builtMs: Date.now(), xrefs }));
  } catch { /* best-effort */ }
  return xrefs;
}

/** Project-wide xrefs touching `addr`: `into` = callers anywhere, `outof` = its own refs. */
export function resolveXrefs(projectDir: string, addr: number): { into: XrefEntry[]; outof: XrefEntry[] } {
  const a = addr & 0xffff;
  const idx = loadXrefIndex(projectDir);
  return {
    into: idx.filter((x) => x.target === a),
    outof: idx.filter((x) => x.source === a),
  };
}
