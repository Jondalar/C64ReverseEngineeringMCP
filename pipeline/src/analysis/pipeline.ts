import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BitmapAnalyzer } from "./analyzers/bitmap-analyzer";
import { CharsetAnalyzer } from "./analyzers/charset-analyzer";
import { CodeAnalyzer } from "./analyzers/code-analyzer";
import { PointerTableAnalyzer } from "./analyzers/pointer-table-analyzer";
import { ProbableCodeAnalyzer } from "./analyzers/probable-code-analyzer";
import { ScreenRamAnalyzer } from "./analyzers/screen-ram-analyzer";
import { SidAnalyzer } from "./analyzers/sid-analyzer";
import { SpriteAnalyzer } from "./analyzers/sprite-analyzer";
import { TextAnalyzer } from "./analyzers/text-analyzer";
import { deriveEntryPoints, loadPrg } from "./prg";
import { resolveSegments } from "./resolver";
import { extractCodeSemantics } from "./code-semantics";
import { extractSidEvidence, extractVicEvidence } from "./c64-hardware";
import { extractDisplaySemantics } from "./display-analysis";
import { deriveDisplaySourceCandidates } from "./display-source-candidates";
import { deriveHardwareDataCandidates } from "./hardware-data-candidates";
import { buildEvidenceGraph } from "./evidence-graph";
import { extractRamStateFacts } from "./ram-state";
import {
  AnalysisOptions,
  AnalysisReport,
  AnalyzerContext,
  AnalyzerResult,
  CandidateRegion,
  CodeSemantics,
  Segment,
  SegmentAnalyzer,
} from "./types";
import { calculateStats, mergeSegments } from "./utils";

function createDefaultAnalyzers(): SegmentAnalyzer[] {
  return [
    new CodeAnalyzer(),
    new ProbableCodeAnalyzer(),
    new TextAnalyzer(),
    new SpriteAnalyzer(),
    new CharsetAnalyzer(),
    new ScreenRamAnalyzer(),
    new BitmapAnalyzer(),
    new PointerTableAnalyzer(),
    new SidAnalyzer(),
  ];
}

const TEXT_KINDS = new Set<Segment["kind"]>(["petscii_text", "screen_code_text"]);

function isPrintableBridgeByte(kind: Segment["kind"], value: number): boolean {
  if (kind === "petscii_text") {
    return value === 0x0d || (value >= 0x20 && value <= 0x7e) || (value >= 0xa0 && value <= 0xdf);
  }
  if (kind === "screen_code_text") {
    return value === 0x20 || (value >= 0x01 && value <= 0x1a) || (value >= 0x30 && value <= 0x39);
  }
  return false;
}

function smoothTextSegments(segments: Segment[], buffer: Buffer, mapping: AnalyzerContext["mapping"]): Segment[] {
  const smoothed: Segment[] = [];
  let index = 0;

  while (index < segments.length) {
    const current = segments[index];
    const bridge = segments[index + 1];
    const next = segments[index + 2];

    if (
      current &&
      bridge &&
      next &&
      TEXT_KINDS.has(current.kind) &&
      current.kind === next.kind &&
      bridge.length <= 2 &&
      !TEXT_KINDS.has(bridge.kind)
    ) {
      const bridgeOffset = bridge.start - mapping.startAddress;
      const bridgeBytes = Array.from(buffer.subarray(bridgeOffset, bridgeOffset + bridge.length));
      const bridgeLooksTextual = bridgeBytes.every((value) => isPrintableBridgeByte(current.kind, value));

      if (bridgeLooksTextual) {
        smoothed.push({
          kind: current.kind,
          start: current.start,
          end: next.end,
          length: next.end - current.start + 1,
          score: {
            confidence: Math.max(current.score.confidence, next.score.confidence),
            reasons: [
              ...current.score.reasons,
              `Merged ${bridge.length}-byte printable bridge at $${bridge.start.toString(16).toUpperCase().padStart(4, "0")} into adjacent text blocks.`,
            ],
            alternatives: current.score.alternatives,
          },
          analyzerIds: Array.from(new Set([...current.analyzerIds, ...bridge.analyzerIds, ...next.analyzerIds])).sort(),
          xrefs: [...current.xrefs, ...bridge.xrefs, ...next.xrefs],
          preview: current.preview ?? next.preview,
          attributes: {
            ...(current.attributes ?? {}),
            smoothedTextBridge: bridgeBytes,
          },
        });
        index += 3;
        continue;
      }
    }

    smoothed.push(current);
    index += 1;
  }

  return smoothed;
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && startB <= endA;
}

