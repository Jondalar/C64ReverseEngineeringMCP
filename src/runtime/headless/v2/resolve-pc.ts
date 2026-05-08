// Spec 235 — Runtime evidence ↔ disassembly link.
//
// Resolves a PC value to its position in the project's disassembly:
//   Layer 1 — RoutineAnnotation range match
//   Layer 2 — Nearest LabelAnnotation ≤ PC
//   Layer 3 — Segment classification from analysis report
//   Layer 4 — Source line in <artifact>_disasm.asm (cached)
//
// Cache: per (artifactId, pc) result TTL 100 ms (simple Map + timestamp).
// resolvePcs() is a batch helper that shares a single warm cache load.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---- Types imported from pipeline (avoid circular dep: inline what we need) ----

type SegmentKind =
  | "basic_stub" | "code" | "text" | "screen_code_text" | "petscii_text"
  | "sprite" | "charset" | "charset_source" | "screen_ram" | "screen_source"
  | "bitmap" | "hires_bitmap" | "multicolor_bitmap" | "bitmap_source"
  | "color_source" | "sid_driver" | "music_data" | "sid_related_code"
  | "pointer_table" | "lookup_table" | "state_variable" | "compressed_data"
  | "dead_code" | "padding" | "unknown";

// ---- Public surface --------------------------------------------------------

export interface ResolvedPc {
  artifactId: string;
  pc: number;
  /** Layer 1: PC is inside a named routine */
  routine?: { name: string; description?: string; entry: number; exit?: number };
  /** Layer 2: nearest label whose address ≤ PC */
  label?: { name: string; isExact: boolean };
  /** Layer 3: segment kind and analysis confidence */
  segment?: { kind: SegmentKind; confidence: number };
  /** Layer 4: source file + line number (1-based) in _disasm.asm */
  source?: { file: string; line: number };
}

// ---- Internal types --------------------------------------------------------

interface AnnotationsFile {
  version: number;
  binary: string;
  segments: Array<{ start: string; end: string; kind: string; label?: string; comment?: string }>;
  labels: Array<{ address: string; label: string; comment?: string }>;
  routines: Array<{ address: string; name: string; comment: string }>;
}

interface AnalysisReport {
  binaryName: string;
  segments: Array<{ kind: string; start: number; end: number; score: { confidence: number } }>;
}

interface ArtifactData {
  annotations: AnnotationsFile | null;
  analysis: AnalysisReport | null;
  /** Sorted routine entries (by start address, ascending) for range lookup */
  routinesSorted: Array<{ entry: number; exit?: number; name: string; description?: string }>;
  /** Sorted labels (by address, ascending) for nearest-≤ lookup */
  labelsSorted: Array<{ address: number; name: string }>;
  /** Sorted analysis segments (by start, ascending) */
  segmentsSorted: Array<{ start: number; end: number; kind: SegmentKind; confidence: number }>;
  /** Disasm line index: address → 1-based line number */
  disasmLines: Map<number, number> | null;
  disasmFile: string | null;
}

// ---- Cache -----------------------------------------------------------------

const CACHE_TTL_MS = 100;

interface CachedResult {
  result: ResolvedPc;
  ts: number;
}

/** Two-level cache: artifactId → (pc → CachedResult) */
const resolveCache = new Map<string, Map<number, CachedResult>>();

/** Per-artifact loaded data (stays warm until process exit; stale if files change) */
const artifactCache = new Map<string, ArtifactData>();

function getProjectDir(): string {
  return process.env["C64RE_PROJECT_DIR"] ?? process.cwd();
}

// ---- Artifact data loader --------------------------------------------------

function parseHex(hex: string): number {
  return parseInt(hex.replace(/^\$/, ""), 16);
}

/** Regex matching "; $XXXX" address comment on asm lines */
const ADDR_COMMENT_RE = /;\s*\$([0-9A-Fa-f]{4})/;

function buildDisasmLineIndex(disasmPath: string): Map<number, number> {
  const index = new Map<number, number>();
  const text = readFileSync(disasmPath, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(ADDR_COMMENT_RE);
    if (m) {
      const addr = parseInt(m[1]!, 16);
      // First occurrence wins (label lines appear before instruction lines)
      if (!index.has(addr)) {
        index.set(addr, i + 1); // 1-based
      }
    }
  }
  return index;
}

