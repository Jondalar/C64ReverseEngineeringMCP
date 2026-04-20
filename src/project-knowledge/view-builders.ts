import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createDiskParser, SECTORS_PER_TRACK, traceFileSectorChain, type DiskFileEntry } from "../disk/index.js";
import type {
  AnnotatedListingView,
  ArtifactRecord,
  CartridgeLayoutView,
  DiskLayoutView,
  EntityRecord,
  FindingRecord,
  FlowGraphMode,
  FlowGraphView,
  FlowRecord,
  LoadSequenceView,
  MemoryMapView,
  OpenQuestionRecord,
  ProjectCheckpoint,
  ProjectDashboardView,
  ProjectMetadata,
  RelationRecord,
  TaskRecord,
  TimelineEvent,
} from "./types.js";

interface ViewBuildContext {
  project: ProjectMetadata;
  artifacts: ArtifactRecord[];
  entities: EntityRecord[];
  findings: FindingRecord[];
  relations: RelationRecord[];
  flows: FlowRecord[];
  tasks: TaskRecord[];
  openQuestions: OpenQuestionRecord[];
  timeline: TimelineEvent[];
  checkpoints: ProjectCheckpoint[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function compareByUpdatedAt<T extends { updatedAt?: string; createdAt?: string; title?: string; name?: string; id: string }>(left: T, right: T): number {
  const leftValue = left.updatedAt ?? left.createdAt ?? "";
  const rightValue = right.updatedAt ?? right.createdAt ?? "";
  if (leftValue !== rightValue) {
    return rightValue.localeCompare(leftValue);
  }
  const leftLabel = left.title ?? left.name ?? left.id;
  const rightLabel = right.title ?? right.name ?? right.id;
  return leftLabel.localeCompare(rightLabel);
}

function compareByTitle<T extends { title?: string; name?: string; id: string }>(left: T, right: T): number {
  const leftLabel = left.title ?? left.name ?? left.id;
  const rightLabel = right.title ?? right.name ?? right.id;
  return leftLabel.localeCompare(rightLabel);
}

function readJsonIfExists(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function coerceAddress(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value)) {
    return parseInt(value, 16);
  }
  return undefined;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeSpaces(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function stageStemForArtifact(artifact: ArtifactRecord): string {
  const base = basename(artifact.relativePath, extname(artifact.relativePath));
  return stageStemFromValue(base);
}

function stageStemFromValue(base: string): string {
  return base
    .replace(/(_analysis|_disasm_annotations|_disasm|_final|_rebuilt|_pointer_facts|_ram_facts)$/i, "")
    .replace(/(-analysis|-disasm-annotations|-disasm|-final|-rebuilt|-pointer-facts|-ram-facts)$/i, "");
}

function deriveStageDescriptor(artifact: ArtifactRecord): { key: string; order: number; rawLabel: string; displayTitle: string; shortName: string } | undefined {
  const stem = stageStemForArtifact(artifact);
  const match = stem.match(/^(\d{2})[_-]([a-z0-9]+(?:[_-][a-z0-9]+)*)$/i);
  if (!match) {
    return undefined;
  }
  const order = Number(match[1]);
  const rawLabel = match[2].toLowerCase();
  const rivMatch = rawLabel.match(/^riv(\d+)$/i);
  let displayTitle: string;
  if (rawLabel === "ab") {
    displayTitle = "AB";
  } else if (rivMatch) {
    displayTitle = `River ${rivMatch[1]}`;
  } else if (rawLabel === "love") {
    displayTitle = "Love";
  } else {
    displayTitle = normalizeSpaces(rawLabel)
      .split(" ")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return {
    key: `${match[1]}-${rawLabel.replace(/_/g, "-")}`,
    order,
    rawLabel,
    displayTitle,
    shortName: `${match[1]} ${displayTitle}`,
  };
}

function inferLoadRole(args: {
  order: number;
  rawLabel: string;
  entities: EntityRecord[];
  findings: FindingRecord[];
}): { role: string; purposeSummary: string } {
  const label = args.rawLabel;
  const summaries = [
    ...args.entities.map((entity) => `${entity.name} ${entity.summary ?? ""}`.toLowerCase()),
    ...args.findings.map((finding) => `${finding.title} ${finding.summary ?? ""}`.toLowerCase()),
  ].join(" ");
  const hasVisualHints = /\b(bitmap|sprite|screen|charset|display)\b/.test(summaries);

  if (args.order === 1 || /\b(loader|boot|init|start)\b/.test(label)) {
    return {
      role: "bootstrap",
      purposeSummary: "Initial bootstrap payload that likely establishes runtime state and dispatches later content payloads.",
    };
  }
  if (/\b(title|intro|menu)\b/.test(label)) {
    return {
      role: "presentation-stage",
      purposeSummary: "Presentation-oriented payload, likely responsible for intro, title, or menu flow.",
    };
  }
  if (/^riv\d+$/i.test(label)) {
    return {
      role: "scene-stage",
      purposeSummary: "Likely one step in a chained river/scene sequence, loaded as a content payload for a specific game section.",
    };
  }
  if (/\blove|ending|credits\b/.test(label)) {
    return {
      role: "ending-stage",
      purposeSummary: "Late-game or ending-oriented payload, likely tied to a concluding scene or scripted transition.",
    };
  }
  if (hasVisualHints) {
    return {
      role: "visual-content",
      purposeSummary: "Content payload with strong visual-state hints such as bitmap, sprite, screen, or display setup.",
    };
  }
  return {
    role: "content-payload",
    purposeSummary: "Reusable runtime payload that appears to be loaded as one step in a broader staged content sequence.",
  };
}

function rangeKey(range: { start: number; end: number; bank?: number }): string {
  return `${range.bank ?? -1}:${range.start}:${range.end}`;
}

function readSemanticAnnotationSummary(path: string): { binary?: string; comments: string[] } | undefined {
  const raw = readJsonIfExists(path) as {
    binary?: string;
    segments?: Array<{ comment?: string }>;
    labels?: Array<{ comment?: string }>;
    routines?: Array<{ comment?: string }>;
  } | undefined;
  if (!raw) {
    return undefined;
  }
  const comments = [
    ...(raw.segments ?? []).map((segment) => segment.comment).filter((value): value is string => Boolean(value)),
    ...(raw.labels ?? []).map((label) => label.comment).filter((value): value is string => Boolean(value)),
    ...(raw.routines ?? []).map((routine) => routine.comment).filter((value): value is string => Boolean(value)),
  ];
  return { binary: raw.binary, comments };
}

function traceDirectorySectorChain(getSector: (track: number, sector: number) => Uint8Array | null): Array<{ track: number; sector: number }> {
  const sectors: Array<{ track: number; sector: number }> = [];
  let track = 18;
  let sector = 1;
  const visited = new Set<string>();
  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) {
      break;
    }
    visited.add(key);
    const data = getSector(track, sector);
    if (!data) {
      break;
    }
    sectors.push({ track, sector });
    track = data[0];
    sector = data[1];
  }
  return sectors;
}

function inferDiskFileLoader(args: {
  relativePath?: string;
  annotationCommentsByStage: Map<string, string[]>;
}): { loadType: "kernal" | "custom-loader" | "unknown"; loaderHint?: string; loaderSource?: string } {
  const stem = args.relativePath ? stageStemFromValue(basename(args.relativePath, extname(args.relativePath))) : undefined;
  if (!stem) {
    return { loadType: "unknown" };
  }
  const descriptor = deriveStageDescriptor({
    id: stem,
    kind: "other",
    scope: "analysis",
    title: stem,
    path: stem,
    relativePath: stem,
    status: "active",
    confidence: 1,
    createdAt: "",
    updatedAt: "",
    sourceArtifactIds: [],
    entityIds: [],
    evidence: [],
    tags: [],
  });
  const stageComments = args.annotationCommentsByStage.get(stem) ?? [];
  const stageText = stageComments.join(" ").toLowerCase();
  const bootstrapText = (args.annotationCommentsByStage.get("01_murder") ?? []).join(" ").toLowerCase();
  const stage2Text = (args.annotationCommentsByStage.get("02_ab") ?? []).join(" ").toLowerCase();

  if (descriptor?.key === "01-murder") {
    return {
      loadType: "unknown",
      loaderHint: "Original bootstrap entry; this stub then loads AB via KERNAL LOAD.",
      loaderSource: "disk entry / boot chain",
    };
  }

  if (descriptor?.key === "02-ab" && bootstrapText.includes("kernal load")) {
    return {
      loadType: "kernal",
      loaderHint: "Loaded by the tiny bootstrap via KERNAL LOAD.",
      loaderSource: "01_murder.prg",
    };
  }

  if ((descriptor?.order ?? 0) >= 3 && (stage2Text.includes("custom loader") || stage2Text.includes("cia2") || stage2Text.includes("drive-side"))) {
    return {
      loadType: "custom-loader",
      loaderHint: "Likely transferred by the second-stage custom drive loader.",
      loaderSource: "02_ab.prg",
    };
  }

  if (stageText.includes("kernal load")) {
    return {
      loadType: "kernal",
      loaderHint: stageComments[0],
      loaderSource: "self-described in annotations",
    };
  }
  if (stageText.includes("custom loader") || stageText.includes("cia2") || stageText.includes("drive-side")) {
    return {
      loadType: "custom-loader",
      loaderHint: stageComments[0],
      loaderSource: "self-described in annotations",
    };
  }
  return { loadType: "unknown" };
}

function kindCategory(kind: string): "free" | "code" | "data" | "system" | "other" {
  const normalized = kind.toLowerCase();
  if (normalized.includes("code") || normalized.includes("routine") || normalized.includes("entry")) {
    return "code";
  }
  if (normalized.includes("pointer") || normalized.includes("table") || normalized.includes("sprite") || normalized.includes("bitmap") || normalized.includes("charset") || normalized.includes("screen") || normalized.includes("asset")) {
    return "data";
  }
  if (normalized.includes("memory") || normalized.includes("state") || normalized.includes("io") || normalized.includes("irq") || normalized.includes("symbol")) {
    return "system";
  }
  return "other";
}

function mergedCoverageLength(intervals: Array<{ start: number; end: number }>): number {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }
    total += currentEnd - currentStart + 1;
    currentStart = interval.start;
    currentEnd = interval.end;
  }
  total += currentEnd - currentStart + 1;
  return total;
}