function suppressSpriteCandidatesThatLookLikeState(
  analyzerResults: AnalyzerResult[],
  semantics: Pick<CodeSemantics, "ramAccesses" | "displayTransfers">,
): AnalyzerResult[] {
  const protectedRanges = semantics.displayTransfers
    .filter((transfer) => transfer.role === "bitmap" || transfer.role === "screen" || transfer.role === "color" || transfer.role === "charset")
    .map((transfer) => ({
      start: transfer.sourceAddress,
      end: transfer.sourceAddress,
    }));

  return analyzerResults.map((result) => {
    if (result.analyzerId !== "sprite") {
      return result;
    }

    return {
      ...result,
      candidates: result.candidates.filter((candidate) => {
        if (candidate.kind !== "sprite") {
          return true;
        }

        const overlapsProtectedRange = protectedRanges.some((range) =>
          overlaps(candidate.start, candidate.end, range.start, range.end),
        );
        if (overlapsProtectedRange) {
          return true;
        }

        const directTouches = semantics.ramAccesses.filter((access) => {
          if (access.address < candidate.start || access.address > candidate.end) {
            return false;
          }
          return access.directReads.length > 0 || access.directWrites.length > 0 || access.readModifyWrites.length > 0;
        });

        const indexedTouches = semantics.ramAccesses.filter((access) => {
          if (access.address < candidate.start || access.address > candidate.end) {
            return false;
          }
          return access.indexedReads.length > 0 || access.indexedWrites.length > 0;
        });

        const spriteCount = Number(candidate.attributes?.spriteCount ?? 0);
        const smallRun = spriteCount > 0 && spriteCount <= 8;
        const looksLikeStatePage = directTouches.length > 0 && smallRun;
        const looksLikeTablePage = directTouches.length > 0 && indexedTouches.length > 0;

        return !(looksLikeStatePage || looksLikeTablePage);
      }),
    };
  });
}

function demoteStatefulSpriteSegments(
  segments: Segment[],
  semantics: Pick<CodeSemantics, "ramAccesses" | "displayTransfers">,
): Segment[] {
  const protectedRanges = semantics.displayTransfers
    .filter((transfer) => transfer.role === "bitmap" || transfer.role === "screen" || transfer.role === "color" || transfer.role === "charset")
    .map((transfer) => ({
      start: transfer.sourceAddress,
      end: transfer.sourceAddress,
    }));

  const rewritten = segments.map((segment) => {
    if (segment.kind !== "sprite") {
      return segment;
    }

    const overlapsProtectedRange = protectedRanges.some((range) => overlaps(segment.start, segment.end, range.start, range.end));
    if (overlapsProtectedRange) {
      return segment;
    }

    const directTouches = semantics.ramAccesses.filter((access) => {
      if (access.address < segment.start || access.address > segment.end) {
        return false;
      }
      return access.directReads.length > 0 || access.directWrites.length > 0 || access.readModifyWrites.length > 0;
    });

    const indexedTouches = semantics.ramAccesses.filter((access) => {
      if (access.address < segment.start || access.address > segment.end) {
        return false;
      }
      return access.indexedReads.length > 0 || access.indexedWrites.length > 0;
    });

    const spriteCount = Number(segment.attributes?.spriteCount ?? 0);
    const smallRun = spriteCount > 0 && spriteCount <= 8;
    const shouldDemote = smallRun && directTouches.length > 0 && indexedTouches.length > 0;

    if (!shouldDemote) {
      return segment;
    }

    return {
      ...segment,
      kind: "unknown" as const,
      score: {
        confidence: 0.2,
        reasons: [
          `Sprite-like 64-byte cadence at $${segment.start.toString(16).toUpperCase().padStart(4, "0")}-$${segment.end.toString(16).toUpperCase().padStart(4, "0")} was demoted because decoded code directly reads/writes addresses inside the same range.`,
          "This looks more like mixed RAM state/table data than a pure sprite asset block.",
        ],
        alternatives: [
          {
            kind: "sprite" as const,
            confidence: segment.score.confidence,
            reasons: segment.score.reasons,
          },
        ],
      },
      analyzerIds: Array.from(new Set([...segment.analyzerIds, "resolver"])).sort(),
      preview: undefined,
    };
  });

  return mergeSegments(rewritten);
}

