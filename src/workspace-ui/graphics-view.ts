import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { ArtifactRecord } from "../project-knowledge/types.js";

export type GraphicsKind =
  | "sprite"
  | "charset"
  | "charset_source"
  | "bitmap"
  | "hires_bitmap"
  | "multicolor_bitmap"
  | "bitmap_source"
  | "screen_ram"
  | "screen_source"
  | "color_source";

export interface GraphicsItem {
  id: string;
  label: string;
  kind: GraphicsKind;
  start: number;             // C64 memory address
  end: number;               // inclusive
  length: number;
  prgArtifactId: string;
  prgRelativePath: string;   // path relative to project root, used for /api/artifact/raw
  prgLoadAddress: number;
  fileOffset: number;        // byte offset inside the .prg file (after the 2-byte header)
  analysisArtifactId: string;
}

const GRAPHICS_KINDS: ReadonlySet<string> = new Set<GraphicsKind>([
  "sprite",
  "charset",
  "charset_source",
  "bitmap",
  "hires_bitmap",
  "multicolor_bitmap",
  "bitmap_source",
  "screen_ram",
  "screen_source",
  "color_source",
]);

interface AnalysisSegment {
  start: number;
  end: number;
  kind: string;
  label?: string;
  attributes?: Record<string, unknown>;
}

interface AnalysisReport {
  segments?: AnalysisSegment[];
  binaryName?: string;
  mapping?: { startAddress?: number; endAddress?: number };
}

function readPrgLoadAddress(prgPath: string): number | undefined {
  try {
    if (!existsSync(prgPath)) return undefined;
    const stat = statSync(prgPath);
    if (!stat.isFile() || stat.size < 2) return undefined;
    const buffer = readFileSync(prgPath);
    return buffer.readUInt16LE(0);
  } catch {
    return undefined;
  }
}

function readAnalysisReport(path: string): AnalysisReport | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as AnalysisReport;
  } catch {
    return undefined;
  }
}

function findSourcePrgArtifact(
  analysisArtifact: ArtifactRecord,
  artifactsById: Map<string, ArtifactRecord>,
): ArtifactRecord | undefined {
  // Walk sourceArtifactIds depth-first looking for a kind=prg artifact.
  const seen = new Set<string>();
  const stack = [...(analysisArtifact.sourceArtifactIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const candidate = artifactsById.get(id);
    if (!candidate) continue;
    if (candidate.kind === "prg") return candidate;
    for (const sourceId of candidate.sourceArtifactIds ?? []) {
      if (!seen.has(sourceId)) stack.push(sourceId);
    }
  }
  return undefined;
}

function findPrgArtifactByFilenameMatch(
  analysisArtifact: ArtifactRecord,
  artifacts: ArtifactRecord[],
): ArtifactRecord | undefined {
  // Fallback when sourceArtifactIds are missing: pair `<stem>_analysis.json`
  // with `<stem>.prg`. This is how the canonical workflow names files.
  const lower = analysisArtifact.relativePath.toLowerCase();
  if (!lower.endsWith("_analysis.json")) return undefined;
  const stem = lower.slice(0, -"_analysis.json".length);
  const want = `${stem}.prg`;
  return artifacts.find((artifact) =>
    artifact.kind === "prg" && artifact.relativePath.toLowerCase() === want,
  );
}

export function buildGraphicsView(
  projectRoot: string,
  service: ProjectKnowledgeService,
): { items: GraphicsItem[]; warnings: string[] } {
  const artifacts = service.listArtifacts();
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const analysisArtifacts = artifacts.filter((artifact) => artifact.role === "analysis-json");
  const items: GraphicsItem[] = [];
  const warnings: string[] = [];

  for (const analysisArtifact of analysisArtifacts) {
    const report = readAnalysisReport(analysisArtifact.path);
    if (!report || !Array.isArray(report.segments) || report.segments.length === 0) continue;

    const prgArtifact =
      findSourcePrgArtifact(analysisArtifact, artifactsById)
      ?? findPrgArtifactByFilenameMatch(analysisArtifact, artifacts);
    if (!prgArtifact) {
      warnings.push(`No PRG artifact found for analysis ${analysisArtifact.relativePath}.`);
      continue;
    }

    const loadAddress = readPrgLoadAddress(prgArtifact.path);
    if (loadAddress === undefined) {
      warnings.push(`Cannot read load address from ${prgArtifact.relativePath}.`);
      continue;
    }

    const prgRelativePath = prgArtifact.relativePath
      || relative(projectRoot, prgArtifact.path).replace(/\\/g, "/");

    for (const segment of report.segments) {
      if (!GRAPHICS_KINDS.has(segment.kind)) continue;
      const start = segment.start;
      const end = segment.end;
      if (typeof start !== "number" || typeof end !== "number" || end < start) continue;
      const length = end - start + 1;
      const fileOffset = (start - loadAddress) + 2; // +2 for PRG load-address header
      if (fileOffset < 0) continue;
      items.push({
        id: `gfx-${analysisArtifact.id}-${start.toString(16).padStart(4, "0")}-${end.toString(16).padStart(4, "0")}`,
        label: segment.label ?? `${segment.kind}_${start.toString(16).toUpperCase().padStart(4, "0")}`,
        kind: segment.kind as GraphicsKind,
        start,
        end,
        length,
        prgArtifactId: prgArtifact.id,
        prgRelativePath,
        prgLoadAddress: loadAddress,
        fileOffset,
        analysisArtifactId: analysisArtifact.id,
      });
    }
  }

  items.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.start - right.start;
  });

  return { items, warnings };
}