function loadArtifactData(artifactId: string): ArtifactData {
  const cached = artifactCache.get(artifactId);
  if (cached) return cached;

  const dir = getProjectDir();

  // --- Analysis JSON ---
  const analysisPath = join(dir, `${artifactId}_analysis.json`);
  let analysis: AnalysisReport | null = null;
  if (existsSync(analysisPath)) {
    try {
      analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as AnalysisReport;
    } catch {
      analysis = null;
    }
  }

  // --- Annotations JSON ---
  const annPath = join(dir, `${artifactId}_annotations.json`);
  let annotations: AnnotationsFile | null = null;
  if (existsSync(annPath)) {
    try {
      annotations = JSON.parse(readFileSync(annPath, "utf8")) as AnnotationsFile;
    } catch {
      annotations = null;
    }
  }

  // --- Build sorted structures ---

  // Routines: sort by entry. Exit = next routine's entry - 1, or undefined.
  const routinesSorted: ArtifactData["routinesSorted"] = [];
  if (annotations?.routines) {
    for (const rt of annotations.routines) {
      routinesSorted.push({ entry: parseHex(rt.address), name: rt.name, description: rt.comment });
    }
    routinesSorted.sort((a, b) => a.entry - b.entry);
    for (let i = 0; i < routinesSorted.length; i++) {
      const next = routinesSorted[i + 1];
      if (next) {
        routinesSorted[i]!.exit = next.entry - 1;
      }
    }
  }

  // Labels: sort by address
  const labelsSorted: ArtifactData["labelsSorted"] = [];
  if (annotations?.labels) {
    for (const lbl of annotations.labels) {
      labelsSorted.push({ address: parseHex(lbl.address), name: lbl.label });
    }
    labelsSorted.sort((a, b) => a.address - b.address);
  }

  // Segments: sort by start
  const segmentsSorted: ArtifactData["segmentsSorted"] = [];
  if (analysis?.segments) {
    for (const seg of analysis.segments) {
      segmentsSorted.push({
        start: seg.start,
        end: seg.end,
        kind: seg.kind as SegmentKind,
        confidence: seg.score?.confidence ?? 0,
      });
    }
    segmentsSorted.sort((a, b) => a.start - b.start);
  }

  // Also fold segment annotations from annotations file
  if (annotations?.segments) {
    for (const seg of annotations.segments) {
      const start = parseHex(seg.start);
      const end = parseHex(seg.end);
      // Check if there's already a segment covering this range; if so skip
      const alreadyCovered = segmentsSorted.some((s) => s.start <= start && s.end >= end);
      if (!alreadyCovered) {
        segmentsSorted.push({ start, end, kind: seg.kind as SegmentKind, confidence: 0.9 });
      }
    }
    segmentsSorted.sort((a, b) => a.start - b.start);
  }

  // --- Disasm source line index ---
  const disasmPath = join(dir, `${artifactId}_disasm.asm`);
  let disasmLines: Map<number, number> | null = null;
  let disasmFile: string | null = null;
  if (existsSync(disasmPath)) {
    try {
      disasmLines = buildDisasmLineIndex(disasmPath);
      disasmFile = disasmPath;
    } catch {
      disasmLines = null;
    }
  }

  const data: ArtifactData = {
    annotations,
    analysis,
    routinesSorted,
    labelsSorted,
    segmentsSorted,
    disasmLines,
    disasmFile,
  };

  artifactCache.set(artifactId, data);
  return data;
}

// ---- Resolution logic ------------------------------------------------------

