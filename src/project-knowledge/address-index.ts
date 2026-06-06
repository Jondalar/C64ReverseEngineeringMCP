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
    // Spec 759 — also index the artifact's point labels (the named ABI entries,
    // e.g. the engine's `api_*` jumptable labels). As zero-width entries they
    // win the tightest-match over the coarse covering segment, so a cross-file
    // call resolves to `api_turn_advance`, not just the segment's kind.
    if (existsSync(annPath)) {
      try {
        const ann = JSON.parse(readFileSync(annPath, "utf8")) as { labels?: Array<{ address?: string | number; label?: string }> };
        for (const l of ann.labels ?? []) {
          if (!l.label || l.address === undefined) continue;
          const addr = (typeof l.address === "string" ? parseInt(l.address, 16) : l.address) & 0xffff;
          if (Number.isNaN(addr)) continue;
          entries.push({ owner: stem, start: addr, end: addr, kind: "label", label: l.label });
        }
      } catch { /* labels are best-effort */ }
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

// --- ABI jumptable index (Spec 759 P3) -----------------------------------
// A shared engine exposes its contract as a run of `JMP abs` entries (the
// Wasteland engine: 154 entries in $0200-$04FF). Those table bytes are usually
// classified "unknown" (not disassembled) so the entry→target link is in neither
// the segments nor the xrefs — it must be DECODED from the artifact's PRG bytes.
// We detect a dense run of `4C lo hi` and record entry→target, so a caller of an
// ABI entry resolves transitively to the real routine body.

export interface AbiEntry { owner: string; entry: number; target: number; }

const ABI_CACHE_RELPATH = join("knowledge", ".cache", "abi-index.json");

/**
 * Decode an artifact's ABI jumptable into entry→target pairs. The named dispatch
 * entries already have annotation point labels (the engine's 687 `api_*`); the
 * table region itself is classified "unknown" (not disassembled) and the entries
 * sit at irregular alignments (variable data interleaved), so a grid/run scan
 * misses them. Instead, at each LABELED address that holds a `JMP abs` byte
 * (`4C`), decode the target — precise, alignment-free, no false positives.
 */
export function buildAbiIndex(projectDir: string): AbiEntry[] {
  const out: AbiEntry[] = [];
  for (const p of findAnalysisJsons(projectDir)) {
    const stem = basename(p).replace(/_analysis\.json$/, "");
    const prgPath = join(dirname(p), `${stem}.prg`);
    const annPath = join(dirname(p), `${stem}_annotations.json`);
    if (!existsSync(prgPath) || !existsSync(annPath)) continue;
    let prg: Buffer;
    try { prg = readFileSync(prgPath); } catch { continue; }
    if (prg.length < 5) continue;
    const load = prg.readUInt16LE(0);
    const body = prg.subarray(2);
    const at = (addr: number): number | undefined => { const o = addr - load; return o >= 0 && o < body.length ? body[o] : undefined; };
    let ann: { labels?: Array<{ address?: string | number }> };
    try { ann = JSON.parse(readFileSync(annPath, "utf8")); } catch { continue; }
    for (const l of ann.labels ?? []) {
      if (l.address === undefined) continue;
      const addr = (typeof l.address === "string" ? parseInt(l.address, 16) : l.address) & 0xffff;
      if (Number.isNaN(addr) || at(addr) !== 0x4c || at(addr + 2) === undefined) continue;
      out.push({ owner: stem, entry: addr, target: (at(addr + 1)! | (at(addr + 2)! << 8)) & 0xffff });
    }
  }
  return out;
}

export function loadAbiIndex(projectDir: string): AbiEntry[] {
  const cachePath = join(projectDir, ABI_CACHE_RELPATH);
  const jsons = findAnalysisJsons(projectDir);
  // invalidate on either the analysis OR the PRG changing.
  const newest = jsons.reduce((m, p) => {
    let t = m;
    try { t = Math.max(t, statSync(p).mtimeMs); } catch { /* */ }
    const prg = join(dirname(p), `${basename(p).replace(/_analysis\.json$/, "")}.prg`);
    try { t = Math.max(t, statSync(prg).mtimeMs); } catch { /* */ }
    return t;
  }, 0);
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { builtMs: number; abi: AbiEntry[] };
      if (cached.builtMs >= newest) return cached.abi;
    }
  } catch { /* rebuild */ }
  const abi = buildAbiIndex(projectDir);
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ builtMs: Date.now(), abi }));
  } catch { /* best-effort */ }
  return abi;
}

export interface AbiResolution {
  entry: CrossArtifactHit;            // the table entry (owner + api_* label)
  isAbi: boolean;                     // entry sits in a decoded jumptable
  targetAddr?: number;                // the entry's JMP target (the body)
  target?: CrossArtifactHit;          // the body's owner + label, if known
}

/**
 * Resolve an ABI jumptable entry transitively: the entry's label AND the routine
 * its `JMP` dispatches to. Returns undefined if `addr` owns no segment.
 */
export function resolveAbi(projectDir: string, addr: number): AbiResolution | undefined {
  const hits = resolveCrossArtifact(projectDir, addr);
  if (!hits.length) return undefined;
  const abi = loadAbiIndex(projectDir).find((x) => x.entry === (addr & 0xffff));
  const res: AbiResolution = { entry: hits[0]!, isAbi: !!abi };
  if (abi) {
    res.targetAddr = abi.target;
    res.target = resolveCrossArtifact(projectDir, abi.target)[0];
  }
  return res;
}