function formatByteCount(sizeBytes: number): string {
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} bytes`;
}

export function buildProjectDashboardView(context: ViewBuildContext): ProjectDashboardView {
  const openTasks = context.tasks.filter((task) => task.status !== "done" && task.status !== "wont_fix").sort(compareByUpdatedAt);
  const openQuestions = context.openQuestions.filter((question) => question.status !== "answered" && question.status !== "invalidated").sort(compareByUpdatedAt);
  const activeFindings = context.findings
    .filter((finding) => finding.status !== "archived" && finding.status !== "rejected")
    .sort(compareByUpdatedAt);
  const recentArtifacts = [...context.artifacts].sort(compareByUpdatedAt);
  const markdownArtifacts = context.artifacts
    .filter((artifact) => artifact.format === "markdown" || artifact.relativePath.toLowerCase().endsWith(".md"))
    .sort(compareByUpdatedAt);
  const payloadStages = new Set(
    context.artifacts
      .map((artifact) => deriveStageDescriptor(artifact)?.key)
      .filter((value): value is string => value !== undefined),
  );
  const diskArtifacts = context.artifacts.filter((artifact) => artifact.kind === "g64" || artifact.kind === "d64" || artifact.role === "disk-manifest");
  const latestCheckpoint = [...context.checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const recentTimeline = [...context.timeline].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 12);
  const overview = [
    {
      id: "overview-project-shape",
      title: "Project Shape",
      body: `${diskArtifacts.length > 0 ? "Disk-based" : "Binary-based"} reverse-engineering workspace with ${payloadStages.size} staged payloads, ${context.artifacts.length} tracked artifacts, and ${markdownArtifacts.length} readable documents.`,
    },
    {
      id: "overview-work-state",
      title: "Work State",
      body: `${activeFindings.length} active findings, ${openTasks.length} open tasks, and ${openQuestions.length} open questions. ${latestCheckpoint ? `Latest checkpoint: ${latestCheckpoint.title}.` : "No checkpoint captured yet."}`,
    },
    {
      id: "overview-current-focus",
      title: "Current Focus",
      body: openTasks[0]?.title
        ? `Primary next action: ${openTasks[0].title}.${openQuestions[0]?.title ? ` Open question: ${openQuestions[0].title}.` : ""}`
        : openQuestions[0]?.title
          ? `Primary ambiguity: ${openQuestions[0].title}.`
          : "No explicit next action captured yet; consult the latest docs and checkpoint summary.",
    },
  ];

  return {
    id: "view-project-dashboard",
    kind: "project-dashboard",
    title: `${context.project.name} Dashboard`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    project: context.project,
    counts: {
      artifacts: context.artifacts.length,
      entities: context.entities.length,
      findings: context.findings.length,
      relations: context.relations.length,
      flows: context.flows.length,
      tasks: context.tasks.length,
      openQuestions: context.openQuestions.length,
      checkpoints: context.checkpoints.length,
    },
    metrics: [
      {
        id: "metric-artifacts",
        title: "Artifacts",
        value: String(context.artifacts.length),
        emphasis: "info",
      },
      {
        id: "metric-findings",
        title: "Active Findings",
        value: String(activeFindings.length),
        emphasis: activeFindings.some((finding) => finding.kind === "hypothesis") ? "warn" : "neutral",
      },
      {
        id: "metric-open-tasks",
        title: "Open Tasks",
        value: String(openTasks.length),
        emphasis: openTasks.some((task) => task.priority === "critical") ? "critical" : "neutral",
      },
      {
        id: "metric-open-questions",
        title: "Open Questions",
        value: String(openQuestions.length),
        emphasis: openQuestions.length > 0 ? "warn" : "neutral",
      },
    ],
    overview,
    keyDocuments: markdownArtifacts.slice(0, 6).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      confidence: artifact.confidence,
      summary: artifact.relativePath,
      updatedAt: artifact.updatedAt,
    })),
    recentArtifacts: recentArtifacts.slice(0, 8).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      confidence: artifact.confidence,
      summary: artifact.relativePath,
      updatedAt: artifact.updatedAt,
    })),
    activeFindings: activeFindings.slice(0, 8).map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      title: finding.title,
      status: finding.status,
      confidence: finding.confidence,
      summary: finding.summary,
      updatedAt: finding.updatedAt,
    })),
    openTasks: openTasks.slice(0, 8).map((task) => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      status: task.status,
      confidence: task.confidence,
      summary: task.description,
      updatedAt: task.updatedAt,
    })),
    openQuestions: openQuestions.slice(0, 8).map((question) => ({
      id: question.id,
      kind: question.kind,
      title: question.title,
      status: question.status,
      confidence: question.confidence,
      summary: question.description,
      updatedAt: question.updatedAt,
    })),
    recentTimeline,
  };
}

export function buildMemoryMapView(context: ViewBuildContext): MemoryMapView {
  const findingIdsByEntityId = new Map<string, string[]>();
  for (const finding of context.findings) {
    for (const entityId of finding.entityIds) {
      const bucket = findingIdsByEntityId.get(entityId) ?? [];
      bucket.push(finding.id);
      findingIdsByEntityId.set(entityId, bucket);
    }
  }

  const regions = context.entities
    .filter((entity) => entity.addressRange)
    .sort((left, right) => {
      const leftRange = left.addressRange!;
      const rightRange = right.addressRange!;
      if (leftRange.start !== rightRange.start) {
        return leftRange.start - rightRange.start;
      }
      if (leftRange.end !== rightRange.end) {
        return leftRange.end - rightRange.end;
      }
      return left.name.localeCompare(right.name);
    })
    .map((entity) => ({
      id: entity.id,
      title: entity.name,
      kind: entity.kind,
      start: entity.addressRange!.start,
      end: entity.addressRange!.end,
      bank: entity.addressRange!.bank,
      entityId: entity.id,
      findingIds: [...(findingIdsByEntityId.get(entity.id) ?? [])].sort(),
      status: entity.status,
      confidence: entity.confidence,
      summary: entity.summary,
    }));

  const cellSize = 0x100;
  const rowStride = 0x1000;
  const cells = Array.from({ length: 0x100 }, (_, index) => {
    const rowBase = Math.floor(index / 16) * rowStride;
    const columnOffset = (index % 16) * cellSize;
    const start = rowBase + columnOffset;
    const end = Math.min(0xffff, start + cellSize - 1);
    const overlappingRegions = regions.filter((region) => region.start <= end && region.end >= start);
    const overlapIntervals = overlappingRegions.map((region) => ({
      start: Math.max(start, region.start),
      end: Math.min(end, region.end),
    }));
    const occupancy = mergedCoverageLength(overlapIntervals) / cellSize;
    const dominantRegion = [...overlappingRegions]
      .sort((left, right) => {
        const leftCoverage = Math.min(end, left.end) - Math.max(start, left.start) + 1;
        const rightCoverage = Math.min(end, right.end) - Math.max(start, right.start) + 1;
        return rightCoverage - leftCoverage || right.confidence - left.confidence || left.title.localeCompare(right.title);
      })[0];
    return {
      id: `memory-cell-${start.toString(16).padStart(4, "0")}`,
      start,
      end,
      rowBase,
      columnOffset,
      category: dominantRegion ? kindCategory(dominantRegion.kind) : "free",
      dominantKind: dominantRegion?.kind ?? "free",
      dominantTitle: dominantRegion?.title ?? "Free",
      occupancy,
      regionIds: overlappingRegions.map((region) => region.id),
      entityIds: overlappingRegions.flatMap((region) => (region.entityId ? [region.entityId] : [])),
      dominantEntityId: dominantRegion?.entityId,
      status: dominantRegion?.status ?? "unmapped",
      confidence: dominantRegion?.confidence ?? 1,
    };
  });

  const occupiedRanges = regions
    .map((region) => ({ start: region.start, end: region.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedOccupied: Array<{ start: number; end: number }> = [];
  for (const range of occupiedRanges) {
    const last = mergedOccupied[mergedOccupied.length - 1];
    if (!last || range.start > last.end + 1) {
      mergedOccupied.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }

  const freeRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of mergedOccupied) {
    if (cursor < range.start) {
      freeRanges.push({ start: cursor, end: range.start - 1 });
    }
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= 0xffff) {
    freeRanges.push({ start: cursor, end: 0xffff });
  }

  const largestFree = [...freeRanges].sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
  const largestCode = [...regions]
    .filter((region) => kindCategory(region.kind) === "code")
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
  const largestData = [...regions]
    .filter((region) => kindCategory(region.kind) !== "code")
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
  const largestMapped = [...regions]
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];

  const highlights = [
    largestFree ? {
      id: "memory-highlight-largest-free",
      title: "Largest Free Range",
      kind: "free-space" as const,
      start: largestFree.start,
      end: largestFree.end,
      sizeBytes: largestFree.end - largestFree.start + 1,
      summary: `${formatByteCount(largestFree.end - largestFree.start + 1)} currently unmapped.`,
    } : undefined,
    largestCode ? {
      id: "memory-highlight-largest-code",
      title: "Largest Code Block",
      kind: "code-block" as const,
      start: largestCode.start,
      end: largestCode.end,
      sizeBytes: largestCode.end - largestCode.start + 1,
      entityId: largestCode.entityId,
      summary: `${largestCode.title} (${largestCode.kind})`,
    } : undefined,
    largestData ? {
      id: "memory-highlight-largest-data",
      title: "Largest Non-Code Block",
      kind: "data-block" as const,
      start: largestData.start,
      end: largestData.end,
      sizeBytes: largestData.end - largestData.start + 1,
      entityId: largestData.entityId,
      summary: `${largestData.title} (${largestData.kind})`,
    } : undefined,
    largestMapped ? {
      id: "memory-highlight-largest-mapped",
      title: "Largest Mapped Block",
      kind: "mapped-block" as const,
      start: largestMapped.start,
      end: largestMapped.end,
      sizeBytes: largestMapped.end - largestMapped.start + 1,
      entityId: largestMapped.entityId,
      summary: `${largestMapped.title} (${largestMapped.kind})`,
    } : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);

  return {
    id: "view-memory-map",
    kind: "memory-map",
    title: `${context.project.name} Memory Map`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    cellSize,
    rowStride,
    cells,
    highlights,
    regions,
  };
}

export function buildDiskLayoutView(context: ViewBuildContext): DiskLayoutView {
  const diskFileEntities = context.entities.filter((entity) => entity.kind === "disk-file");
  const annotationCommentsByStage = new Map<string, string[]>();
  for (const artifact of context.artifacts.filter((item) => item.role === "semantic-annotations")) {
    const summary = readSemanticAnnotationSummary(artifact.path);
    if (!summary) {
      continue;
    }
    const binaryStem = summary.binary ? stageStemFromValue(basename(summary.binary, extname(summary.binary))) : stageStemForArtifact(artifact);
    annotationCommentsByStage.set(binaryStem, summary.comments);
  }

  const disks = context.artifacts
    .filter((artifact) => artifact.role === "disk-manifest")
    .sort(compareByTitle)
    .map((artifact) => {
      const manifest = readJsonIfExists(artifact.path) as {
        sourceImage?: string;
        format?: string;
        diskName?: string;
        diskId?: string;
        files?: Array<{
          index?: number;
          name?: string;
          type?: string;
          sizeSectors?: number;
          sizeBytes?: number;
          track?: number;
          sector?: number;
          loadAddress?: number;
          relativePath?: string;
          sectorChain?: Array<{
            index?: number;
            track?: number;
            sector?: number;
            nextTrack?: number;
            nextSector?: number;
            bytesUsed?: number;
            isLast?: boolean;
          }>;
        }>;
      } | undefined;
      const parser = manifest?.sourceImage && existsSync(manifest.sourceImage)
        ? createDiskParser(new Uint8Array(readFileSync(manifest.sourceImage)))
        : null;
      const directoryEntries = parser?.getDirectory().files ?? [];
      const directoryChain = parser ? traceDirectorySectorChain((track, sector) => parser.getSector(track, sector)) : [{ track: 18, sector: 1 }];
      const files = [...(manifest?.files ?? [])]
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((file, index) => {
          const entity = diskFileEntities.find((candidate) =>
            candidate.artifactIds.includes(artifact.id) &&
            (
              candidate.name === file.name ||
              candidate.name === file.relativePath ||
              (file.relativePath !== undefined && candidate.summary?.includes(file.relativePath)) ||
              (file.name !== undefined && candidate.summary?.includes(file.name))
            ),
          );
          const parserEntry = directoryEntries.find((entry) =>
            entry.track === file.track &&
            entry.sector === file.sector &&
            entry.name.toLowerCase() === (file.name ?? "").toLowerCase(),
          );
          const sectorChain = (file.sectorChain ?? [])
            .map((cell) => ({
              index: cell.index ?? 0,
              track: cell.track ?? 0,
              sector: cell.sector ?? 0,
              nextTrack: cell.nextTrack ?? 0,
              nextSector: cell.nextSector ?? 0,
              bytesUsed: cell.bytesUsed ?? 0,
              isLast: cell.isLast ?? false,
            }))
            .filter((cell) => cell.track > 0);
          const tracedSectorChain = sectorChain.length > 0
            ? sectorChain
            : parser && parserEntry
              ? traceFileSectorChain((track, sector) => parser.getSector(track, sector), parserEntry)
              : [];
          const loaderInfo = inferDiskFileLoader({
            relativePath: file.relativePath,
            annotationCommentsByStage,
          });
          return {
            id: `${artifact.id}-file-${index}`,
            title: file.name ?? `File ${index + 1}`,
            type: file.type ?? "unknown",
            sizeSectors: file.sizeSectors,
            sizeBytes: file.sizeBytes,
            track: file.track,
            sector: file.sector,
            loadAddress: file.loadAddress,
            relativePath: file.relativePath,
            entityId: entity?.id,
            sectorChain: tracedSectorChain,
            loadType: loaderInfo.loadType,
            loaderHint: loaderInfo.loaderHint,
            loaderSource: loaderInfo.loaderSource,
          };
        });
      const fileBySector = new Map<string, { id: string; title: string }>();
      for (const file of files) {
        for (const cell of file.sectorChain) {
          fileBySector.set(`${cell.track}:${cell.sector}`, { id: file.id, title: file.title });
        }
      }
      const trackCount = Math.max(
        35,
        ...files.flatMap((file) => file.sectorChain.map((cell) => cell.track)),
        ...files.map((file) => file.track ?? 0),
      );
      const sectors = Array.from({ length: trackCount }, (_, trackIndex) => trackIndex + 1)
        .flatMap((track) => {
          const sectorCount = SECTORS_PER_TRACK[track] ?? 17;
          return Array.from({ length: sectorCount }, (_, sector) => {
            const match = fileBySector.get(`${track}:${sector}`);
            const isBam = track === 18 && sector === 0;
            const isDirectory = directoryChain.some((item) => item.track === track && item.sector === sector);
            return {
              id: `${artifact.id}-track-${track}-sector-${sector}`,
              track,
              sector,
              angleStart: (sector / sectorCount) * Math.PI * 2,
              angleEnd: ((sector + 1) / sectorCount) * Math.PI * 2,
              fileId: match?.id,
              fileTitle: match?.title,
              occupied: Boolean(match) || isBam || isDirectory,
              category: match ? "file" as const : isBam ? "bam" as const : isDirectory ? "directory" as const : "free" as const,
            };
          });
        });
      return {
        artifactId: artifact.id,
        title: artifact.title,
        format: manifest?.format ?? artifact.format ?? "unknown",
        diskName: manifest?.diskName,
        diskId: manifest?.diskId,
        trackCount,
        fileCount: files.length,
        sectors,
        files,
      };
    });

  return {
    id: "view-disk-layout",
    kind: "disk-layout",
    title: `${context.project.name} Disk Layout`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    disks,
  };
}

export function buildCartridgeLayoutView(context: ViewBuildContext): CartridgeLayoutView {
  const cartridges = context.artifacts
    .filter((artifact) => artifact.role === "crt-manifest")
    .sort(compareByTitle)
    .map((artifact) => {
      const manifest = readJsonIfExists(artifact.path) as {
        header?: {
          name?: string;
          hardwareType?: number;
          exrom?: number;
          game?: number;
        };
        chips?: Array<{
          bank?: number;
          load_address?: number;
          size?: number;
          file?: string;
        }>;
        banks?: Record<string, { slots?: string[]; file?: string }>;
      } | undefined;
      if (!manifest?.header || !Array.isArray(manifest.chips) || !manifest.banks) {
        return undefined;
      }
      const chips = manifest.chips
        .map((chip) => ({
          bank: chip.bank ?? 0,
          loadAddress: chip.load_address ?? 0,
          size: chip.size ?? 0,
          file: chip.file,
        }))
        .sort((left, right) => left.bank - right.bank || left.loadAddress - right.loadAddress);
      const banks = Object.entries(manifest.banks)
        .map(([bank, entry]) => ({
          bank: Number(bank),
          file: entry.file,
          slots: [...(entry.slots ?? [])].sort(),
        }))
        .sort((left, right) => left.bank - right.bank);
      return {
        artifactId: artifact.id,
        title: artifact.title,
        cartridgeName: manifest.header.name,
        hardwareType: manifest.header.hardwareType,
        exrom: manifest.header.exrom,
        game: manifest.header.game,
        chips,
        banks,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== undefined);

  return {
    id: "view-cartridge-layout",
    kind: "cartridge-layout",
    title: `${context.project.name} Cartridge Layout`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    cartridges,
  };
}

export function buildLoadSequenceView(context: ViewBuildContext): LoadSequenceView {
  const groupedArtifacts = new Map<string, { descriptor: NonNullable<ReturnType<typeof deriveStageDescriptor>>; artifacts: ArtifactRecord[] }>();

  for (const artifact of context.artifacts) {
    const descriptor = deriveStageDescriptor(artifact);
    if (!descriptor) {
      continue;
    }
    const existing = groupedArtifacts.get(descriptor.key);
    if (existing) {
      existing.artifacts.push(artifact);
    } else {
      groupedArtifacts.set(descriptor.key, {
        descriptor,
        artifacts: [artifact],
      });
    }
  }

  if (groupedArtifacts.size === 0) {
    const genericArtifacts = context.artifacts
      .filter((artifact) => artifact.role === "analysis-json" || artifact.kind === "prg" || artifact.role === "rebuilt-prg")
      .sort(compareByTitle);
    genericArtifacts.forEach((artifact, index) => {
      const stem = normalizeSpaces(basename(artifact.relativePath, extname(artifact.relativePath)));
      groupedArtifacts.set(`generic-${index}-${artifact.id}`, {
        descriptor: {
          key: `generic-${index}-${artifact.id}`,
          order: index + 1,
          rawLabel: stem.toLowerCase().replace(/\s+/g, "-"),
          displayTitle: stem,
          shortName: `${String(index + 1).padStart(2, "0")} ${stem}`,
        },
        artifacts: [artifact],
      });
    });
  }

  const items = [...groupedArtifacts.values()]
    .sort((left, right) => left.descriptor.order - right.descriptor.order || left.descriptor.displayTitle.localeCompare(right.descriptor.displayTitle))
    .map(({ descriptor, artifacts }, index) => {
      const artifactIds = artifacts.map((artifact) => artifact.id);
      const linkedEntities = context.entities
        .filter((entity) => entity.artifactIds.some((artifactId) => artifactIds.includes(artifactId)))
        .sort(compareByTitle);
      const linkedFindings = context.findings
        .filter((finding) => finding.artifactIds.some((artifactId) => artifactIds.includes(artifactId)))
        .sort(compareByUpdatedAt);
      const entryAddresses = uniqueNumbers(linkedEntities
        .filter((entity) => entity.kind === "entry-point")
        .map((entity) => entity.addressRange?.start ?? coerceAddress(entity.name.replace(/^entry_/i, "")))
        .filter((value): value is number => value !== undefined));
      const preferredRangeKinds = ["entry-point", "code-segment", "memory-region", "loader-stage"];
      const rangeEntities = linkedEntities.filter((entity) => entity.addressRange);
      const prioritizedRangeEntities = rangeEntities.some((entity) => preferredRangeKinds.includes(entity.kind))
        ? rangeEntities.filter((entity) => preferredRangeKinds.includes(entity.kind))
        : rangeEntities;
      const payloadRangeEntities = prioritizedRangeEntities.some((entity) => entity.addressRange!.start >= 0x0400)
        ? prioritizedRangeEntities.filter((entity) => entity.addressRange!.start >= 0x0400)
        : prioritizedRangeEntities;
      const targetRanges = [...new Map(payloadRangeEntities
        .sort((left, right) => {
          const leftLength = left.addressRange!.end - left.addressRange!.start;
          const rightLength = right.addressRange!.end - right.addressRange!.start;
          return left.addressRange!.start - right.addressRange!.start || rightLength - leftLength;
        })
        .map((entity) => [rangeKey(entity.addressRange!), entity.addressRange!]))
        .values()]
        .slice(0, 6);
      const inferred = inferLoadRole({
        order: descriptor.order,
        rawLabel: descriptor.rawLabel,
        entities: linkedEntities,
        findings: linkedFindings,
      });
      const primaryEntity = linkedEntities.find((entity) => entity.kind === "entry-point")
        ?? linkedEntities.find((entity) => entity.kind === "code-segment")
        ?? linkedEntities[0];
      const confidence = Math.max(
        0.35,
        Math.min(
          0.98,
          average([
            average(artifacts.map((artifact) => artifact.confidence)),
            average(linkedEntities.map((entity) => entity.confidence)),
            average(linkedFindings.map((finding) => finding.confidence)),
          ].filter((value) => value > 0)),
        ),
      );

      return {
        id: `load-sequence-item-${descriptor.key}`,
        key: descriptor.key,
        order: index,
        title: descriptor.displayTitle,
        shortName: descriptor.shortName,
        role: inferred.role,
        purposeSummary: inferred.purposeSummary,
        status: artifacts.some((artifact) => artifact.status === "confirmed") ? "confirmed" : "active",
        confidence,
        primaryEntityId: primaryEntity?.id,
        entityIds: linkedEntities.map((entity) => entity.id),
        artifactIds,
        artifactLabels: artifacts.map((artifact) => artifact.title).sort().slice(0, 8),
        entryAddresses,
        targetRanges,
        sourceKinds: [...new Set(artifacts.map((artifact) => artifact.role ?? artifact.kind))].sort(),
        evidenceHints: [
          ...linkedFindings.slice(0, 3).map((finding) => finding.title),
          ...linkedEntities
            .filter((entity) => entity.summary)
            .slice(0, 2)
            .map((entity) => entity.summary as string),
        ].slice(0, 5),
      };
    });

  const edges = items.slice(0, -1).map((item, index) => {
    const next = items[index + 1];
    return {
      id: `load-sequence-edge-${item.key}-to-${next.key}`,
      kind: "loads-next",
      title: `${item.shortName} -> ${next.shortName}`,
      fromItemId: item.id,
      toItemId: next.id,
      summary: `Heuristic staged load order inferred from artifact naming, linked analysis artifacts, and imported entry-point knowledge.`,
      confidence: Math.max(0.4, Math.min(item.confidence, next.confidence)),
      evidenceHints: [
        `${item.shortName} precedes ${next.shortName} in the ordered stage set.`,
        ...item.evidenceHints.slice(0, 1),
        ...next.evidenceHints.slice(0, 1),
      ].slice(0, 3),
    };
  });

  return {
    id: "view-load-sequence",
    kind: "load-sequence",
    title: `${context.project.name} Load Sequence`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    items,
    edges,
  };
}

export function buildFlowGraphView(context: ViewBuildContext): FlowGraphView {
  const structureMode = buildStructureFlowMode(context);
  const loadMode = buildLoadFlowMode(context);
  const runtimeMode = buildRuntimeFlowMode(context);

  return {
    id: "view-flow-graph",
    kind: "flow-graph",
    title: `${context.project.name} Flow Graph`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    nodes: structureMode.nodes,
    edges: structureMode.edges,
    modes: {
      structure: structureMode,
      load: loadMode,
      runtime: runtimeMode,
    },
  };
}

function buildStructureFlowMode(context: ViewBuildContext): FlowGraphMode {
  const entityById = new Map(context.entities.map((entity) => [entity.id, entity]));
  const nodeMap = new Map<string, FlowGraphView["nodes"][number]>();
  const edgeMap = new Map<string, FlowGraphView["edges"][number]>();
  const relationEdgeIds = new Set<string>();

  for (const flow of context.flows) {
    const canonicalNodeIds = new Map<string, string>();
    for (const node of flow.nodes) {
      const canonicalId = node.entityId ? `entity-node-${node.entityId}` : node.id;
      canonicalNodeIds.set(node.id, canonicalId);
      nodeMap.set(canonicalId, {
        id: canonicalId,
        kind: node.kind,
        title: node.title,
        entityId: node.entityId,
        summary: node.addressRange ? `${node.addressRange.start.toString(16).toUpperCase()}-${node.addressRange.end.toString(16).toUpperCase()}` : undefined,
        status: node.status,
        confidence: node.confidence,
      });
    }
    for (const edge of flow.edges) {
      if (edge.relationId) {
        relationEdgeIds.add(edge.relationId);
      }
      edgeMap.set(edge.id, {
        id: edge.id,
        kind: edge.kind,
        title: edge.title,
        from: canonicalNodeIds.get(edge.fromNodeId) ?? edge.fromNodeId,
        to: canonicalNodeIds.get(edge.toNodeId) ?? edge.toNodeId,
        relationId: edge.relationId,
        summary: edge.summary,
        status: edge.status,
        confidence: edge.confidence,
      });
    }
  }

  for (const relation of context.relations) {
    const sourceEntity = entityById.get(relation.sourceEntityId);
    const targetEntity = entityById.get(relation.targetEntityId);
    if (!sourceEntity || !targetEntity) {
      continue;
    }
    const sourceNodeId = `entity-node-${sourceEntity.id}`;
    const targetNodeId = `entity-node-${targetEntity.id}`;
    if (!nodeMap.has(sourceNodeId)) {
      nodeMap.set(sourceNodeId, {
        id: sourceNodeId,
        kind: sourceEntity.kind,
        title: sourceEntity.name,
        entityId: sourceEntity.id,
        summary: sourceEntity.summary,
        status: sourceEntity.status,
        confidence: sourceEntity.confidence,
      });
    }
    if (!nodeMap.has(targetNodeId)) {
      nodeMap.set(targetNodeId, {
        id: targetNodeId,
        kind: targetEntity.kind,
        title: targetEntity.name,
        entityId: targetEntity.id,
        summary: targetEntity.summary,
        status: targetEntity.status,
        confidence: targetEntity.confidence,
      });
    }
    const edgeId = relation.id.startsWith("flow-edge-") ? relation.id : `relation-edge-${relation.id}`;
    if (!edgeMap.has(edgeId) && !relationEdgeIds.has(relation.id)) {
      edgeMap.set(edgeId, {
        id: edgeId,
        kind: relation.kind,
        title: relation.title,
        from: sourceNodeId,
        to: targetNodeId,
        relationId: relation.id,
        summary: relation.summary,
        status: relation.status,
        confidence: relation.confidence,
      });
    }
  }

  const nodes = [...nodeMap.values()].sort(compareByTitle);
  const edges = [...edgeMap.values()].sort(compareByTitle);

  return {
    id: "structure",
    title: "Structure",
    summary: "Entity- and relation-centric graph built from imported control-flow fragments plus stored project relations.",
    nodes,
    edges,
  };
}

function buildLoadFlowMode(context: ViewBuildContext): FlowGraphMode {
  const loadView = buildLoadSequenceView(context);
  return {
    id: "load",
    title: "Load",
    summary: "Payload order graph derived from staged artifacts, imported analysis hints, and linked target ranges.",
    nodes: loadView.items.map((item) => ({
      id: item.id,
      kind: `payload:${item.role}`,
      title: item.shortName,
      entityId: item.primaryEntityId,
      summary: item.purposeSummary ?? item.evidenceHints[0],
      status: item.status,
      confidence: item.confidence,
    })),
    edges: loadView.edges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      title: edge.title,
      from: edge.fromItemId,
      to: edge.toItemId,
      summary: edge.summary ?? edge.evidenceHints[0],
      status: "active",
      confidence: edge.confidence,
    })),
  };
}

function sessionIdFromRuntimeArtifact(artifact: ArtifactRecord): string | undefined {
  const match = artifact.relativePath.match(/analysis\/runtime\/([^/]+)\/trace\//i);
  return match?.[1];
}

function findEntityForAddress(entities: EntityRecord[], address: number): EntityRecord | undefined {
  return entities.find((entity) =>
    entity.addressRange !== undefined &&
    entity.addressRange.start <= address &&
    entity.addressRange.end >= address,
  );
}

function findLoadItemForAddress(loadView: LoadSequenceView, address: number) {
  return loadView.items.find((item) =>
    item.entryAddresses.includes(address) ||
    item.targetRanges.some((range) => range.start <= address && range.end >= address),
  );
}

interface RuntimePhaseDescriptor {
  key: string;
  title: string;
  summary: string;
  entityId?: string;
  confidence: number;
}

function describeRuntimePc(address: number, context: ViewBuildContext, loadView: LoadSequenceView): RuntimePhaseDescriptor {
  const loadItem = findLoadItemForAddress(loadView, address);
  const entity = findEntityForAddress(context.entities, address);

  if (address >= 0xe000) {
    return {
      key: "kernal-startup",
      title: "KERNAL / ROM startup",
      summary: `PC ${`$${address.toString(16).toUpperCase().padStart(4, "0")}`} is still in KERNAL ROM, suggesting bootstrapping or OS-mediated load work.`,
      confidence: 0.72,
    };
  }

  if (address < 0x0400) {
    return {
      key: "system-low-ram",
      title: "Low-memory system path",
      summary: `PC ${`$${address.toString(16).toUpperCase().padStart(4, "0")}`} falls in low memory, which often indicates trampolines, vectors, or setup code.`,
      confidence: 0.62,
    };
  }

  if (loadItem) {
    return {
      key: `stage-${loadItem.key}`,
      title: `${loadItem.shortName} runtime`,
      summary: loadItem.purposeSummary ?? `Runtime execution appears to be inside the ${loadItem.shortName} payload window.`,
      entityId: loadItem.primaryEntityId ?? entity?.id,
      confidence: Math.max(loadItem.confidence, entity?.confidence ?? 0.6),
    };
  }

  if (entity) {
    return {
      key: `entity-${entity.id}`,
      title: entity.name,
      summary: entity.summary ?? `Runtime execution appears to cluster in ${entity.name}.`,
      entityId: entity.id,
      confidence: Math.max(entity.confidence, 0.65),
    };
  }

  return {
    key: `pc-${address.toString(16)}`,
    title: `PC ${`$${address.toString(16).toUpperCase().padStart(4, "0")}`}`,
    summary: `No known payload or entity currently claims ${`$${address.toString(16).toUpperCase().padStart(4, "0")}`}.`,
    confidence: 0.45,
  };
}

function deriveRuntimePhases(args: {
  analysis?: {
    topPcs?: Array<{ pc?: number; count?: number }>;
    regionBuckets?: Record<string, number>;
    currentPc?: number;
  };
  summary?: {
    media?: { type?: string; autostart?: boolean };
  };
  context: ViewBuildContext;
  loadView: LoadSequenceView;
}) {
  const phases: Array<RuntimePhaseDescriptor & { sampleCount: number; anchorPc: number }> = [];
  const regionBuckets = args.analysis?.regionBuckets ?? {};

  if (args.summary?.media?.autostart || (regionBuckets.kernal ?? 0) > 0 || (regionBuckets.basic ?? 0) > 0) {
    phases.push({
      key: "boot-autostart",
      title: "Boot / autostart",
      summary: [
        args.summary?.media?.type ? `${args.summary.media.type.toUpperCase()} media autostarted` : undefined,
        (regionBuckets.kernal ?? 0) > 0 ? `${regionBuckets.kernal.toLocaleString("en-US")} KERNAL hits` : undefined,
        (regionBuckets.basic ?? 0) > 0 ? `${regionBuckets.basic.toLocaleString("en-US")} BASIC hits` : undefined,
      ].filter(Boolean).join(" · "),
      confidence: 0.72,
      sampleCount: (regionBuckets.kernal ?? 0) + (regionBuckets.basic ?? 0),
      anchorPc: args.analysis?.currentPc ?? 0xe000,
    });
  }

  const seenKeys = new Set<string>(phases.map((phase) => phase.key));
  for (const hotspot of (args.analysis?.topPcs ?? []).filter((entry) => entry.pc !== undefined && entry.count !== undefined)) {
    const descriptor = describeRuntimePc(hotspot.pc as number, args.context, args.loadView);
    if (seenKeys.has(descriptor.key)) {
      continue;
    }
    seenKeys.add(descriptor.key);
    phases.push({
      ...descriptor,
      summary: `${descriptor.summary} ${(hotspot.count as number).toLocaleString("en-US")} sampled hits.`,
      sampleCount: hotspot.count as number,
      anchorPc: hotspot.pc as number,
    });
    if (phases.length >= 6) {
      break;
    }
  }

  if (phases.length === 0 && typeof args.analysis?.currentPc === "number") {
    const descriptor = describeRuntimePc(args.analysis.currentPc, args.context, args.loadView);
    phases.push({
      ...descriptor,
      sampleCount: 1,
      anchorPc: args.analysis.currentPc,
    });
  }

  return phases;
}

function buildRuntimeFlowMode(context: ViewBuildContext): FlowGraphMode {
  const runtimeArtifacts = context.artifacts.filter((artifact) => (artifact.role ?? "").startsWith("runtime-trace-"));
  const loadView = buildLoadSequenceView(context);
  const grouped = new Map<string, ArtifactRecord[]>();
  for (const artifact of runtimeArtifacts) {
    const sessionId = sessionIdFromRuntimeArtifact(artifact);
    if (!sessionId) {
      continue;
    }
    grouped.set(sessionId, [...(grouped.get(sessionId) ?? []), artifact]);
  }

  const nodeMap = new Map<string, FlowGraphView["nodes"][number]>();
  const edgeMap = new Map<string, FlowGraphView["edges"][number]>();
  const sessions = [...grouped.entries()]
    .map(([sessionId, artifacts]) => ({ sessionId, artifacts }))
    .sort((left, right) => {
      const leftRichness = left.artifacts.filter((artifact) => artifact.role === "runtime-trace-analysis" || artifact.role === "runtime-trace-index").length;
      const rightRichness = right.artifacts.filter((artifact) => artifact.role === "runtime-trace-analysis" || artifact.role === "runtime-trace-index").length;
      if (leftRichness !== rightRichness) {
        return rightRichness - leftRichness;
      }
      const leftTime = left.artifacts.map((artifact) => artifact.updatedAt).sort().at(-1) ?? "";
      const rightTime = right.artifacts.map((artifact) => artifact.updatedAt).sort().at(-1) ?? "";
      return rightTime.localeCompare(leftTime);
    })
    .slice(0, 4);

  for (const session of sessions) {
    const summaryArtifact = session.artifacts.find((artifact) => artifact.role === "runtime-trace-summary");
    const analysisArtifact = session.artifacts.find((artifact) => artifact.role === "runtime-trace-analysis");
    const indexArtifact = session.artifacts.find((artifact) => artifact.role === "runtime-trace-index");
    const summary = summaryArtifact ? readJsonIfExists(summaryArtifact.path) as {
      createdAt?: string;
      durationMs?: number;
      stopReason?: string;
      media?: { type?: string; path?: string; autostart?: boolean };
      state?: string;
    } | undefined : undefined;
    const analysis = analysisArtifact ? readJsonIfExists(analysisArtifact.path) as {
      artifacts?: { runtimeTracePath?: string };
      cpuHistoryItems?: number;
      currentPc?: number;
      eventCounts?: Record<string, number>;
      regionBuckets?: Record<string, number>;
      topPcs?: Array<{ pc?: number; count?: number }>;
    } | undefined : undefined;
    const index = indexArtifact ? readJsonIfExists(indexArtifact.path) as {
      continuity?: { status?: string; sampleCount?: number; maxClockGap?: string };
    } | undefined : undefined;

    const sessionNodeId = `runtime-session-${session.sessionId}`;
    nodeMap.set(sessionNodeId, {
      id: sessionNodeId,
      kind: "runtime-session",
      title: session.sessionId,
      summary: [
        summary?.media?.type ? `${summary.media.type.toUpperCase()} autostart` : undefined,
        summary?.durationMs !== undefined ? `${summary.durationMs} ms` : undefined,
        summary?.stopReason,
      ].filter(Boolean).join(" · "),
      status: "active",
      confidence: 0.9,
    });

    const runtimePhases = deriveRuntimePhases({
      analysis,
      summary,
      context,
      loadView,
    });
    let previousPhaseNodeId: string | undefined;
    runtimePhases.forEach((phase, index) => {
      const phaseNodeId = `runtime-phase-${session.sessionId}-${index + 1}`;
      nodeMap.set(phaseNodeId, {
        id: phaseNodeId,
        kind: "runtime-phase",
        title: phase.title,
        entityId: phase.entityId,
        summary: `${phase.summary} Samples ${phase.firstSampleIndex}-${phase.lastSampleIndex}.`,
        status: "active",
        confidence: phase.confidence,
      });
      edgeMap.set(`runtime-edge-${session.sessionId}-phase-start-${index + 1}`, {
        id: `runtime-edge-${session.sessionId}-phase-start-${index + 1}`,
        kind: index === 0 ? "starts-in" : "enters-phase",
        title: index === 0 ? "starts in phase" : "enters next phase",
        from: index === 0 ? sessionNodeId : previousPhaseNodeId ?? sessionNodeId,
        to: phaseNodeId,
        summary: `${phase.sampleCount.toLocaleString("en-US")} sampled hits around ${`$${phase.anchorPc.toString(16).toUpperCase().padStart(4, "0")}`}.`,
        status: "active",
        confidence: phase.confidence,
      });
      previousPhaseNodeId = phaseNodeId;
    });

    if (index?.continuity) {
      const continuityNodeId = `runtime-continuity-${session.sessionId}`;
      nodeMap.set(continuityNodeId, {
        id: continuityNodeId,
        kind: "runtime-continuity",
        title: index.continuity.status ?? "continuity",
        summary: [
          index.continuity.sampleCount !== undefined ? `${index.continuity.sampleCount} samples` : undefined,
          index.continuity.maxClockGap ? `max gap ${index.continuity.maxClockGap}` : undefined,
        ].filter(Boolean).join(" · "),
        status: "active",
        confidence: 0.78,
      });
      edgeMap.set(`runtime-edge-${session.sessionId}-continuity`, {
        id: `runtime-edge-${session.sessionId}-continuity`,
        kind: "runtime-health",
        title: "trace continuity",
        from: sessionNodeId,
        to: continuityNodeId,
        summary: "Sampling continuity and trace health for this runtime session.",
        status: "active",
        confidence: 0.78,
      });
    }

    for (const [regionName, count] of Object.entries(analysis?.regionBuckets ?? {})
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)) {
      const regionNodeId = `runtime-region-${regionName}`;
      if (!nodeMap.has(regionNodeId)) {
        nodeMap.set(regionNodeId, {
          id: regionNodeId,
          kind: "runtime-region",
          title: regionName.replace(/_/g, " "),
          summary: "Coarse execution bucket derived from sampled PC regions.",
          status: "active",
          confidence: 0.72,
        });
      }
      edgeMap.set(`runtime-edge-${session.sessionId}-region-${regionName}`, {
        id: `runtime-edge-${session.sessionId}-region-${regionName}`,
        kind: "executes-in",
        title: `executes in ${regionName.replace(/_/g, " ")}`,
        from: sessionNodeId,
        to: regionNodeId,
        summary: `${count.toLocaleString("en-US")} sampled PCs landed in this bucket.`,
        status: "active",
        confidence: 0.72,
      });
    }

    for (const hotspot of (analysis?.topPcs ?? []).filter((entry) => entry.pc !== undefined && entry.count !== undefined).slice(0, 6)) {
      const entity = findEntityForAddress(context.entities, hotspot.pc as number);
      const hotspotNodeId = entity ? `entity-node-${entity.id}` : `runtime-pc-${(hotspot.pc as number).toString(16)}`;
      if (!nodeMap.has(hotspotNodeId)) {
        nodeMap.set(hotspotNodeId, {
          id: hotspotNodeId,
          kind: entity ? `runtime-hotspot:${entity.kind}` : "runtime-hotspot",
          title: entity?.name ?? `PC ${`$${(hotspot.pc as number).toString(16).toUpperCase().padStart(4, "0")}`}`,
          entityId: entity?.id,
          summary: entity?.summary ?? `Hot sampled PC at $${(hotspot.pc as number).toString(16).toUpperCase().padStart(4, "0")}.`,
          status: entity?.status ?? "active",
          confidence: entity ? Math.max(entity.confidence, 0.7) : 0.68,
        });
      }
      edgeMap.set(`runtime-edge-${session.sessionId}-hot-${(hotspot.pc as number).toString(16)}`, {
        id: `runtime-edge-${session.sessionId}-hot-${(hotspot.pc as number).toString(16)}`,
        kind: "hits-hotspot",
        title: entity ? `hot path touches ${entity.name}` : `hot PC ${`$${(hotspot.pc as number).toString(16).toUpperCase().padStart(4, "0")}`}`,
        from: sessionNodeId,
        to: hotspotNodeId,
        summary: `${(hotspot.count as number).toLocaleString("en-US")} sampled hits in this runtime session.`,
        status: "active",
        confidence: entity ? 0.82 : 0.7,
      });
    }
  }

  return {
    id: "runtime",
    title: "Runtime",
    summary: "Trace-backed runtime graph from sampled sessions, inferred phase transitions, continuity health, coarse region buckets, and hottest PCs.",
    nodes: [...nodeMap.values()].sort(compareByTitle),
    edges: [...edgeMap.values()].sort(compareByTitle),
  };
}

export function buildAnnotatedListingView(context: ViewBuildContext): AnnotatedListingView {
  const findingsByEntityId = new Map<string, FindingRecord[]>();
  for (const finding of context.findings) {
    for (const entityId of finding.entityIds) {
      const bucket = findingsByEntityId.get(entityId) ?? [];
      bucket.push(finding);
      findingsByEntityId.set(entityId, bucket);
    }
  }

  const entityByAddress = [...context.entities]
    .filter((entity) => entity.addressRange)
    .sort((left, right) => left.addressRange!.start - right.addressRange!.start);

  const entries = context.artifacts
    .filter((artifact) => artifact.role === "analysis-json")
    .flatMap((artifact) => {
      const report = readJsonIfExists(artifact.path) as {
        segments?: Array<{
          kind?: string;
          start?: number | string;
          end?: number | string;
          score?: { confidence?: number; reasons?: string[] };
        }>;
      } | undefined;
      return [...(report?.segments ?? [])]
        .map((segment) => ({
          ...segment,
          start: coerceAddress(segment.start),
          end: coerceAddress(segment.end),
        }))
        .filter((segment): segment is { kind?: string; start: number; end: number; score?: { confidence?: number; reasons?: string[] } } =>
          segment.start !== undefined && segment.end !== undefined,
        )
        .sort((left, right) => left.start - right.start)
        .map((segment) => {
          const entity = entityByAddress.find((candidate) =>
            candidate.addressRange !== undefined &&
            candidate.addressRange.start <= segment.start &&
            candidate.addressRange.end >= segment.end,
          );
          const linkedFindings = entity ? (findingsByEntityId.get(entity.id) ?? []).sort(compareByUpdatedAt) : [];
          const commentParts = [
            entity?.summary,
            segment.score?.reasons?.[0],
            linkedFindings[0]?.summary,
          ].filter(Boolean);
          return {
            id: `${artifact.id}-segment-${segment.start}`,
            start: segment.start,
            end: segment.end,
            title: entity?.name ?? `${segment.kind ?? "segment"}_${segment.start.toString(16).toUpperCase().padStart(4, "0")}`,
            kind: segment.kind ?? entity?.kind ?? "unknown",
            entityId: entity?.id,
            findingIds: linkedFindings.map((finding) => finding.id),
            comment: commentParts.join(" "),
            confidence: entity?.confidence ?? segment.score?.confidence ?? 0.5,
            status: entity?.status ?? "active",
          };
        });
    })
    .sort((left, right) => left.start - right.start || left.end - right.end || left.title.localeCompare(right.title));

  return {
    id: "view-annotated-listing",
    kind: "annotated-listing",
    title: `${context.project.name} Annotated Listing`,
    projectId: context.project.id,
    generatedAt: nowIso(),
    entries,
  };
}