function resolveOne(artifactId: string, pc: number, data: ArtifactData): ResolvedPc {
  const result: ResolvedPc = { artifactId, pc };

  // Layer 1: Routine range match
  // Binary search for the largest entry ≤ pc
  const routines = data.routinesSorted;
  if (routines.length > 0) {
    let lo = 0;
    let hi = routines.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (routines[mid]!.entry <= pc) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      const rt = routines[best]!;
      // Check that pc is within range (exit is inclusive if set)
      if (rt.exit === undefined || pc <= rt.exit) {
        result.routine = {
          name: rt.name,
          description: rt.description,
          entry: rt.entry,
          exit: rt.exit,
        };
      }
    }
  }

  // Layer 2: Nearest label ≤ pc
  const labels = data.labelsSorted;
  if (labels.length > 0) {
    let lo = 0;
    let hi = labels.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (labels[mid]!.address <= pc) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0) {
      const lbl = labels[best]!;
      result.label = { name: lbl.name, isExact: lbl.address === pc };
    }
  }

  // Layer 3: Segment classification
  const segs = data.segmentsSorted;
  for (const seg of segs) {
    if (seg.start > pc) break;
    if (pc <= seg.end) {
      result.segment = { kind: seg.kind, confidence: seg.confidence };
      break;
    }
  }

  // Layer 4: Source line in _disasm.asm
  if (data.disasmLines && data.disasmFile) {
    const line = data.disasmLines.get(pc);
    if (line !== undefined) {
      result.source = { file: data.disasmFile, line };
    }
  }

  return result;
}

// ---- Public API ------------------------------------------------------------

/**
 * Resolve a single (artifactId, pc) to its disassembly context.
 * Results are cached per (artifactId, pc) for CACHE_TTL_MS.
 */
export function resolvePc(artifactId: string, pc: number): ResolvedPc {
  const now = Date.now();
  let pcMap = resolveCache.get(artifactId);
  if (pcMap) {
    const entry = pcMap.get(pc);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      return entry.result;
    }
  } else {
    pcMap = new Map();
    resolveCache.set(artifactId, pcMap);
  }

  const data = loadArtifactData(artifactId);
  const result = resolveOne(artifactId, pc, data);
  pcMap.set(pc, { result, ts: now });
  return result;
}

/**
 * Batch-resolve a list of PC values for the same artifact.
 * Loads artifact data once, then resolves each PC with cache check.
 */
export function resolvePcs(artifactId: string, pcs: number[]): ResolvedPc[] {
  const now = Date.now();
  let pcMap = resolveCache.get(artifactId);
  if (!pcMap) {
    pcMap = new Map();
    resolveCache.set(artifactId, pcMap);
  }

  // Load once for the batch
  const data = loadArtifactData(artifactId);

  return pcs.map((pc) => {
    const entry = pcMap!.get(pc);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      return entry.result;
    }
    const result = resolveOne(artifactId, pc, data);
    pcMap!.set(pc, { result, ts: now });
    return result;
  });
}

/**
 * Invalidate cached artifact data for the given artifact (e.g. after
 * annotations are re-saved). PC-level results are also dropped.
 */
export function invalidateArtifactCache(artifactId: string): void {
  artifactCache.delete(artifactId);
  resolveCache.delete(artifactId);
}

// ---- Enrich helper ---------------------------------------------------------

/**
 * Enriches an EventRow (cpu_step / mem_read / mem_write) with a `_resolved`
 * field. Other event types are returned as-is.
 *
 * Used by queryEvents enrich mode (Spec 235).
 */
export function enrichEventRow<T extends { family: string; pc?: number }>(
  row: T,
  artifactId: string,
): T & { _resolved?: ResolvedPc } {
  if (
    (row.family === "cpu_step" || row.family === "mem_read" || row.family === "mem_write") &&
    row.pc !== undefined
  ) {
    const resolved = resolvePc(artifactId, row.pc);
    return { ...row, _resolved: resolved };
  }
  return row;
}

/**
 * Batch-enrich a list of event rows with resolved PC information.
 * Deduplicates PC lookups across the batch via the cache.
 */
export function enrichEventRows<T extends { family: string; pc?: number }>(
  rows: T[],
  artifactId: string,
): Array<T & { _resolved?: ResolvedPc }> {
  // Collect unique PCs for cpu_step / mem_* rows to warm the cache in one pass
  const pcsToResolve: number[] = [];
  for (const row of rows) {
    if (
      (row.family === "cpu_step" || row.family === "mem_read" || row.family === "mem_write") &&
      row.pc !== undefined
    ) {
      pcsToResolve.push(row.pc);
    }
  }

  if (pcsToResolve.length > 0) {
    // Warm the cache (deduplicated internally by resolvePcs)
    const unique = [...new Set(pcsToResolve)];
    resolvePcs(artifactId, unique);
  }

  return rows.map((row) => enrichEventRow(row, artifactId));
}