export function analyzeMappedBuffer(
  binaryName: string,
  buffer: Buffer,
  mapping: AnalyzerContext["mapping"],
  options: AnalysisOptions = {},
): AnalysisReport {
  const entryPoints = deriveEntryPoints(mapping, buffer, options.userEntryPoints);
  const context: AnalyzerContext = {
    binaryName,
    buffer,
    mapping,
    entryPoints,
    candidateRegions: [
      {
        start: mapping.startAddress,
        end: mapping.endAddress,
        source: "whole_image",
      },
    ],
    symbols: [],
  };

  const analyzerResults: AnalyzerResult[] = [];

  for (const analyzer of createDefaultAnalyzers()) {
    const result = analyzer.analyze(context);
    analyzerResults.push(result);
  }

  const vicEvidence = extractVicEvidence(context);
  const sidEvidence = extractSidEvidence(context);
  const baseCodeSemantics = extractCodeSemantics(context);
  const initialSegments = smoothTextSegments(resolveSegments(mapping.startAddress, mapping.endAddress, analyzerResults), buffer, mapping);
  const displaySemantics = extractDisplaySemantics(context, baseCodeSemantics, vicEvidence, initialSegments);
  const semanticsWithDisplay = {
    ...baseCodeSemantics,
    ...displaySemantics,
  };
  const initialRamStateFacts = extractRamStateFacts(context, semanticsWithDisplay, initialSegments);
  const analyzerResultsWithSpriteSuppression = suppressSpriteCandidatesThatLookLikeState(analyzerResults, {
    ...semanticsWithDisplay,
    ...initialRamStateFacts,
  });
  const displaySourceResult = deriveDisplaySourceCandidates(context, semanticsWithDisplay, vicEvidence, initialSegments);
  if (displaySourceResult.candidates.length > 0) {
    analyzerResultsWithSpriteSuppression.push(displaySourceResult);
  }
  const hardwareDataResult = deriveHardwareDataCandidates(context, semanticsWithDisplay, initialSegments);
  if (hardwareDataResult.candidates.length > 0) {
    analyzerResultsWithSpriteSuppression.push(hardwareDataResult);
  }
  const resolvedSegments = smoothTextSegments(
    resolveSegments(mapping.startAddress, mapping.endAddress, analyzerResultsWithSpriteSuppression),
    buffer,
    mapping,
  );
  const initialFinalRamStateFacts = extractRamStateFacts(context, semanticsWithDisplay, resolvedSegments);
  const segments = demoteStatefulSpriteSegments(resolvedSegments, {
    ...semanticsWithDisplay,
    ...initialFinalRamStateFacts,
  });
  const ramStateFacts = extractRamStateFacts(context, semanticsWithDisplay, segments);
  const codeSemantics = {
    ...semanticsWithDisplay,
    ...ramStateFacts,
  };
  const evidenceGraph = buildEvidenceGraph(codeSemantics, vicEvidence, segments);
  const stats = calculateStats(mapping, segments);

  return {
    binaryName,
    mapping,
    entryPoints,
    symbols: context.symbols,
    hardwareEvidence: {
      vicWrites: vicEvidence.observedWrites,
      sidWrites: sidEvidence.observedWrites,
    },
    codeSemantics,
    evidenceGraph,
    analyzerResults: analyzerResultsWithSpriteSuppression,
    segments,
    codeAnalysis: context.discoveredCode,
    probableCodeAnalysis: context.probableCode,
    stats,
  };
}

export function analyzePrgFile(prgPath: string, options: AnalysisOptions = {}): AnalysisReport {
  const loaded = loadPrg(resolve(prgPath));
  return analyzeMappedBuffer(prgPath, loaded.buffer, loaded.mapping, options);
}

export function writeAnalysisReport(report: AnalysisReport, outputPath: string): void {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
